#!/usr/bin/env python3
"""Regenerate js/footprints-data.js from /footprints so the footprint picker
works when the page is opened directly from disk (file://), where fetch() of
local files is blocked.

Run from the project root after adding/removing footprints:
    python tools/gen_footprints_data.py

Over http(s) the picker fetches /footprints live and this embedded copy is only
a fallback, so you only need to rerun this if you care about file:// use.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, "footprints")


def main():
    with open(os.path.join(BASE, "index.json"), encoding="utf-8") as f:
        index = json.load(f)
    files = {}
    for it in index:
        with open(os.path.join(BASE, it["file"]), encoding="utf-8") as f:
            files[it["file"]] = f.read()
    payload = {"index": index, "files": files}
    out_path = os.path.join(ROOT, "js", "footprints-data.js")
    with open(out_path, "w", encoding="utf-8", newline="\n") as out:
        out.write("/* Auto-generated from /footprints so the picker works offline (file://).\n")
        out.write("   Regenerate after adding footprints: python tools/gen_footprints_data.py */\n")
        out.write("window.FOOTPRINT_DATA = " + json.dumps(payload) + ";\n")
    print("wrote", out_path, os.path.getsize(out_path), "bytes,", len(files), "files")


if __name__ == "__main__":
    main()
