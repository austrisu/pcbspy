/* persistence.js — save/load the whole project as a single .zip.

   Zip layout:
     project.json     — camera, per-layer matrices/opacity/visibility/z-order,
                        annotations (shapes + markers). Layers reference images
                        by filename.
     images/<file>    — original uploaded bytes, stored verbatim (no re-encode).

   Uses the File System Access API (showSaveFilePicker / showOpenFilePicker) when
   available, and falls back to a download link + hidden file input otherwise. */
(function (global) {
  'use strict';

  const hasFSAccess = typeof global.showSaveFilePicker === 'function';

  const Persistence = {
    supportsFSAccess: hasFSAccess,

    /* projectData: {
         version, camera, layers:[{id,name,filename,opacity,visible,matrix}],
         annotations
       }
       blobs: Map<filename, Blob>  (original image bytes) */
    async buildZip(projectData, blobs) {
      if (!global.JSZip) throw new Error('JSZip failed to load.');
      const zip = new JSZip();
      zip.file('project.json', JSON.stringify(projectData, null, 2), { compression: 'DEFLATE' });
      const imgFolder = zip.folder('images');
      for (const [filename, blob] of blobs.entries()) {
        // Originals are already compressed (PNG/JPEG/…). Store verbatim (no re-DEFLATE)
        // so the archived bytes equal the source bytes exactly.
        imgFolder.file(filename, blob, { compression: 'STORE' });
      }
      return zip.generateAsync({ type: 'blob' });
    },

    async save(projectData, blobs, suggestedName) {
      const zipBlob = await this.buildZip(projectData, blobs);
      const name = suggestedName || 'project.zip';
      if (hasFSAccess) {
        try {
          const handle = await global.showSaveFilePicker({
            suggestedName: name,
            types: [{ description: 'Annotation project', accept: { 'application/zip': ['.zip'] } }],
          });
          const w = await handle.createWritable();
          await w.write(zipBlob);
          await w.close();
          return { ok: true, method: 'fsaccess', name: handle.name };
        } catch (e) {
          if (e && e.name === 'AbortError') return { ok: false, aborted: true };
          // fall through to download on other failures
        }
      }
      downloadBlob(zipBlob, name);
      return { ok: true, method: 'download', name };
    },

    // Returns a File/Blob of the chosen .zip (or null if cancelled).
    async pickZip() {
      if (hasFSAccess) {
        try {
          const [handle] = await global.showOpenFilePicker({
            types: [{ description: 'Annotation project', accept: { 'application/zip': ['.zip'] } }],
            multiple: false,
          });
          return handle.getFile();
        } catch (e) {
          if (e && e.name === 'AbortError') return null;
          // fall through
        }
      }
      return pickViaInput('.zip');
    },

    /* Parse a project zip. Returns { project, images: Map<filename, Blob> }. */
    async loadZip(fileOrBlob) {
      if (!global.JSZip) throw new Error('JSZip failed to load.');
      const zip = await JSZip.loadAsync(fileOrBlob);
      const projEntry = zip.file('project.json');
      if (!projEntry) throw new Error('project.json not found in zip.');
      const project = JSON.parse(await projEntry.async('string'));

      const images = new Map();
      const imgFolder = zip.folder('images');
      const tasks = [];
      imgFolder.forEach((relPath, entry) => {
        if (entry.dir) return;
        tasks.push(entry.async('blob').then(b => images.set(relPath, b)));
      });
      await Promise.all(tasks);
      return { project, images };
    },
  };

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function pickViaInput(accept) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.onchange = () => resolve(input.files[0] || null);
      input.click();
    });
  }

  global.Persistence = Persistence;
})(window);
