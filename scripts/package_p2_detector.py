"""Export, verify and package the improved P2 checkpoint and comparison report."""
from __future__ import annotations

import argparse
from importlib.metadata import version
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import zipfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from improve_p2_detector import ROOT, digest, dump

NAME = "PTIT_P2_CaiThien_20261109"


def export(args):
    import cv2
    import onnx
    import onnxruntime as ort
    import torch
    from ultralytics import YOLO

    torch.set_num_threads(4)
    weights = args.work / "runs/p2/weights/best.pt"
    model = YOLO(str(weights))
    exported = Path(model.export(format="onnx", imgsz=640, batch=1, opset=17,
                                 dynamic=False, simplify=False, device="cpu", nms=False))
    onnx.checker.check_model(onnx.load(str(exported)))
    options = ort.SessionOptions(); options.intra_op_num_threads = 2
    session = ort.InferenceSession(str(exported), sess_options=options, providers=["CPUExecutionProvider"])
    selection = json.loads((args.work / "selection-before-test.json").read_text())
    rows = json.loads((args.work / "manifest.json").read_text())["photos"]
    selected = selection["illustration_images_selected_before_test"]
    parity = []
    for filename in selected:
        row = next(r for r in rows if r["file_name"] == filename)
        bgr = cv2.imread(row["path"]); h, w = bgr.shape[:2]
        ratio = min(640/w, 640/h); nw, nh = round(w*ratio), round(h*ratio)
        resized = cv2.resize(bgr, (nw, nh)); left, top = (640-nw)//2, (640-nh)//2
        canvas = np.full((640, 640, 3), 114, np.uint8); canvas[top:top+nh, left:left+nw] = resized
        tensor = np.ascontiguousarray(canvas[:, :, ::-1].transpose(2, 0, 1)[None], dtype=np.float32)/255
        model.model.eval()
        with torch.inference_mode():
            expected = model.model(torch.from_numpy(tensor))[0].numpy()
        actual = session.run(None, {session.get_inputs()[0].name: tensor})[0]
        if not np.isfinite(actual).all() or not np.isfinite(expected).all():
            raise AssertionError(f"Non-finite model output: {filename}")
        box_error = float(np.max(np.abs(expected[:, :4] - actual[:, :4])))
        score_error = float(np.max(np.abs(expected[:, 4:] - actual[:, 4:])))
        if actual.shape != (1, 5, 34000) or box_error > .1 or score_error > .001:
            raise AssertionError(f"ONNX mismatch: {filename}: {box_error}, {score_error}")
        parity.append({"image": filename, "box_max_abs_error_px": box_error, "score_max_abs_error": score_error})
        if len(parity) == 1:
            tensor.tofile(args.work / "web-input.f32")
            dump(args.work / "web-expected.json", {"dims": list(actual.shape),
                                                   "max_score": float(actual[:, 4:].max())})
    dump(args.work / "onnx-parity.json", {"onnx": str(exported), "sha256": digest(exported),
                                         "input_shape": session.get_inputs()[0].shape,
                                         "output_shape": session.get_outputs()[0].shape,
                                         "samples": parity})
    dump(args.work / "environment.json", {
        "python": sys.version,
        "packages": {name: version(name) for name in ("torch", "ultralytics", "numpy", "opencv-python", "onnx", "onnxruntime", "matplotlib")},
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "cuda": torch.version.cuda,
    })
    print("ONNX PASS", json.dumps(parity), flush=True)


