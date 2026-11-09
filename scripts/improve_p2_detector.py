"""Train and compare a P2 insect detector without changing deployed web assets.

Use the isolated Ultralytics environment and --work outside OneDrive. The existing
generic-insects dataset supplies source annotations, not model-generated labels.
"""
from __future__ import annotations

import argparse
from collections import Counter
import copy
import hashlib
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def dump(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def prepare(args):
    from PIL import Image
    import numpy as np

    dataset = args.source / "dataset"
    manifest = json.loads((args.source / "manifest.json").read_text(encoding="utf-8"))
    rows = []
    for row in manifest["photos"]:
        path = dataset / row["split"] / "images" / row["file_name"]
        if not path.is_file():
            raise FileNotFoundError(path)
        rows.append({**row, "path": str(path.resolve())})
    # Audit every training image, including tiles and replay. Exact file and
    # decoded-pixel duplicates must not cross train/val/test boundaries.
    hashes, pixels, totals = {}, {}, {}
    leakage = []
    for split in ("train", "val", "test"):
        labels, empty, images = 0, 0, 0
        for path in sorted((dataset / split / "images").glob("*.jpg")):
            images += 1
            label = dataset / split / "labels" / path.with_suffix(".txt").name
            lines = [line for line in label.read_text().splitlines() if line.strip()]
            empty += not lines
            for line in lines:
                cls, x, y, w, h = map(float, line.split())
                if cls != 0 or not (0 <= x <= 1 and 0 <= y <= 1 and 0 < w <= 1 and 0 < h <= 1):
                    raise ValueError(f"Invalid label: {label}: {line}")
            labels += len(lines)
            with Image.open(path) as image:
                rgb = np.asarray(image.convert("RGB"))
                pixel_hash = hashlib.sha256(str(rgb.shape).encode() + rgb.tobytes()).hexdigest()
            for table, key, kind in ((hashes, digest(path), "file"), (pixels, pixel_hash, "pixels")):
                if key in table and table[key][0] != split:
                    leakage.append({"kind": kind, "first": table[key], "second": [split, path.name]})
                table[key] = (split, path.name)
        totals[split] = {"images": images, "boxes": labels, "empty_images": empty}
    groups = {s: sorted({r["group"] for r in rows if r["split"] == s}) for s in ("train", "val", "test")}
    if any(set(groups[a]) & set(groups[b]) for a, b in (("train", "val"), ("train", "test"), ("val", "test"))):
        raise ValueError("Source groups overlap")
    audit = {"totals": totals, "source_photos": dict(Counter(r["split"] for r in rows)),
             "groups": groups, "cross_split_exact_duplicates": leakage,
             "limitations": ["Public source boxes are not independently expert verified and may omit tiny insects.",
                             "Filename sequence groups are not verified independent capture days or traps.",
                             "Held-out test was used for the earlier v1 report; it is not a new unseen field collection."]}
    dump(args.work / "dataset-audit.json", audit)
    if leakage:
        raise ValueError("Cross-split duplicate images: see dataset-audit.json")
    dump(args.work / "manifest.json", {**manifest, "photos": rows, "audit": audit})
    dump(args.work / "data.yaml", {"path": str(dataset.resolve()), "train": "train/images",
                                  "val": "val/images", "test": "test/images", "names": {0: "insect"}})
    print("DATASET", json.dumps(audit, ensure_ascii=False), flush=True)


def initialize(args):
    import torch
    from ultralytics import YOLO
    torch.manual_seed(20261109)
    torch.set_num_threads(4)
    source = YOLO(str(args.baseline))
    config = copy.deepcopy(source.model.yaml)
    # Preserve layers 0..21 and add a parallel P2 branch from P3 + backbone P2.
    # Output width 80 retains the source classifier's hidden width (80), avoiding
    # silent loss of all three learned classification heads when nc becomes 1.
    config["head"] = config["head"][:-1] + [
        [15, 1, "nn.Upsample", [None, 2, "nearest"]],
        [[-1, 2], 1, "Concat", [1]],
        [-1, 3, "C2f", [320]],
        [[24, 15, 18, 21], 1, "Detect", ["nc"]],
    ]
    config["nc"] = 1
    dump(args.work / "yolov8n-p2-preserved.yaml", config)
    model = YOLO(str(args.work / "yolov8n-p2-preserved.yaml"), task="detect")
    old, target = source.model.state_dict(), model.model.state_dict()
    copied, missing = [], []
    for key, value in target.items():
        layer = int(key.split(".")[1])
        source_key = key if layer <= 21 else None
        if layer == 25:
            parts = key.split(".")
            parts[1] = "22"
            if parts[2] in ("cv2", "cv3"):
                head_index = int(parts[3])
                parts[3] = str(max(0, head_index - 1))
            source_key = ".".join(parts)
        if source_key in old and old[source_key].shape == value.shape:
            target[key] = old[source_key].clone()
            copied.append({"target": key, "source": source_key})
        else:
            missing.append(key)
    model.model.load_state_dict(target, strict=True)
    model.model.names = {0: "insect"}
    # Meaningful regression guard: adding P2 must preserve all original P3-P5
    # raw outputs before learning. This catches incorrect head-index transfers.
    source.model.eval(); model.model.eval()
    with torch.inference_mode():
        tensor = torch.rand(1, 3, 640, 640)
        expected = source.model(tensor)[0]
        actual = model.model(tensor)[0]
    error = float((expected - actual[:, :, 25600:]).abs().max())
    if actual.shape != (1, 5, 34000) or not torch.allclose(expected, actual[:, :, 25600:], atol=1e-4, rtol=1e-5):
        raise AssertionError(f"Original heads changed during transfer: max error {error}")
    report = {"baseline_sha256": digest(args.baseline), "output_shape": list(actual.shape),
              "strides": model.model.stride.tolist(), "original_head_max_abs_error": error,
              "copied_tensors": copied, "new_tensors": missing,
              "architecture": "YOLOv8n with preserved P3/P4/P5 and a parallel stride-4 P2 branch (80 output channels)",
              "loss": "Ultralytics standard CIoU + DFL + classification; no unverified NWD integration"}
    dump(args.work / "transfer-audit.json", report)
    model.save(str(args.work / "initialized.pt"))
    print("TRANSFER", len(copied), "tensors; original-head error", error, flush=True)


def train(args):
    import torch
    from ultralytics import YOLO, settings
    torch.set_num_threads(4)
    settings.update({"sync": False})
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA unavailable; do not silently start a long CPU training job")
    model = YOLO(str(args.work / "initialized.pt"))
    model.train(data=str(args.work / "data.yaml"), epochs=args.epochs, imgsz=640,
                batch=8, device=0, workers=2, amp=False, optimizer="AdamW",
                lr0=.0002, lrf=.15, freeze=0, warmup_epochs=2, patience=10,
                mosaic=.15, close_mosaic=6, mixup=0., copy_paste=0.,
                degrees=5, translate=.05, scale=.2, fliplr=.5, flipud=.3,
                hsv_h=.01, hsv_s=.2, hsv_v=.2, plots=False,
                seed=20261109, deterministic=True, project=str(args.work / "runs"),
                name="p2", exist_ok=False, save_period=8, cache=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "initialize", "train"))
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=Path(os.environ["LOCALAPPDATA"]) / "PTIT-Garden-AI/generic-insects")
    parser.add_argument("--baseline", type=Path, default=ROOT / "deliverables/PTIT_InsectDetector_v1.pt")
    parser.add_argument("--epochs", type=int, default=32)
    args = parser.parse_args()
    args.work = args.work.resolve(); args.work.mkdir(parents=True, exist_ok=True)
    os.environ["YOLO_CONFIG_DIR"] = str(args.work / "settings")
    os.environ["YOLO_AUTOINSTALL"] = "false"
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    globals()[args.action](args)


if __name__ == "__main__":
    main()
