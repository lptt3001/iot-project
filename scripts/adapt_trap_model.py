"""Prepare grouped trap data and fine-tune the six-class model without using test for selection.

Run with the isolated Ultralytics environment. Downloaded source data stays in --work.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import random
import shutil

import httpx
from PIL import Image
import numpy as np
from trap_detector import NAMES, SOURCE_CLASSES, tiles

COMMIT = "206e0a990edb99efa75ca7beb9d5f1243c807c0d"
TEST_GROUPS = {172, 176, 179, 186}
VAL_GROUPS = {174, 184}
GUARD_GROUPS = {g + offset for g in TEST_GROUPS for offset in (-1, 1)}


def dump(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def photo_id(name):
    return str(name).replace("\\", "/").rsplit("/", 1)[-1].rsplit("_", 1)[-1].split(".")[0]


def prepare(args):
    workspace, work = args.workspace, args.work
    work.mkdir(parents=True, exist_ok=True)
    package = args.source_package
    old = list(csv.DictReader((package / "dataset/metadata/manifest.csv").open(encoding="utf-8-sig")))
    known_photos = {photo_id(r["source_file"]) for r in old if r["source"] == "RicePest30_GitHub_Dataset"}
    known_hashes = {r[k] for r in old for k in ("original_sha256", "output_sha256") if r.get(k)}
    legacy_path = workspace / "output/ai/anh_bay_that_RicePest30/NGUON.csv"
    legacy = list(csv.DictReader(legacy_path.open(encoding="utf-8-sig")))
    legacy_photos = {photo_id(r["source_file"]) for r in legacy}
    sources = []
    for split in ("train", "val"):
        cached = args.cache / f"ricepest-{split}.json"
        if not cached.exists():
            args.cache.mkdir(parents=True, exist_ok=True)
            url = (f"https://raw.githubusercontent.com/kkb20334-lang/RicePest-30/{COMMIT}/"
                   f"{split}/filtered_{split}_translated.json")
            response = httpx.get(url, timeout=60, follow_redirects=True)
            response.raise_for_status()
            if len(response.content) > 40 * 1024 * 1024:
                raise ValueError("Unexpected annotation download size.")
            json.loads(response.content)
            cached.write_bytes(response.content)
        data = json.loads(cached.read_text(encoding="utf-8"))
        annotations = defaultdict(list)
        for annotation in data["annotations"]:
            annotations[annotation["image_id"]].append(annotation)
        for image in data["images"]:
            name = image["file_name"]
            if "_real_" not in name or photo_id(name) in known_photos | legacy_photos:
                continue
            group = int(name.split("_")[0]) // 50
            if group in TEST_GROUPS:
                destination = "test"
            elif group in VAL_GROUPS:
                destination = "val"
            elif group in GUARD_GROUPS:
                continue
            else:
                destination = "train"
            sources.append({"image": image, "annotations": annotations[image["id"]],
                            "source_split": split, "group": group, "split": destination})
    downloads = work / "source"
    downloads.mkdir(exist_ok=True)

    def download(row):
        name = row["image"]["file_name"]
        target = downloads / name
        url = f"https://raw.githubusercontent.com/kkb20334-lang/RicePest-30/{COMMIT}/{row['source_split']}/{name}"
        if not target.exists():
            with httpx.Client(timeout=40, follow_redirects=True) as client:
                response = client.get(url)
                response.raise_for_status()
                body = response.content
            with Image.open(io.BytesIO(body)) as image:
                image.verify()
            target.write_bytes(body)
        body = target.read_bytes()
        digest = hashlib.sha256(body).hexdigest()
        if digest in known_hashes:
            return None
        with Image.open(io.BytesIO(body)) as image:
            image = image.convert("RGB")
            width, height = image.size
            # Perceptual near-duplicate guard; source sequences are not verified capture-day IDs.
            import cv2
            small = np.asarray(image.resize((32, 32)).convert("L"), dtype=np.float32)
            block = cv2.dct(small)[:8, :8].flatten()[1:]
            bits = block > np.median(block)
            phash = sum(int(bit) << i for i, bit in enumerate(bits))
        boxes = []
        for annotation in row["annotations"]:
            if annotation["category_id"] not in SOURCE_CLASSES:
                continue
            x, y, w, h = annotation["bbox"]
            sx, sy = width / row["image"]["width"], height / row["image"]["height"]
            box = [max(0., x * sx), max(0., y * sy), min(width, (x + w) * sx), min(height, (y + h) * sy)]
            if box[2] - box[0] >= 1 and box[3] - box[1] >= 1:
                boxes.append({"class_id": SOURCE_CLASSES[annotation["category_id"]], "xyxy": box})
        return {"file_name": name, "path": str(target), "source_url": url, "split": row["split"],
                "group": row["group"], "sha256": digest, "phash": phash, "width": width,
                "height": height, "boxes": boxes, "other_source_boxes": len(row["annotations"]) - len(boxes)}

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = []
        for number, row in enumerate(pool.map(download, sources), 1):
            if row:
                rows.append(row)
            if number % 50 == 0:
                print(f"Downloaded/checked {number}/{len(sources)} source photos", flush=True)
    test = [r for r in rows if r["split"] == "test"]
    validation = [r for r in rows if r["split"] == "val"]
    training = [r for r in rows if r["split"] == "train"]
    rejected = []

    def near(a, others):
        return any(a["sha256"] == b["sha256"] or (a["phash"] ^ b["phash"]).bit_count() <= 4 for b in others)

    validation_kept = []
    for row in validation:
        if near(row, test):
            rejected.append({"file_name": row["file_name"], "reason": "val similar to test"})
        else:
            validation_kept.append(row)
    kept = test + validation_kept
    for row in training:
        if near(row, test + validation_kept):
            rejected.append({"file_name": row["file_name"], "reason": "train similar to holdout"})
        else:
            kept.append(row)
    unique = {}
    for row in sorted(kept, key=lambda r: (-len(r["boxes"]), r["file_name"])):
        if row["sha256"] in unique:
            rejected.append({"file_name": row["file_name"], "reason": "duplicate source JPEG bytes"})
        else:
            unique[row["sha256"]] = row
    kept = list(unique.values())
    assert len({r["file_name"] for r in kept}) == len(kept)
    assert not ({r["group"] for r in kept if r["split"] == "test"} &
                {r["group"] for r in kept if r["split"] != "test"})
    dataset = work / "dataset"
    if dataset.exists():
        if (dataset.is_symlink() or dataset.resolve().parent != work.resolve() or
                not (work / "manifest.json").exists()):
            raise RuntimeError("Refusing to replace an unrecognized generated dataset directory.")
        previous = json.loads((work / "manifest.json").read_text(encoding="utf-8"))
        if previous.get("commit") != COMMIT:
            raise RuntimeError("Generated dataset provenance changed; use a new work directory.")
        shutil.rmtree(dataset)
    examples = []

    def save_example(split, name, image, boxes, source_id, kind):
        image_dir, label_dir = dataset / split / "images", dataset / split / "labels"
        image_dir.mkdir(parents=True, exist_ok=True)
        label_dir.mkdir(parents=True, exist_ok=True)
        image.save(image_dir / name, quality=95)
        width, height = image.size
        labels = []
        for box in boxes:
            x1, y1, x2, y2 = box["xyxy"]
            labels.append(f"{box['class_id']} {(x1+x2)/2/width:.9f} {(y1+y2)/2/height:.9f} "
                          f"{(x2-x1)/width:.9f} {(y2-y1)/height:.9f}")
        (label_dir / Path(name).with_suffix(".txt")).write_text("\n".join(labels), encoding="utf-8")
        examples.append({"file_name": name, "split": split, "source": source_id, "kind": kind,
                         "boxes": len(boxes)})

    for row in kept:
        with Image.open(row["path"]) as file:
            image = file.convert("RGB")
        save_example(row["split"], row["file_name"], image, row["boxes"], row["file_name"], "full")
        if row["split"] != "train":
            continue
        for index, bounds in enumerate(tiles(*image.size)):
            ox, oy, ex, ey = bounds
            clipped = []
            for box in row["boxes"]:
                x1, y1, x2, y2 = box["xyxy"]
                cx1, cy1, cx2, cy2 = max(x1, ox), max(y1, oy), min(x2, ex), min(y2, ey)
                area = max(0., cx2 - cx1) * max(0., cy2 - cy1)
                if area >= .35 * (x2 - x1) * (y2 - y1) and min(cx2 - cx1, cy2 - cy1) >= 2:
                    clipped.append({"class_id": box["class_id"], "xyxy": [cx1-ox, cy1-oy, cx2-ox, cy2-oy]})
            save_example("train", f"tile{index}_{row['file_name']}", image.crop(bounds), clipped,
                         row["file_name"], "tile")
    # Replay all six classes from the old training split, excluding the RicePest source entirely.
    rng = random.Random(20261108)
    replay = set()
    candidates = [r for r in old if r["split"] == "train" and r["source"] != "RicePest30_GitHub_Dataset"]
    for name in NAMES:
        matching = [r for r in candidates if r["directory_class"] == name]
        rng.shuffle(matching)
        replay.update(r["image"] for r in matching[:80])
    for relative in sorted(replay):
        image_path = package / "dataset" / relative
        label_path = package / "dataset" / relative.replace("/images/", "/labels/")
        label_path = label_path.with_suffix(".txt")
        with Image.open(image_path) as file:
            image = file.convert("RGB")
        boxes = []
        for line in label_path.read_text().splitlines():
            if not line.strip():
                continue
            cls, x, y, w, h = map(float, line.split())
            boxes.append({"class_id": int(cls), "xyxy": [(x-w/2)*image.width, (y-h/2)*image.height,
                                                          (x+w/2)*image.width, (y+h/2)*image.height]})
        name = "replay_" + image_path.parent.name + "_" + image_path.name
        save_example("train", name, image, boxes, relative, "replay")
    manifest = {"commit": COMMIT, "test_groups": sorted(TEST_GROUPS), "val_groups": sorted(VAL_GROUPS),
                "neighbor_guard_groups": sorted(GUARD_GROUPS), "source_photos": kept,
                "rejected_similar": rejected, "examples": examples,
                "limitations": ["Source groups use filename order, not verified capture-day or trap IDs.",
                                "Species and boxes are source labels, not independently expert-verified.",
                                "Only three model species are labeled in RicePest-30 trap photos."]}
    dump(work / "manifest.json", manifest)
    dump(work / "data.yaml", {"path": str(dataset), "train": "train/images", "val": "val/images",
                              "test": "test/images", "names": dict(enumerate(NAMES))})
    print("PREPARED", dict(Counter(r["split"] for r in kept)), "source photos;",
          dict(Counter(e["split"] for e in examples)), "examples; similar excluded", len(rejected), flush=True)


def train(args):
    os.environ["YOLO_CONFIG_DIR"] = str(args.work / "settings")
    os.environ["YOLO_AUTOINSTALL"] = "false"
    import torch
    from ultralytics import YOLO, settings
    settings.update({"sync": False})
    torch.set_num_threads(4)
    if not torch.cuda.is_available():
        raise RuntimeError("This training run requires the local GPU.")
    run_name = "trap_adapt_v2" if args.phase2 else "trap_adapt_v1"
    if args.resume:
        checkpoint = args.work / "runs" / run_name / "weights/last.pt"
        if not checkpoint.exists():
            raise FileNotFoundError(checkpoint)
        YOLO(str(checkpoint)).train(resume=True, device=0, workers=args.workers, batch=args.batch)
        return
    if args.phase2:
        # Reweight only training examples; validation/test photos and labels remain untouched.
        balanced = args.work / "phase2/train"
        data_file = args.work / "phase2.yaml"
        if not data_file.exists():
            (balanced / "images").mkdir(parents=True, exist_ok=True)
            (balanced / "labels").mkdir(parents=True, exist_ok=True)
            weighted = []
            for image in sorted((args.work / "dataset/train/images").glob("*.jpg")):
                label = args.work / "dataset/train/labels" / image.with_suffix(".txt").name
                classes = {int(line.split()[0]) for line in label.read_text().splitlines() if line.strip()}
                repeats = 3 if 1 in classes else 1
                weighted.append({"source": image.name, "repeats": repeats})
                for number in range(repeats):
                    stem = f"r{number}_{image.stem}"
                    for source, target in ((image, balanced / "images" / f"{stem}.jpg"),
                                           (label, balanced / "labels" / f"{stem}.txt")):
                        if not target.exists():
                            try:
                                os.link(source, target)
                            except OSError:
                                shutil.copy2(source, target)
            dump(args.work / "phase2_weighting.json", weighted)
            dump(data_file, {"path": str(args.work), "train": "phase2/train/images",
                             "val": "dataset/val/images", "test": "dataset/test/images",
                             "names": dict(enumerate(NAMES))})
        model = YOLO(str(args.work / "runs/trap_adapt_v1/weights/best.pt"))
        model.train(data=str(data_file), epochs=args.epochs, imgsz=640, batch=args.batch,
                    device=0, workers=args.workers, amp=False, optimizer="AdamW", lr0=.00005, lrf=.3,
                    weight_decay=.0005, freeze=0, warmup_epochs=1, patience=8,
                    mosaic=0., close_mosaic=0, mixup=0., degrees=5, translate=.05, scale=.15,
                    fliplr=.5, flipud=.3, hsv_h=.01, hsv_s=.15, hsv_v=.15,
                    seed=20261108, deterministic=True, plots=False, save_period=4,
                    project=str(args.work / "runs"), name=run_name, exist_ok=False)
        return
    model = YOLO(str(args.source_package / "models/yolov8n_6_loai.pt"))
    model.train(data=str(args.work / "data.yaml"), epochs=args.epochs, imgsz=640, batch=args.batch,
                device=0, workers=args.workers, amp=False, optimizer="AdamW", lr0=.0002, lrf=.1,
                weight_decay=.0005, freeze=10, warmup_epochs=2, patience=8,
                mosaic=.3, close_mosaic=5, mixup=0., degrees=10, translate=.1, scale=.3,
                fliplr=.5, flipud=.3, hsv_h=.01, hsv_s=.25, hsv_v=.2,
                seed=20261108, deterministic=True, plots=False, save_period=5,
                project=str(args.work / "runs"), name="trap_adapt_v1", exist_ok=False)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "train"))
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--source-package", type=Path, default=Path(os.environ['LOCALAPPDATA']) / 'PTIT-Garden-AI/project-archives/cleanup-20261109/he_thong_nhan_dien_con_trung/he_thong_nhan_dien_con_trung', help='Original six-class training package; use this option on another machine.')
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--epochs", type=int, default=24)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--phase2", action="store_true")
    options = parser.parse_args()
    options.workspace = options.workspace.resolve()
    options.work = options.work.resolve()
    if options.action == "prepare":
        if options.cache is None:
            options.cache = options.work / "cache"
        prepare(options)
    else:
        train(options)