def illustrations(args, report, target):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.size": 11, "axes.spines.top": False, "axes.spines.right": False})
    labels = ["V1", "P2 improved"]
    colors = ["#64748b", "#0891b2"]
    fig, axes = plt.subplots(1, 3, figsize=(12, 3.6), layout="constrained")
    metrics = report["models"]
    x = np.arange(3)
    for index, label in enumerate(("v1", "p2_improved")):
        values = [metrics[label]["test"][k] * 100 for k in ("precision", "recall", "f1")]
        bars = axes[0].bar(x + (index-.5)*.36, values, .36, label=labels[index], color=colors[index])
        axes[0].bar_label(bars, fmt="%.1f", fontsize=9)
    axes[0].set_xticks(x, ["Precision", "Recall", "F1"]); axes[0].set_ylim(0, 110)
    axes[0].set_ylabel("%"); axes[0].legend(frameon=False, loc="upper right")
    axes[0].set_title("197 held-out trap photos")
    for ax, key, title in ((axes[1], "count_mae", "Count MAE (lower is better)"),
                            (axes[2], "latency", "GPU ms/photo (lower is better)")):
        values = [metrics[label]["test"][key] if key != "latency" else metrics[label]["timing_ms"]["median"]
                  for label in ("v1", "p2_improved")]
        bars = ax.bar(labels, values, color=colors, width=.55)
        ax.bar_label(bars, fmt="%.2f", padding=3); ax.set_ylim(0, max(values)*1.25)
        ax.set_title(title)
    fig.savefig(target / "comparison.png", dpi=180); plt.close(fig)
    manifest = json.loads((args.work / "manifest.json").read_text())["photos"]
    predictions = {label: json.loads((args.work / f"{label}-test-predictions.json").read_text())["predictions"]
                   for label in ("v1", "p2_improved")}
    font_path = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/arial.ttf"
    font = ImageFont.truetype(str(font_path), 21) if font_path.exists() else ImageFont.load_default()
    outputs = []
    for index, filename in enumerate(report["selection"]["illustration_images_selected_before_test"], 1):
        row = next(r for r in manifest if r["file_name"] == filename)
        with Image.open(row["path"]) as f:
            original = f.convert("RGB")
        width, height = original.size
        canvas = Image.new("RGB", (width*3, height+86), "#0f172a")
        draw = ImageDraw.Draw(canvas)
        for column, label in enumerate(("truth", "v1", "p2_improved")):
            canvas.paste(original, (column*width, 86))
            if label == "truth":
                boxes = row["boxes"]; title = f"Source labels: {len(boxes)} insects"
            else:
                threshold = report["models"][label]["threshold"]
                boxes = [p for p in predictions[label][filename] if p["confidence"] >= threshold]
                item = next(r for r in report["models"][label]["images"] if r["file_name"] == filename)
                title = f"{labels[column-1]}: {len(boxes)} insects"
                draw.text((column*width+12, 45), f"TP {item['tp']} / FP {item['fp']} / FN {item['fn']}", font=font, fill="white")
            draw.text((column*width+12, 12), title, font=font, fill="white")
            for box in boxes:
                x1, y1, x2, y2 = box["xyxy"]
                draw.rectangle((x1+column*width, y1+86, x2+column*width, y2+86),
                               outline="#22c55e" if label == "truth" else "#fbbf24", width=2)
        name = f"example-{index}.jpg"; canvas.save(target / name, quality=92)
        outputs.append({"file": name, "source": filename})
    return outputs


