"""Fine-tune the pretrained YOLOX-Nano detection head on CPU."""

import argparse
from collections import defaultdict
import json
import os
from pathlib import Path
import sys
import time

import cv2
import numpy as np
import torch

from evaluate_pestnu import precision_rank, score


def cache_features(model, root, split, batch, *, keep_pixels=False):
    rows = json.loads((root / "annotations" / f"{split}.json").read_text(encoding="utf-8"))
    boxes = defaultdict(list)
    for item in rows["annotations"]:
        x, y, w, h = item["bbox"]
        boxes[item["image_id"]].append([item["category_id"] - 1, x + w / 2, y + h / 2, w, h])
    images = rows["images"]
    targets = torch.zeros((len(images), max(1, max(map(len, boxes.values()))), 5))
    for index, image in enumerate(images):
        actual = boxes[image["id"]]
        if actual:
            targets[index, :len(actual)] = torch.tensor(actual)
    cache = None
    with torch.no_grad():
        for start in range(0, len(images), batch):
            frames = [
                cv2.imdecode(np.fromfile(root / f"{split}2017" / row["file_name"], dtype=np.uint8), cv2.IMREAD_COLOR)
                for row in images[start:start + batch]
            ]
            if any(frame is None or frame.shape != (416, 416, 3) for frame in frames):
                raise ValueError(f"Invalid {split} crop")
            pixels = torch.from_numpy(np.stack(frames)).permute(0, 3, 1, 2)
            features = (pixels,) if keep_pixels else model.backbone(pixels.float(memory_format=torch.channels_last))
            if cache is None:
                dtype = torch.uint8 if keep_pixels else torch.float16
                cache = [torch.empty((len(images), *level.shape[1:]), dtype=dtype) for level in features]
            for buffer, level in zip(cache, features, strict=True):
                buffer[start:start + len(frames)] = level
            if start % (batch * 25) == 0:
                print(f"{split} features {start + len(frames)}/{len(images)}", flush=True)
    return cache, targets


def validation_score(model, cache, labels, batch, *, keep_pixels=False):
    model.eval()
    truth = []
    for rows in labels.numpy():
        groups = []
        for label in range(2):
            actual = rows[(rows[:, 0] == label) & (rows[:, 3] > 0)]
            center, extent = actual[:, 1:3], actual[:, 3:5] / 2
            groups.append(np.column_stack((center - extent, center + extent)))
        truth.append(groups)
    outputs = []
    with torch.no_grad():
        for start in range(0, len(labels), batch):
            features = [level[start:start + batch].float(memory_format=torch.channels_last) for level in cache]
            output = model(features[0]) if keep_pixels else model.head(features)
            outputs.extend(output.numpy())
    data = list(zip(outputs, truth, strict=True))
    def rank(result):
        values = result["classes"].values()
        if not keep_pixels:
            return sum(item["f1"] for item in values) / 2
        return sum(precision_rank(item) for item in values) / 2
    return max(rank(score(data, threshold)) for threshold in (0.20, 0.30, 0.40, 0.50))


def save_checkpoint(path, state):
    temporary = path.with_suffix(".tmp")
    torch.save(state, temporary)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runtime", type=Path)
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--refine-from", type=Path)
    parser.add_argument("--samples-per-epoch", type=int)
    args = parser.parse_args()
    runtime = args.runtime.resolve()
    root = runtime / "pestnu" / "coco-ready"
    runs = runtime / "runs"
    refine = args.refine_from is not None
    run = runs / ("ptit_pestnu_nano_refine" if refine else "ptit_pestnu_nano")
    run.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(runtime / "yolox-src"))
    os.environ["PTIT_AI_COCO_DIR"] = str(root)
    os.environ["PTIT_AI_RUNS_DIR"] = str(runs)

    from pestnu_yolox import Exp
    from yolox.utils import load_ckpt

    torch.manual_seed(47)
    torch.set_num_threads(4)
    cv2.setNumThreads(1)
    model = Exp().get_model().to(memory_format=torch.channels_last)
    frozen = (model.backbone.backbone,) if refine else (model.backbone,)
    if refine:
        base = torch.load(args.refine_from, map_location="cpu", weights_only=True)
        model.load_state_dict(base["model"])
    else:
        base = torch.load(runtime / "yolox-nano-coco.pth", map_location="cpu", weights_only=True)
        load_ckpt(model, base["model"])
    for part in frozen:
        part.requires_grad_(False)
        part.eval()
    model.head.use_l1 = True
    if refine:
        optimizer = torch.optim.AdamW([
            {"params": (p for p in model.backbone.parameters() if p.requires_grad), "lr": 0.00025},
            {"params": model.head.parameters(), "lr": 0.00035},
        ], weight_decay=0.0005)
    else:
        optimizer = torch.optim.AdamW(model.head.parameters(), lr=0.001, weight_decay=0.0005)
    latest = run / "cpu_latest_ckpt.pth"
    epoch_start, best = 0, -1.0
    if latest.exists():
        state = torch.load(latest, map_location="cpu", weights_only=True)
        model.load_state_dict(state["model"])
        optimizer.load_state_dict(state["optimizer"])
        epoch_start, best = state["epoch"], state["best"]
    train, targets = cache_features(model, root, "train", args.batch, keep_pixels=refine)
    validation, val_targets = cache_features(model, root, "val", args.batch, keep_pixels=refine)
    for epoch in range(epoch_start, args.epochs):
        begin = time.monotonic()
        model.train()
        for part in frozen:
            part.eval()
        order = torch.randperm(len(targets), generator=torch.Generator().manual_seed(47 + epoch))
        if args.samples_per_epoch:
            order = order[:args.samples_per_epoch]
        losses = []
        for step, group in enumerate(order.split(args.batch)):
            features = [level[group].float(memory_format=torch.channels_last) for level in train]
            optimizer.zero_grad(set_to_none=True)
            batch_targets = targets[group]
            if refine:
                pixels = features[0]
                if (epoch + step) % 2:
                    pixels = pixels.flip(-1)
                    present = batch_targets[..., 3] > 0
                    batch_targets[..., 1][present] = 416 - batch_targets[..., 1][present]
                loss = model(pixels, batch_targets)["total_loss"]
            else:
                loss = model.head(features, batch_targets)[0]
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 10.0, error_if_nonfinite=True)
            optimizer.step()
            losses.append(loss.item())
        validation_metric = validation_score(model, validation, val_targets, args.batch, keep_pixels=refine)
        state = {"model": model.state_dict(), "optimizer": optimizer.state_dict(), "epoch": epoch + 1, "best": max(validation_metric, best)}
        if validation_metric > best:
            best = validation_metric
            save_checkpoint(run / "best_ckpt.pth", {"model": state["model"]})
        save_checkpoint(latest, state)
        metric = "F0.5" if refine else "F1"
        print(f"Epoch {epoch + 1}/{args.epochs} loss={np.mean(losses):.3f} val_{metric}={validation_metric:.3f} time={time.monotonic()-begin:.1f}s", flush=True)


if __name__ == "__main__":
    main()
