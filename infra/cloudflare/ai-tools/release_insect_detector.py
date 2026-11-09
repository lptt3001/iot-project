"""Select a generic-insect threshold on validation only, evaluate test, export web assets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "scripts"))
from trap_detector import predict, score, NAMES


def main(work):
    os.environ["YOLO_CONFIG_DIR"] = str(work / "settings")
    os.environ["YOLO_AUTOINSTALL"] = "false"
    import torch
    from PIL import Image
    from ultralytics import YOLO
    torch.set_num_threads(4)
    weights = work / "runs/insects/weights/best.pt"
    model = YOLO(str(weights))
    rows = json.loads((work / "manifest.json").read_text(encoding="utf-8"))["photos"]

    def infer(split):
        cache = work / f"{split}-predictions.json"
        if cache.exists():
            predictions = json.loads(cache.read_text())
        else:
            predictions = {}
            for index, row in enumerate(r for r in rows if r["split"] == split):
                with Image.open(row["path"]) as image:
                    predictions[row["file_name"]] = predict(model, image.convert("RGB"), confidence=.05, device=0)
                if index % 20 == 0:
                    print(split, index, flush=True)
            cache.write_text(json.dumps(predictions), encoding="utf-8")
        truth = {r["file_name"]: r["boxes"] for r in rows if r["split"] == split}
        return predictions, truth

    predictions, truth = infer("val")
    evaluations = []
    for value in range(20, 96, 5):
        threshold = value / 100
        result = score(predictions, truth, [threshold]*len(NAMES))["overall"]
        p, r = result["precision"] or 0, result["recall"] or 0
        evaluations.append({"threshold": threshold, **result, "f05": 1.25*p*r/(.25*p+r) if p+r else 0})
    eligible = [r for r in evaluations if r["precision"] is not None and r["precision"] >= .7]
    chosen = max(eligible, key=lambda r: (r["recall"], r["precision"])) if eligible else max(evaluations,key=lambda r:r["f05"])
    selection = {"rule": "Prefer validation precision >= .70, maximize recall; otherwise maximize F0.5. IoU >= .5, tiled, class-agnostic.",
                 "weights_sha256": hashlib.sha256(weights.read_bytes()).hexdigest(), "chosen": chosen, "validation": evaluations}
    # Freeze selection before opening the test partition.
    (work / "selection-before-test.json").write_text(json.dumps(selection,indent=2),encoding="utf-8")
    print("SELECTED", chosen, flush=True)
    predictions, truth = infer("test")
    metrics = score(predictions,truth,[chosen["threshold"]]*len(NAMES))
    (work / "test-metrics.json").write_text(json.dumps(metrics,indent=2),encoding="utf-8")
    print("TEST", metrics["overall"], flush=True)
    exported = Path(model.export(format="onnx",imgsz=640,batch=1,opset=17,dynamic=False,simplify=False,device="cpu"))
    assets = ROOT / "infra/cloudflare/ai"
    def copy_model(path):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        filename = f"model-{digest[:12]}.onnx"
        if path.resolve() != (assets/filename).resolve():
            shutil.copy2(path,assets/filename)
        return filename,digest
    insect, insect_hash = copy_model(exported)
    current = json.loads((assets / "model.json").read_text(encoding="utf-8"))
    species, species_hash = copy_model(assets / current["species_model"])
    manifest = {"model_version": "ptit-insects-six-species-20261108-v1", "classes": list(NAMES),
                "insect_model": insect,"insect_sha256": insect_hash,"insect_threshold": chosen["threshold"],
                "species_model":species,"species_sha256":species_hash,"species_threshold":.7,"species_margin":.15,
                "input": "RGB float32 /255; 640 square letterbox114; full+320 tiles; NMS.45",
                "generic_validation": chosen,"generic_test": metrics["overall"],
                "limitations": "Experimental; incomplete annotations, unknown species and debris can be missed or confused. Not calibrated probability. Not a plant disease diagnosis.",
                "training_data": {"name":"RicePest-30 + six-species replay", "url":"https://github.com/kkb20334-lang/RicePest-30", "license":"CC BY-NC 4.0", "commit":"206e0a990edb99efa75ca7beb9d5f1243c807c0d"}}
    (assets/"model.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding="utf-8")
    print("ASSETS", insect, species, flush=True)


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work",required=True,type=Path)
    main(parser.parse_args().work.resolve())
