/* store.js — shared client-side working store (IndexedDB), same-origin.

   Lets app.html and bom.html hand the current project back and forth without a
   server: the loaded project is mirrored into IndexedDB (images written once,
   the small project.json re-saved on change). Both pages read it on start.

   Fully static — works from a normal http(s) origin incl. GitHub Pages. (On
   file:// IndexedDB may be disabled by the browser; callers degrade gracefully.)

   Record model:
     meta store   key 'current'    -> the whole project.json object (incl. bom)
     images store key <filename>   -> original image Blob

   API (all async, all safe to call when unavailable — they no-op / return null):
     ProjectStore.available            boolean
     ProjectStore.saveMeta(project)    cheap, frequent (json only)
     ProjectStore.save(project, blobs) full sync (json + add/prune images)
     ProjectStore.load()               -> { project, images:Map<name,Blob> } | null
     ProjectStore.clear()                                                          */
(function (global) {
  'use strict';

  const DB = 'pcbspy_ws', VER = 1, META = 'meta', IMG = 'images', KEY = 'current';
  const strip = (k) => k.replace(/^images\//, '');

  let _db = null;
  function open() {
    return new Promise((res, rej) => {
      let r;
      try { r = indexedDB.open(DB, VER); } catch (e) { return rej(e); }
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
        if (!db.objectStoreNames.contains(IMG)) db.createObjectStore(IMG);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function db() { if (!_db) _db = await open(); return _db; }
  function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  function done(t) { return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }

  const ProjectStore = {
    available: (typeof indexedDB !== 'undefined' && indexedDB !== null),

    async saveMeta(project) {
      if (!this.available) return;
      try {
        const d = await db();
        const t = d.transaction(META, 'readwrite');
        t.objectStore(META).put(project, KEY);
        await done(t);
      } catch (e) { console.warn('ProjectStore.saveMeta failed:', e); }
    },

    async save(project, blobs) {
      if (!this.available) return;
      try {
        await this.saveMeta(project);
        const d = await db();
        const t = d.transaction(IMG, 'readwrite');
        const s = t.objectStore(IMG);
        const existing = await req(s.getAllKeys());
        const want = new Set();
        for (const [k, v] of blobs.entries()) { const name = strip(k); want.add(name); s.put(v, name); }
        for (const k of existing) { if (!want.has(k)) s.delete(k); }
        await done(t);
      } catch (e) { console.warn('ProjectStore.save failed:', e); }
    },

    async load() {
      if (!this.available) return null;
      try {
        const d = await db();
        const project = await req(d.transaction(META, 'readonly').objectStore(META).get(KEY));
        if (!project) return null;
        const is = d.transaction(IMG, 'readonly').objectStore(IMG);
        const keys = await req(is.getAllKeys());
        const vals = await req(is.getAll());
        const images = new Map();
        keys.forEach((k, i) => images.set(k, vals[i]));
        return { project, images };
      } catch (e) { console.warn('ProjectStore.load failed:', e); return null; }
    },

    async clear() {
      if (!this.available) return;
      try {
        const d = await db();
        const t = d.transaction([META, IMG], 'readwrite');
        t.objectStore(META).clear();
        t.objectStore(IMG).clear();
        await done(t);
      } catch (e) { console.warn('ProjectStore.clear failed:', e); }
    },
  };

  global.ProjectStore = ProjectStore;
})(window);
