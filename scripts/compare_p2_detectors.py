"""Compare v1 and improved P2 on identical held-out images and inference settings."""
from __future__ import annotations

import argparse
from collections import Counter
import csv
import json
import os
from pathlib import Path
import random
import sys
import time

import numpy as np
from PIL import Image

from improve_p2_detector import ROOT, digest, dump
from trap_detector import score, tiles, iou


def predict(model, image, device):
    """Full frame + 320/50% tiles, per-view NMS .7, global NMS .45.

    Vectorized host transfer/NMS avoids thousands of individual GPU .item calls.
    The same processing is used for both checkpoints; this is not a browser test.
    """
    import cv2
    width, height = image.size
    regions = [(0, 0, width, height)]
    if width > 320 or height > 320:
        regions += tiles(width, height)
    results = model.predict([image.crop(r) for r in regions], imgsz=640, conf=.05,
                            iou=.7, rect=False, max_det=300, device=device,
                            verbose=False, batch=4)
    candidates = []
    for index, (region, result) in enumerate(zip(regions, results, strict=True)):
        ox, oy, ex, ey = region
        for x1, y1, x2, y2, confidence, cls in result.boxes.data.cpu().numpy():
            if index and ((ox > 0 and x1 <= 3) or (oy > 0 and y1 <= 3) or
                          (ex < width and x2 >= ex - ox - 3) or
                          (ey < height and y2 >= ey - oy - 3)):
                continue
            candidates.append([max(0., x1 + ox), max(0., y1 + oy),
                               min(float(width), x2 + ox), min(float(height), y2 + oy), float(confidence)])
    if not candidates:
        return []
    array = np.asarray(candidates, dtype=np.float32)
    xywh = array[:, :4].copy(); xywh[:, 2:] -= xywh[:, :2]
    keep = cv2.dnn.NMSBoxes(xywh.tolist(), array[:, 4].tolist(), .049, .45, top_k=0)
    return [{"class_id": 0, "confidence": float(array[i, 4]), "xyxy": array[i, :4].astype(float).tolist()}
            for i in np.asarray(keep).reshape(-1)]


def infer(model, rows, device, path):
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        if data["weights_sha256"] == digest(model.ckpt_path):
            return data
        raise ValueError(f"Stale predictions: {path}")
    import torch
    predictions, durations = {}, []
    # Warm-up is excluded from timing.
    with Image.open(rows[0]["path"]) as image:
        predict(model, image.convert("RGB"), device)
    for index, row in enumerate(rows, 1):
        with Image.open(row["path"]) as file:
            image = file.convert("RGB")
        torch.cuda.synchronize()
        start = time.perf_counter()
        predictions[row["file_name"]] = predict(model, image, device)
        torch.cuda.synchronize()
        durations.append((time.perf_counter() - start) * 1000)
        if index % 25 == 0 or index == len(rows):
            print(path.stem, f"{index}/{len(rows)}", flush=True)
    data = {"weights_sha256": digest(model.ckpt_path), "predictions": predictions,
            "timing_ms": {"mean": float(np.mean(durations)), "median": float(np.median(durations)),
                          "p95": float(np.percentile(durations, 95)), "per_image": durations}}
    dump(path, data)
    return data


def calibrate(predictions, truth):
    values = []
    for integer in range(4, 39):
        threshold = integer / 40
        metrics = score(predictions, truth, [threshold] * 6)["overall"]
        p, r = metrics["precision"] or 0, metrics["recall"] or 0
        values.append({"threshold": threshold, **metrics,
                       "f05": 1.25 * p * r / (.25 * p + r) if p + r else 0.})
    eligible = [v for v in values if (v["precision"] or 0) >= .70]
    chosen = max(eligible, key=lambda x: (x["recall"] or 0, x["precision"] or 0)) if eligible else max(values, key=lambda x: x["f05"])
    return {"chosen": chosen, "grid": values, "maximum_f1": max(values, key=lambda x: x["f1"] or 0)}


