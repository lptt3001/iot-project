"""Detect/count insects in a file or folder; write boxes, annotated images and CSV."""
from __future__ import annotations

import argparse
from collections import Counter
import csv
import hashlib
import json
import os
from pathlib import Path

from PIL import Image, ImageDraw
from trap_detector import NAMES, predict


def main(args):
    os.environ["YOLO_AUTOINSTALL"] = "false"
    import torch
    from ultralytics import YOLO, settings
    settings.update({"sync": False})
    torch.set_num_threads(4)
    configuration = json.loads(args.config.read_text(encoding="utf-8")) if args.config else {}
    model_sha256 = hashlib.sha256(args.model.read_bytes()).hexdigest()
    expected = configuration.get("onnx_sha256" if args.model.suffix.lower() == ".onnx" else "model_sha256")
    if expected and model_sha256 != expected:
        raise ValueError("The model file does not match the supplied inference configuration.")
    model = YOLO(str(args.model))
    if [model.names[i] for i in range(len(NAMES))] != list(NAMES):
        raise ValueError("Model class order does not match the six-class trap detector.")
    thresholds = [configuration.get("thresholds", {}).get(name, .7) for name in NAMES]
    if any(not isinstance(value, (int, float)) or not 0 < value < 1 for value in thresholds):
        raise ValueError("Invalid confidence thresholds.")
    files = [args.input] if args.input.is_file() else sorted(p for p in args.input.iterdir()
                                                           if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
    if not files:
        raise ValueError("No input images found.")
    if args.output.resolve() == args.input.resolve() or any(args.output.resolve() == p.parent.resolve() for p in files):
        raise ValueError("Use a separate output folder to preserve the original photos.")
    args.output.mkdir(parents=True, exist_ok=True)
    device = 0 if args.device == "auto" and torch.cuda.is_available() else "cpu" if args.device == "auto" else args.device
    summary = []
    colors = ("#1b68e0", "#bd1661", "#cf7100", "#00846c", "#8a39c6", "#bd3825")
    short_names = ("CM", "PX", "OF", "SC", "CP", "DI")
    for file in files:
        with Image.open(file) as original:
            image = original.convert("RGB")
        boxes = predict(model, image, tiled=not args.full_frame, confidence=min(thresholds), device=device)
        boxes = [box for box in boxes if box["confidence"] >= thresholds[box["class_id"]]]
        counts = Counter(NAMES[box["class_id"]] for box in boxes)
        annotated = image.copy()
        draw = ImageDraw.Draw(annotated)
        detections = []
        for box in boxes:
            cls = box["class_id"]
            x1, y1, x2, y2 = box["xyxy"]
            draw.rectangle((x1, y1, x2, y2), outline=colors[cls], width=2)
            draw.text((x1, max(0, y1 - 12)), f"{short_names[cls]} {box['confidence']:.2f}",
                      fill=colors[cls], stroke_width=1, stroke_fill="white")
            detections.append({"pest_code": NAMES[cls], "confidence": box["confidence"],
                               "x_min": x1 / image.width, "y_min": y1 / image.height,
                               "x_max": x2 / image.width, "y_max": y2 / image.height})
        annotated.save(args.output / f"{file.stem}_detected.jpg", quality=95)
        payload = {"source_file": str(file), "width": image.width, "height": image.height,
                   "model_version": configuration.get("version", args.model.stem),
                   "model_sha256": model_sha256,
                   "counts": dict(counts), "total_count": len(boxes), "detections": detections}
        (args.output / f"{file.stem}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        summary.append({"file_name": file.name, "total": len(boxes), **{name: counts[name] for name in NAMES}})
        print(file.name, "=>", len(boxes), "detections", flush=True)
    with (args.output / "counts.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=["file_name", "total", *NAMES])
        writer.writeheader()
        writer.writerows(summary)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--full-frame", action="store_true")
    main(parser.parse_args())
