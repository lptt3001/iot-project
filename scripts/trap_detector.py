"""YOLO trap inference with overlapping tiles, boundary filtering and box evaluation."""
from __future__ import annotations

from collections import Counter
import numpy as np

NAMES = (
    "Cnaphalocrocis_medinalis", "Plutella_xylostella", "Ostrinia_furnacalis",
    "Scotinophara_coarctata", "Conogethes_punctiferalis", "Diaphania_indica",
)
SOURCE_CLASSES = {3: 0, 20: 1, 1: 2}


def iou(a, b):
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    intersection = np.maximum(0, np.minimum(a[2:], b[2:]) - np.maximum(a[:2], b[:2])).prod()
    union = np.maximum(0, a[2:] - a[:2]).prod() + np.maximum(0, b[2:] - b[:2]).prod() - intersection
    return float(intersection / max(union, 1e-12))


def tiles(width, height, size=320, overlap=.5):
    def starts(length):
        if length <= size:
            return [0]
        step = max(1, round(size * (1 - overlap)))
        positions = list(range(0, length - size + 1, step))
        edge = length - size
        if positions[-1] != edge:
            if len(positions) > 1 and edge - positions[-1] < step / 2:
                positions[-1] = edge
            else:
                positions.append(edge)
        return positions
    return [(x, y, min(x + size, width), min(y + size, height))
            for y in starts(height) for x in starts(width)]


def merge(predictions, threshold=.45):
    kept = []
    for candidate in sorted(predictions, key=lambda p: -p["confidence"]):
        duplicate = any(iou(candidate["xyxy"], other["xyxy"]) >=
                        (threshold if candidate["class_id"] == other["class_id"] else .85)
                        for other in kept)
        if not duplicate:
            kept.append(candidate)
    return kept


def predict(model, image, *, tiled=True, confidence=.05, device="cpu"):
    """Return boxes in original-image coordinates; never use SAM as a detection gate."""
    width, height = image.size
    regions = [(0, 0, width, height)]
    if tiled and (width > 320 or height > 320):
        regions += tiles(width, height)
    images = [image.crop(region) for region in regions]
    results = model.predict(images, imgsz=640, conf=confidence, iou=.7, rect=False,
                            max_det=300, device=device, verbose=False, batch=4)
    candidates = []
    for index, (region, result) in enumerate(zip(regions, results, strict=True)):
        ox, oy, ex, ey = region
        for box in result.boxes:
            x1, y1, x2, y2 = map(float, box.xyxy[0].tolist())
            # Overlap gives another tile a complete view of a target cut by an interior edge.
            if index and ((ox > 0 and x1 <= 3) or (oy > 0 and y1 <= 3) or
                          (ex < width and x2 >= ex - ox - 3) or
                          (ey < height and y2 >= ey - oy - 3)):
                continue
            candidates.append({
                "class_id": int(box.cls.item()), "confidence": float(box.conf.item()),
                "xyxy": [max(0., x1 + ox), max(0., y1 + oy), min(float(width), x2 + ox),
                         min(float(height), y2 + oy)], "source": "full" if not index else "tile",
            })
    return merge(candidates)


def score(predictions, truth, thresholds):
    """Micro metrics, same-class IoU >= .5, one-to-one confidence-ordered matching."""
    totals, by_class, rows = Counter(), [Counter() for _ in NAMES], []
    for name, ground_truth in truth.items():
        accepted = sorted((p for p in predictions.get(name, [])
                           if p["confidence"] >= thresholds[p["class_id"]]),
                          key=lambda p: -p["confidence"])
        used = set()
        matches = []
        for pi, prediction in enumerate(accepted):
            options = [(iou(prediction["xyxy"], gt["xyxy"]), gi)
                       for gi, gt in enumerate(ground_truth)
                       if gi not in used and gt["class_id"] == prediction["class_id"]]
            if options:
                overlap, gi = max(options)
                if overlap >= .5:
                    used.add(gi)
                    matches.append((pi, gi))
        tp, fp, fn = len(matches), len(accepted) - len(matches), len(ground_truth) - len(matches)
        totals.update(tp=tp, fp=fp, fn=fn, truth=len(ground_truth), predicted=len(accepted),
                      absolute_count_error=abs(len(accepted) - len(ground_truth)))
        for cls in range(len(NAMES)):
            correct = sum(accepted[pi]["class_id"] == cls for pi, _ in matches)
            predicted = sum(p["class_id"] == cls for p in accepted)
            actual = sum(g["class_id"] == cls for g in ground_truth)
            by_class[cls].update(tp=correct, fp=predicted - correct, fn=actual - correct,
                                 truth=actual, predicted=predicted)
        rows.append({"file_name": name, "truth": len(ground_truth), "predicted": len(accepted),
                     "tp": tp, "fp": fp, "fn": fn})

    def summarize(counts):
        counts = dict(counts)
        tp, fp, fn = (counts.get(k, 0) for k in ("tp", "fp", "fn"))
        return {**counts, "precision": tp / (tp + fp) if tp + fp else None,
                "recall": tp / (tp + fn) if tp + fn else None,
                "f1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None}

    return {"overall": {**summarize(totals),
                        "count_mae": totals["absolute_count_error"] / max(len(truth), 1)},
            "per_class": [{"name": name, **summarize(by_class[i])} for i, name in enumerate(NAMES)],
            "images": rows}
