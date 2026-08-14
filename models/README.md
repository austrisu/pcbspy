# Component-detection model

The Auto-detect page ([detect.html](../detect.html)) loads a YOLO **component
detector** exported to ONNX. Put the file here as:

```
models/pcb_components.onnx
```

(or use the page's **Load .onnx file…** button to pick one from disk).

## The model MUST be a PCB *component* detector

It has to be trained to find components (resistors, caps, ICs, connectors…) as
bounding boxes. Do **not** use:

- Board-outline models (e.g. `SanderGi/PCB-Detection`) — they detect the whole board.
- COCO-pretrained YOLO (`yolov8n`, `yolo11n`) — they detect people/cars, no PCB parts.

The class labels are ignored (localization only), but the detector still only
finds component *classes present in its training set* — unusual parts get missed.

## Export

Static 640×640 input, opset 12 (matches the page's default `inputSize: 640`):

```bash
yolo export model=pcb_components.pt format=onnx imgsz=640 opset=12
```

Then rename/copy the resulting `.onnx` to `models/pcb_components.onnx`.

## Notes

- ~10–25 MB. Fine to commit to the repo (< GitHub's 100 MB/file limit); it counts
  toward repo size. If you'd rather not track it, add `models/*.onnx` to
  `.gitignore` and load it with **Load .onnx file…** or host it elsewhere.
- ONNX Runtime Web + its WASM come from a CDN (jsdelivr) on first load, then cache.
  Inference itself is fully local — no image ever leaves the browser.