def size_recall(predictions, truth, threshold):
    counts = {name: Counter() for name in ("small_under_32px", "medium_32_to_96px", "large_over_96px")}
    for filename, ground in truth.items():
        used = set()
        for p in sorted((p for p in predictions[filename] if p["confidence"] >= threshold), key=lambda p: -p["confidence"]):
            overlaps = [(iou(p["xyxy"], g["xyxy"]), i) for i, g in enumerate(ground) if i not in used]
            if overlaps:
                overlap, index = max(overlaps)
                if overlap >= .5:
                    used.add(index)
        for index, g in enumerate(ground):
            x1, y1, x2, y2 = g["xyxy"]
            size = np.sqrt((x2-x1)*(y2-y1))
            label = "small_under_32px" if size < 32 else "medium_32_to_96px" if size < 96 else "large_over_96px"
            counts[label].update(truth=1, tp=int(index in used))
    return {name: {**dict(c), "recall": c["tp"] / c["truth"] if c["truth"] else None} for name, c in counts.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("validate", "test"))
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--baseline", type=Path, default=ROOT / "deliverables/PTIT_InsectDetector_v1.pt")
    parser.add_argument("--candidate", type=Path)
    args = parser.parse_args()
    args.work = args.work.resolve()
    args.candidate = args.candidate or args.work / "runs/p2/weights/best.pt"
    os.environ["YOLO_CONFIG_DIR"] = str(args.work / "settings")
    os.environ["YOLO_AUTOINSTALL"] = "false"
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    import torch
    from ultralytics import YOLO, settings
    torch.set_num_threads(4); settings.update({"sync": False})
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for this benchmark")
    manifest = json.loads((args.work / "manifest.json").read_text(encoding="utf-8"))
    split = "val" if args.action == "validate" else "test"
    rows = [r for r in manifest["photos"] if r["split"] == split]
    truth = {r["file_name"]: r["boxes"] for r in rows}
    selection_path = args.work / "selection-before-test.json"
    if args.action == "test":
        frozen = json.loads(selection_path.read_text(encoding="utf-8"))
    else:
        frozen = {"policy": "Validation precision >= 0.70, maximize recall; fallback maximum F0.5. No test selection.",
                  "models": {}, "dataset_audit_sha256": digest(args.work / "dataset-audit.json")}
        names = sorted(r["file_name"] for r in manifest["photos"] if r["split"] == "test")
        frozen["illustration_images_selected_before_test"] = random.Random(20261109).sample(names, 3)
    reports = {}
    for label, path in (("v1", args.baseline), ("p2_improved", args.candidate)):
        if args.action == "test" and frozen["models"][label]["weights_sha256"] != digest(path):
            raise ValueError("Checkpoint changed after validation selection")
        model = YOLO(str(path))
        predictions = infer(model, rows, 0, args.work / f"{label}-{split}-predictions.json")
        if args.action == "validate":
            frozen["models"][label] = {"weights_sha256": digest(path),
                                      **calibrate(predictions["predictions"], truth)}
            print("VALIDATION", label, frozen["models"][label]["chosen"], flush=True)
        else:
            threshold = frozen["models"][label]["chosen"]["threshold"]
            result = score(predictions["predictions"], truth, [threshold] * 6)
            reports[label] = {"weights_sha256": digest(path), "threshold": threshold,
                              "test": result["overall"], "size_recall": size_recall(predictions["predictions"], truth, threshold),
                              "fixed_055": score(predictions["predictions"], truth, [.55] * 6)["overall"],
                              "timing_ms": predictions["timing_ms"], "images": result["images"]}
            reports[label]["by_source_group"] = {
                str(group): score(predictions["predictions"],
                                  {r["file_name"]: r["boxes"] for r in rows if r["group"] == group},
                                  [threshold] * 6)["overall"]
                for group in sorted({r["group"] for r in rows})}
            print("TEST", label, reports[label]["test"], flush=True)
            validation = model.val(data=str(args.work / "data.yaml"), split="test", device=0,
                                   batch=8, workers=2, imgsz=640, conf=.001, iou=.7,
                                   plots=False, verbose=False, project=str(args.work / "map-evaluation"),
                                   name=label)
            reports[label]["full_frame_test_map"] = {k: float(v) for k, v in validation.results_dict.items()}
            dump(args.work / f"{label}-test-metrics.json", reports[label])
    if args.action == "validate":
        dump(selection_path, frozen)
    else:
        report = {"scope": "Generic single-class insect detection, not six-species accuracy or full browser pipeline",
                  "images": len(rows), "truth_boxes": sum(len(r["boxes"]) for r in rows),
                  "matching": "Class-agnostic insect, one-to-one confidence-ordered IoU >= .5",
                  "inference": "PyTorch FP32 RTX4050; RGB /255 letterbox114 640; full+320/50% tiles; per-view NMS .7, global .45",
                  "selection": frozen, "models": reports, "limitations": manifest["audit"]["limitations"]}
        dump(args.work / "comparison.json", report)
        with (args.work / "comparison-per-image.csv").open("w", encoding="utf-8-sig", newline="") as file:
            writer = csv.DictWriter(file, fieldnames=["model", "file_name", "truth", "predicted", "tp", "fp", "fn"])
            writer.writeheader()
            for label, result in reports.items():
                writer.writerows({"model": label, **r} for r in result["images"])


if __name__ == "__main__":
    main()
