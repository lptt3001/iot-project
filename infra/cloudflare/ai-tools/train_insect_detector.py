"""Build a single-class insect detector for unknown-species counting on the cloud UI."""
import argparse
from collections import defaultdict
import json
import os
from pathlib import Path
import shutil
import sys

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
from trap_detector import tiles, iou


def prepare(work, cache, adapted):
    manifest = json.loads((adapted / "manifest.json").read_text(encoding="utf-8"))
    source_annotations = {}
    for split in ("train", "val"):
        data = json.loads((cache / f"ricepest-{split}.json").read_text(encoding="utf-8"))
        by_id = defaultdict(list)
        for annotation in data["annotations"]:
            by_id[annotation["image_id"]].append(annotation)
        for image in data["images"]:
            source_annotations[image["file_name"]] = (image, by_id[image["id"]])
    dataset = work / "dataset"
    if dataset.exists():
        raise RuntimeError("Use the existing generated data or a new --work directory.")
    photos = []

    def save(split, name, image, boxes):
        image_dir = dataset / split / "images"
        label_dir = dataset / split / "labels"
        image_dir.mkdir(parents=True, exist_ok=True)
        label_dir.mkdir(parents=True, exist_ok=True)
        image.save(image_dir / name, quality=95)
        lines = []
        for x1, y1, x2, y2 in boxes:
            lines.append(f"0 {(x1+x2)/2/image.width:.9f} {(y1+y2)/2/image.height:.9f} "
                         f"{(x2-x1)/image.width:.9f} {(y2-y1)/image.height:.9f}")
        (label_dir / Path(name).with_suffix(".txt")).write_text("\n".join(lines), encoding="utf-8")

    for row in manifest["source_photos"]:
        reference, annotations = source_annotations[row["file_name"]]
        with Image.open(row["path"]) as file:
            image = file.convert("RGB")
        sx, sy = image.width / reference["width"], image.height / reference["height"]
        boxes = []
        for annotation in annotations:
            x, y, w, h = annotation["bbox"]
            box = [max(0., x*sx), max(0., y*sy), min(image.width, (x+w)*sx), min(image.height, (y+h)*sy)]
            if min(box[2]-box[0], box[3]-box[1]) < 1 or any(iou(box, other) > .95 for other in boxes):
                continue
            boxes.append(box)
        save(row["split"], row["file_name"], image, boxes)
        photos.append({**{k: row[k] for k in ("file_name", "path", "split", "sha256", "group")},
                       "boxes": [{"class_id": 0, "xyxy": box} for box in boxes]})
        if row["split"] == "train":
            for index, (ox, oy, ex, ey) in enumerate(tiles(*image.size)):
                clipped = []
                for x1, y1, x2, y2 in boxes:
                    a, b, c, d = max(x1,ox), max(y1,oy), min(x2,ex), min(y2,ey)
                    if min(c-a,d-b) >= 2 and (c-a)*(d-b) >= .35*(x2-x1)*(y2-y1):
                        clipped.append([a-ox,b-oy,c-ox,d-oy])
                save("train", f"tile{index}_{row['file_name']}", image.crop((ox,oy,ex,ey)), clipped)
    # Keep the original six-class replay images, merging their labels into "insect".
    for image_path in sorted((adapted / "dataset/train/images").glob("replay_*.jpg")):
        label = adapted / "dataset/train/labels" / image_path.with_suffix(".txt").name
        with Image.open(image_path) as file:
            image = file.convert("RGB")
        boxes = []
        for line in label.read_text().splitlines():
            if line.strip():
                _, x, y, w, h = map(float, line.split())
                boxes.append([(x-w/2)*image.width,(y-h/2)*image.height,(x+w/2)*image.width,(y+h/2)*image.height])
        save("train", image_path.name, image, boxes)
    work.mkdir(exist_ok=True, parents=True)
    (work / "manifest.json").write_text(json.dumps({"photos": photos, "source_commit": manifest["commit"],
        "label_scope": "All insect categories annotated by RicePest-30 plus original six-species replay; unlabeled tiny insects may remain."}, ensure_ascii=False, indent=2), encoding="utf-8")
    (work / "data.yaml").write_text(json.dumps({"path": str(dataset), "train": "train/images",
        "val": "val/images", "test": "test/images", "names": {0: "insect"}}), encoding="utf-8")
    print("PREPARED", {s: sum(r["split"] == s for r in photos) for s in ("train","val","test")}, flush=True)


def train(args):
    os.environ["YOLO_CONFIG_DIR"] = str(args.work / "settings")
    os.environ["YOLO_AUTOINSTALL"] = "false"
    import torch
    from ultralytics import YOLO, settings
    settings.update({"sync": False})
    torch.set_num_threads(4)
    if args.resume:
        YOLO(str(args.work / "runs/insects/weights/last.pt")).train(resume=True, device=0, workers=2)
    else:
        YOLO(str(ROOT / "deliverables/PTIT_Trap_6Loai_CaiThien_v1.pt")).train(
            data=str(args.work / "data.yaml"), epochs=args.epochs, imgsz=640, batch=8, device=0,
            workers=2, amp=False, optimizer="AdamW", lr0=.00015, lrf=.2, freeze=0,
            warmup_epochs=2, patience=7, mosaic=.15, close_mosaic=4, mixup=0.,
            degrees=5, translate=.05, scale=.2, fliplr=.5, flipud=.3,
            hsv_h=.01, hsv_s=.2, hsv_v=.2, plots=False, seed=20261108, deterministic=True,
            project=str(args.work / "runs"), name="insects", exist_ok=False, save_period=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "train"))
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--adapted", type=Path)
    parser.add_argument("--epochs", type=int, default=16)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    args.work = args.work.resolve()
    if args.action == "prepare":
        prepare(args.work, args.cache, args.adapted)
    else:
        train(args)