def package(args):
    report = json.loads((args.work / "comparison.json").read_text(encoding="utf-8"))
    parity = json.loads((args.work / "onnx-parity.json").read_text())
    target = ROOT / "deliverables" / NAME
    if target.exists() and not args.refresh:
        raise FileExistsError(f"Release exists; inspect before replacing: {target}")
    if target.is_symlink():
        raise ValueError("Release directory must not be a symlink")
    for folder in ("models", "onnx", "inference", "evaluation", "scripts"):
        (target / folder).mkdir(parents=True, exist_ok=True)
    for source, destination in (
        (args.work / "runs/p2/weights/best.pt", target / "models/PTIT_InsectDetector_P2_CaiThien_v1.pt"),
        (ROOT / "deliverables/PTIT_InsectDetector_v1.pt", target / "models/PTIT_InsectDetector_v1.pt"),
    ):
        shutil.copy2(source, destination)
    name = f"model-{parity['sha256'][:12]}.onnx"
    shutil.copy2(parity["onnx"], target / "onnx" / name)
    config = json.loads((ROOT / "infra/cloudflare/ai/model.json").read_text())
    shutil.copy2(ROOT / "infra/cloudflare/ai" / config["species_model"], target / "onnx" / config["species_model"])
    config.update(model_version="ptit-insects-p2-preserved-20261109-v1", insect_model=name,
                  insect_sha256=parity["sha256"], insect_threshold=report["models"]["p2_improved"]["threshold"],
                  generic_validation=report["selection"]["models"]["p2_improved"]["chosen"],
                  generic_test=report["models"]["p2_improved"]["test"],
                  architecture="YOLOv8n preserved P3/P4/P5 + parallel P2 (stride4), 34000 points",
                  comparison_scope=report["scope"])
    dump(target / "model.json", config)
    core = (ROOT / "infra/cloudflare/ai/insect-core.js").read_text()
    core = core.replace("const rows=8400;", "const rows=output?.dims?.[2];")
    core = core.replace("output.dims[2]!==rows", "![8400,34000].includes(rows)")
    (target / "inference/insect-core.js").write_text(core, encoding="utf-8")
    shutil.copy2(ROOT / "infra/cloudflare/dashboard/ai-inference.js", target / "inference/ai-inference.js")
    test = (ROOT / "infra/cloudflare/ai-tools/test-insect-core.cjs").read_text().replace("require('../ai/insect-core.js')", "require('./insect-core.js')")
    test += """\nconst p2data=new Float32Array(5*34000);
p2data[0]=320;p2data[34000]=320;p2data[68000]=40;p2data[102000]=60;p2data[136000]=.8;
const p2=core.decode({dims:[1,5,34000],data:p2data},{x:20,y:30,width:320,height:320,full:false},{left:0,top:0,ratio:2},1,.7,{width:640,height:485});
assert.equal(p2.length,1);assert.equal(p2[0].x1,170);assert.equal(p2[0].y1,175);
assert.throws(()=>core.decode({dims:[1,5,34560],data:p2data},{},{},1,.7,{}));
console.log('PASS P2 34000 projection and unsupported shape rejection');
"""
    (target / "inference/test-insect-core.cjs").write_text(test, encoding="utf-8")
    subprocess.run(["node", "inference/test-insect-core.cjs"], cwd=target, check=True)
    for filename in ("comparison.json", "comparison-per-image.csv", "selection-before-test.json",
                     "dataset-audit.json", "transfer-audit.json", "onnx-parity.json", "environment.json"):
        shutil.copy2(args.work / filename, target / "evaluation" / filename)
    if (args.work / "onnx-web-verification.json").exists():
        shutil.copy2(args.work / "onnx-web-verification.json", target / "evaluation/onnx-web-verification.json")
    for filename in ("improve_p2_detector.py", "compare_p2_detectors.py", "package_p2_detector.py", "trap_detector.py"):
        shutil.copy2(ROOT / "scripts" / filename, target / "scripts" / filename)
    shutil.copy2(ROOT / "scripts/verify_p2_onnx_web.cjs", target / "scripts/verify_p2_onnx_web.cjs")
    shutil.copy2(args.work / "runs/p2/results.csv", target / "evaluation/training-results.csv")
    shutil.copy2(args.work / "runs/p2/args.yaml", target / "evaluation/training-args.yaml")
    shutil.copy2(args.work / "yolov8n-p2-preserved.yaml", target / "models/yolov8n-p2-preserved.yaml")
    for name in ("LICENSE-DATA.json",):
        shutil.copy2(ROOT / "infra/cloudflare/ai" / name, target / name)
    shutil.copytree(ROOT / "infra/cloudflare/ai/licenses", target / "licenses", dirs_exist_ok=True)
    examples = illustrations(args, report, target)
    a, b = report["models"]["v1"], report["models"]["p2_improved"]
    f1_change = (b["test"]["f1"] - a["test"]["f1"]) * 100
    mae_change = b["test"]["count_mae"] - a["test"]["count_mae"]
    verdict = ("P2 tốt hơn trên cả F1 và sai số đếm của tập kiểm thử này."
               if f1_change > 0 and mae_change < 0 else
               "Kết quả có đánh đổi; chưa thể kết luận P2 tốt hơn toàn diện bản 1.")
    lines = ["# So sánh bản 1 và P2 cải thiện — 09/11/2026", "",
             verdict + f" Chênh lệch F1: {f1_change:+.2f} điểm phần trăm; MAE: {mae_change:+.2f} con/ảnh.", "",
             "Đã huấn luyện lại P2 bằng nhãn nguồn, giữ các nhánh P3/P4/P5 đã học và bổ sung nhánh P2. "
             "Đây là bộ phát hiện một lớp côn trùng; bộ nhận diện sáu loài giữ nguyên. Chưa thay model trên web.", "",
             "Tập đánh giá: 197 ảnh bẫy, 2.445 box nhãn nguồn; train/validation/test không trùng ảnh chính xác. "
             "Chọn checkpoint và ngưỡng bằng validation trước khi mở test trong lần chạy này. "
             "Tập test này đã xuất hiện trong báo cáo bản 1 trước đây, chưa phải bộ ảnh thực địa mới.", "",
             "| Chỉ số | Bản 1 | P2 cải thiện |", "|---|---:|---:|"]
    for title, key, scale in (("Precision", "precision", 100), ("Recall", "recall", 100),
                               ("F1", "f1", 100), ("Sai số đếm MAE (con/ảnh)", "count_mae", 1)):
        suffix = "%" if scale == 100 else ""
        lines.append(f"| {title} | {a['test'][key]*scale:.2f}{suffix} | {b['test'][key]*scale:.2f}{suffix} |")
    lines += [f"| Ngưỡng chọn từ validation | {a['threshold']:.3f} | {b['threshold']:.3f} |",
              f"| Trung vị thời gian GPU (ms/ảnh, có cắt ô) | {a['timing_ms']['median']:.1f} | {b['timing_ms']['median']:.1f} |", "",
              "Precision là tỷ lệ khung dự đoán khớp nhãn nguồn; recall là tỷ lệ cá thể trong nhãn nguồn được tìm thấy. "
              "MAE là trung bình độ lệch tuyệt đối của số đếm theo ảnh. Các chỉ số này không phải xác suất đúng của mỗi dự đoán.", "",
              "![So sánh](comparison.png)", "", "## Giới hạn", "",
              "Nhãn công khai có thể thiếu côn trùng nhỏ, chưa được chuyên gia xác minh độc lập. "
              "Các nhóm theo tên ảnh chưa được chứng minh là ngày hoặc bẫy độc lập. "
              "Precision/recall trên đây đánh giá detector một lớp bằng PyTorch FP32 trên RTX 4050; "
              "không phải độ chính xác phân loại sáu loài, toàn bộ pipeline hai model hoặc tốc độ trình duyệt. "
              "mAP toàn ảnh, chỉ số cùng ngưỡng 0.55 và recall theo kích thước có trong evaluation/comparison.json.", "",
              "## Sử dụng", "",
              "Model mới: models/PTIT_InsectDetector_P2_CaiThien_v1.pt. ONNX và model.json dùng RGB /255, "
              "letterbox 640, nền 114. Gói có core suy luận hỗ trợ cả 8400/34000 điểm; "
              "không chép riêng ONNX vào core cũ chỉ hỗ trợ 8400. Đây là gói AI để tích hợp, không phải website độc lập. "
              "Giữ ONNX Runtime Web 1.22.0, model nhận diện sáu loài và ngưỡng loài 0.70/margin 0.15 như bản hiện tại.", "",
              "Chạy test: `node inference/test-insect-core.cjs`. Mã huấn luyện/so sánh trong scripts, "
              "môi trường chạy: Ultralytics 8.4.203, torch 2.7.1+cu126; dữ liệu/cache nằm ngoài OneDrive. "
              "NWD chưa được tích hợp; không công bố tính năng đó.", "",
              "## Ví dụ được chọn trước khi đo test", ""]
    fixed_a, fixed_b = a["fixed_055"], b["fixed_055"]
    lines[lines.index("## Giới hạn"):lines.index("## Giới hạn")] = [
        "Ở cùng ngưỡng cố định 0,55 đã đặt trước phép đo, precision bản 1/P2 lần lượt "
        f"là {fixed_a['precision']*100:.2f}% / {fixed_b['precision']*100:.2f}%, "
        f"recall {fixed_a['recall']*100:.2f}% / {fixed_b['recall']*100:.2f}%, "
        f"F1 {fixed_a['f1']*100:.2f}% / {fixed_b['f1']*100:.2f}%, "
        f"MAE {fixed_a['count_mae']:.2f} / {fixed_b['count_mae']:.2f} con/ảnh. "
        "Cải thiện không chỉ đến từ việc hạ ngưỡng.", "",
        "Recall với box có căn diện tích dưới 32 pixel ở ảnh nguồn: "
        f"{a['size_recall']['small_under_32px']['recall']*100:.2f}% → "
        f"{b['size_recall']['small_under_32px']['recall']*100:.2f}%.", "",
    ]
    for example in examples:
        lines += [example["source"], f"![Ví dụ]({example['file']})", ""]
    web_report = args.work / "onnx-web-verification.json"
    if web_report.exists():
        web = json.loads(web_report.read_text())["models"]
        lines += ["## Kiểm tra WebAssembly", "",
                  f"ONNX Runtime Web 1.22.0, một luồng, chạy trong Node trên cùng một tensor 640×640: "
                  f"trung vị bản 1 {web['v1']['median_inference_ms']:.1f} ms, "
                  f"P2 {web['p2_improved']['median_inference_ms']:.1f} ms. "
                  "Đã làm nóng 4 lượt rồi đo 8 lượt. Đây là một lượt chạy detector; "
                  "chưa gồm toàn bộ các ô ảnh, model sáu loài, tải mạng và giao diện trình duyệt. "
                  "Thời gian WASM dao động đáng kể trong lần đo; cần đo lại toàn luồng trên máy demo để chốt độ trễ thực tế.", ""]
    lines += ["## Tài liệu kỹ thuật", "",
              "- [Kiến trúc P2 tham khảo của Ultralytics](https://github.com/ultralytics/ultralytics/blob/main/ultralytics/cfg/models/v8/yolov8-p2.yaml)",
              "- [Ultralytics Train](https://docs.ultralytics.com/modes/train/)", ""]
    (target / "BAO_CAO.md").write_text("\n".join(lines), encoding="utf-8")
    hashes = {p.relative_to(target).as_posix(): digest(p) for p in target.rglob("*") if p.is_file() and p.name != "SHA256.json"}
    dump(target / "SHA256.json", hashes)
    archive = ROOT / "deliverables" / f"{NAME}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in sorted(target.rglob("*")):
            if p.is_file():
                z.write(p, f"{NAME}/{p.relative_to(target).as_posix()}")
    with zipfile.ZipFile(archive) as z:
        if z.testzip() is not None:
            raise AssertionError("Corrupt release archive")
    print("RELEASE", target, "ZIP", archive, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("export", "package"))
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--refresh", action="store_true", help="Regenerate this release in place; do not delete files")
    args = parser.parse_args(); args.work = args.work.resolve()
    os.environ["YOLO_CONFIG_DIR"] = str(args.work / "settings")
    os.environ["YOLO_AUTOINSTALL"] = "false"
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    globals()[args.action](args)


if __name__ == "__main__":
    main()
