"""Select a demo confidence threshold on validation and measure it on held-out crops."""

import argparse
from collections import defaultdict
import json
from pathlib import Path

import cv2
import numpy as np
import onnxruntime

CLASSES = ("whitefly", "black_aphid")


def overlaps(box, others):
    top_left = np.maximum(box[:2], others[:, :2])
    bottom_right = np.minimum(box[2:], others[:, 2:])
    intersection = np.maximum(bottom_right - top_left, 0).prod(axis=1)
    union = (box[2:] - box[:2]).prod() + (others[:, 2:] - others[:, :2]).prod(axis=1) - intersection
    return intersection / np.maximum(union, 1e-8)


def select(output, threshold):
    classes = output[:, 5:].argmax(axis=1)
    scores = output[:, 4] * output[:, 5:].max(axis=1)
    minimum = np.asarray(threshold)[classes] if isinstance(threshold, (list, tuple)) else threshold
    valid = ((scores >= minimum) & (scores <= 1)
             & ((output[:, :2] >= 0) & (output[:, :2] < 416)).all(axis=1)
             & (output[:, 2:4] > 0).all(axis=1))
    indexes = np.flatnonzero(valid)
    centers = output[indexes, :2]
    half_sizes = output[indexes, 2:4] / 2
    boxes = np.clip(np.column_stack((centers - half_sizes, centers + half_sizes)), 0, 416)
    labels = classes[indexes]
    order = np.argsort(-scores[indexes], kind="stable")[:1200]
    kept = [[], []]
    while len(order) and sum(map(len, kept)) < 300:
        first, others = order[0], order[1:]
        kept[labels[first]].append(boxes[first])
        duplicate_thresholds = np.where(labels[first] == labels[others], 0.45, 0.85)
        order = others[overlaps(boxes[first], boxes[others]) < duplicate_thresholds]
    return kept


def read_split(runtime, root, split):
    metadata = json.loads((root / "annotations" / f"{split}.json").read_text(encoding="utf-8"))
    ground_truth = defaultdict(lambda: [[], []])
    for row in metadata["annotations"]:
        x, y, width, height = row["bbox"]
        ground_truth[row["image_id"]][row["category_id"] - 1].append((x, y, x + width, y + height))
    data = []
    input_name = runtime.get_inputs()[0].name
    for row in metadata["images"]:
        path = root / f"{split}2017" / row["file_name"]
        image = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None or image.shape != (416, 416, 3):
            raise ValueError(f"Expected a 416×416 crop: {path}")
        tensor = np.ascontiguousarray(image.transpose(2, 0, 1)[None], dtype=np.float32)
        output = runtime.run(None, {input_name: tensor})[0][0]
        if output.shape != (3549, 7) or not np.isfinite(output).all():
            raise ValueError("Unexpected YOLOX output.")
        boxes = [np.asarray(group, dtype=np.float32).reshape((-1, 4)) for group in ground_truth[row["id"]]]
        data.append((output, boxes))
    return data


def score(data, threshold):
    counts = np.zeros((2, 3), dtype=int)
    absolute_error = 0
    for output, boxes in data:
        predicted_count = 0
        actual_count = sum(len(group) for group in boxes)
        for label, (actual, predictions) in enumerate(zip(boxes, select(output, threshold), strict=True)):
            predicted_count += len(predictions)
            used = set()
            for prediction in predictions:
                candidates = overlaps(prediction, actual)
                match = next((int(i) for i in np.argsort(-candidates) if candidates[i] >= 0.5 and i not in used), None)
                if match is not None:
                    used.add(match)
            counts[label] += len(used), len(predictions) - len(used), len(actual) - len(used)
        absolute_error += abs(predicted_count - actual_count)
    result = {}
    for label, (tp, fp, fn) in zip(CLASSES, counts.tolist(), strict=True):
        result[label] = {
            "precision": tp / max(tp + fp, 1),
            "recall": tp / max(tp + fn, 1),
            "f1": 2 * tp / max(2 * tp + fp + fn, 1),
            "truth": tp + fn,
            "true_positives": tp,
            "false_positives": fp,
            "false_negatives": fn,
        }
    return {"images": len(data), "count_mae": absolute_error / len(data), "classes": result}


def precision_rank(item):
    precision, recall = item["precision"], item["recall"]
    return 1.25 * precision * recall / max(0.25 * precision + recall, 1e-8)


def tune_precision(validation, baseline):
    candidates = {
        threshold: score(validation, threshold)["classes"]
        for threshold in (0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65)
    }
    floors = {label: baseline["classes"][label]["recall"] * 0.75 for label in CLASSES}
    chosen = []
    for label in CLASSES:
        eligible = [
            threshold for threshold, classes in candidates.items()
            if classes[label]["recall"] >= floors[label]
            and classes[label]["precision"] >= baseline["classes"][label]["precision"]
        ]
        if not eligible:
            return None
        chosen.append(max(eligible, key=lambda threshold: precision_rank(candidates[threshold][label])))
    result = score(validation, chosen)
    if any(result["classes"][label]["recall"] < floors[label]
           or result["classes"][label]["precision"] < baseline["classes"][label]["precision"] for label in CLASSES):
        return None
    return chosen, result


def precision_comparison(model, baseline, root, options):
    original = onnxruntime.InferenceSession(str(baseline), sess_options=options, providers=["CPUExecutionProvider"])
    refined = onnxruntime.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])
    old_validation = read_split(original, root, "val")
    old_scores = score(old_validation, 0.30)
    variants = {}
    for name, data, runtime in (("baseline", old_validation, original), ("refined", read_split(refined, root, "val"), refined)):
        tuned = tune_precision(data, old_scores)
        if tuned:
            thresholds, val = tuned
            variants[name] = (thresholds, val, runtime)
    if not variants:
        raise ValueError("No calibrated model met the validation guardrails.")
    name = max(variants, key=lambda item: sum(precision_rank(row) for row in variants[item][1]["classes"].values()))
    thresholds, val, runtime = variants[name]
    original_test = read_split(original, root, "test")
    selected_test = original_test if name == "baseline" else read_split(runtime, root, "test")
    return {
        "selected_model": name,
        "confidence_thresholds": dict(zip(CLASSES, thresholds, strict=True)),
        "iou_threshold": 0.45,
        "validation": val,
        "validation_candidates": {key: {"thresholds": value[0], "metrics": value[1]} for key, value in variants.items()},
        "test": score(selected_test, thresholds),
        "baseline_test": score(original_test, 0.30),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", type=Path)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("metrics", type=Path)
    parser.add_argument("--precision-baseline", type=Path)
    args = parser.parse_args()
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 4
    if args.precision_baseline:
        result = precision_comparison(args.model, args.precision_baseline, args.dataset, options)
    else:
        runtime = onnxruntime.InferenceSession(str(args.model), sess_options=options, providers=["CPUExecutionProvider"])
        validation = read_split(runtime, args.dataset, "val")
        candidates = {threshold: score(validation, threshold) for threshold in (0.15, 0.20, 0.25, 0.30, 0.35, 0.45, 0.55)}
        threshold = max(candidates, key=lambda value: sum(item["f1"] for item in candidates[value]["classes"].values()))
        test = score(read_split(runtime, args.dataset, "test"), threshold)
        result = {"confidence_threshold": threshold, "iou_threshold": 0.45, "validation": candidates[threshold], "test": test}
    args.metrics.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
