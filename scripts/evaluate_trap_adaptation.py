"""Compare trap models with thresholds selected on validation only, then fixed for test."""
from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
import time

from PIL import Image
from trap_detector import NAMES, predict, score, iou


def infer(model, rows, device, tiled, output):
    cached = {}
    for index, row in enumerate(rows, 1):
        with Image.open(row["path"]) as file:
            image = file.convert("RGB")
        cached[row["file_name"]] = predict(model, image, tiled=tiled, confidence=.05, device=device)
        if index % 20 == 0 or index == len(rows):
            print(f"Inference {index}/{len(rows)}, tiled={tiled}", flush=True)
    output.write_text(json.dumps(cached, ensure_ascii=False, indent=2), encoding="utf-8")
    return cached


def calibrate(predictions, truth):
    # Optimize F1 per supported class on validation; other classes retain the original .70 threshold.
    thresholds = [.7] * len(NAMES)
    events = [[] for _ in NAMES]
    counts = [0] * len(NAMES)
    for name, ground_truth in truth.items():
        for gt in ground_truth:
            counts[gt["class_id"]] += 1
        used = set()
        for prediction in sorted(predictions.get(name, []), key=lambda p: -p["confidence"]):
            cls = prediction["class_id"]
            options = [(iou(prediction["xyxy"], gt["xyxy"]), gi)
                       for gi, gt in enumerate(ground_truth)
                       if gi not in used and gt["class_id"] == cls]
            matched = False
            if options:
                overlap, gi = max(options)
                if overlap >= .5:
                    used.add(gi)
                    matched = True
            events[cls].append((prediction["confidence"], matched))
    for cls in range(3):
        if not counts[cls]:
            continue
        candidates = []
        for threshold in (.1, .15, .2, .25, .3, .35, .4, .45, .5, .55, .6, .65, .7, .75, .8, .85):
            selected = [correct for confidence, correct in events[cls] if confidence >= threshold]
            tp = sum(selected)
            fp, fn = len(selected) - tp, counts[cls] - tp
            f1 = 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0
            precision = tp / len(selected) if selected else 0
            candidates.append((f1, precision, threshold))
        thresholds[cls] = max(candidates)[2]
    return thresholds


def main(args):
    os.environ["YOLO_CONFIG_DIR"] = str(args.work / "settings")
    os.environ["YOLO_AUTOINSTALL"] = "false"
    import torch
    from ultralytics import YOLO, settings
    settings.update({"sync": False})
    torch.set_num_threads(4)
    device = args.device if args.device else 0 if torch.cuda.is_available() else "cpu"
    manifest = json.loads((args.work / "manifest.json").read_text(encoding="utf-8"))
    rows = {split: [r for r in manifest["source_photos"] if r["split"] == split]
            for split in ("val", "test")}
    truth = {split: {r["file_name"]: r["boxes"] for r in rows[split]} for split in rows}
    output = args.work / "evaluation"
    output.mkdir(exist_ok=True)
    model = YOLO(str(args.model))
    label = args.label
    report = {"model": str(args.model), "label": label, "tiled": args.tiled,
              "threshold_selection": "per-class maximum validation F1; no test threshold search",
              "limitations": manifest["limitations"], "results": {}}
    validation = infer(model, rows["val"], device, args.tiled, output / f"{label}_val_predictions.json")
    thresholds = calibrate(validation, truth["val"])
    report["thresholds"] = dict(zip(NAMES, thresholds, strict=True))
    report["results"]["val"] = score(validation, truth["val"], thresholds)
    report["results"]["val_fixed_0.70"] = score(validation, truth["val"], [.7] * 6)
    print("VALIDATION", label, json.dumps(report["results"]["val"]["overall"]), "thresholds", thresholds, flush=True)
    (output / f"{label}_metrics.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.validation_only:
        return
    testing = infer(model, rows["test"], device, args.tiled, output / f"{label}_test_predictions.json")
    report["results"]["test"] = score(testing, truth["test"], thresholds)
    report["results"]["test_fixed_0.70"] = score(testing, truth["test"], [.7] * 6)
    print("TEST", label, json.dumps(report["results"]["test"]["overall"]), flush=True)
    (output / f"{label}_metrics.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    with (output / f"{label}_test.csv").open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=report["results"]["test"]["images"][0].keys())
        writer.writeheader()
        writer.writerows(report["results"]["test"]["images"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--label", required=True)
    parser.add_argument("--tiled", action="store_true")
    parser.add_argument("--validation-only", action="store_true")
    parser.add_argument("--device")
    main(parser.parse_args())
