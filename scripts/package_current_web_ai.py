"""Package the two current web detectors and inference contract for model review."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
AI = ROOT / "infra/cloudflare/ai"
OUT = ROOT / "deliverables/PTIT_AI_Dang_Chay_Web.zip"
PREFIX = "PTIT_AI_Dang_Chay_Web"


def main():
    config = json.loads((AI / "model.json").read_text(encoding="utf-8"))
    generic_weights = {
        "03244ece87370b4b4f09c7950a5e8128aa1e0681ff3956d9d034e90de037c0e4": ROOT / "deliverables/PTIT_Camera_Recall_20261109/PTIT_Camera_Recall_best.pt",
        "56593aaff227d6a27907dedb7a89ca0eddb35a73fa026d0d92a3ec923bfe03e0": ROOT / "deliverables/PTIT_P2_CaiThien_20261109/models/PTIT_InsectDetector_P2_CaiThien_v1.pt",
        "57363c7f10f8b8da771694c218849e1ceb3c10725665ba039bc322f2129b0a7a": ROOT / "deliverables/PTIT_InsectDetector_v1.pt",
    }.get(config["insect_sha256"])
    if generic_weights is None:
        raise ValueError("No matching PyTorch checkpoint registered for current web ONNX")
    files = {
        f"models/{generic_weights.name}": generic_weights,
        "models/PTIT_Trap_6Loai_CaiThien_v1.pt": ROOT / "deliverables/PTIT_Trap_6Loai_CaiThien_v1.pt",
        "model.json": AI / "model.json",
        "species-evaluation.json": ROOT / "deliverables/PTIT_Trap_6Loai_CaiThien_v1.json",
        "inference/insect-core.js": AI / "insect-core.js",
        "inference/ai-inference.js": ROOT / "infra/cloudflare/dashboard/ai-inference.js",
        "inference/test-insect-core.cjs": ROOT / "infra/cloudflare/ai-tools/test-insect-core.cjs",
        "LICENSE-DATA.json": AI / "LICENSE-DATA.json",
        "demo.json": AI / "demo.json",
    }
    for kind in ("insect", "species"):
        filename = config[f"{kind}_model"]
        path = AI / filename
        if hashlib.sha256(path.read_bytes()).hexdigest() != config[f"{kind}_sha256"]:
            raise ValueError("Current ONNX model hash mismatch")
        files[f"onnx/{filename}"] = path
    for path in sorted((AI / "demo").glob("*.jpg")):
        files[f"sample-images/{path.name}"] = path
    for path in sorted((AI / "licenses").glob("*")):
        if path.is_file():
            files[f"licenses/{path.name}"] = path
    # This test uses the same core but a package-relative import location.
    test_source = files.pop("inference/test-insect-core.cjs").read_text(encoding="utf-8")
    test_source = test_source.replace("require('../ai/insect-core.js')", "require('./insect-core.js')")
    hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}
    guide = f"""GÓI MODEL ĐANG CHẠY TRÊN WEB PTIT GARDEN

Gửi nguyên file ZIP này cho người kiểm tra. Đây là luồng hai model, phiên bản ghi trong model.json.

1. models/{generic_weights.name}
   YOLO một lớp 'insect': phát hiện côn trùng nói chung. Ngưỡng hiện tại {config['insect_threshold']:.3f}.
2. models/PTIT_Trap_6Loai_CaiThien_v1.pt
   YOLO sáu loài: gợi ý loài khi confidence >= 0.70 và chênh lệch hai lớp cao nhất >= 0.15.
   Thứ tự lớp chính xác nằm trong model.json.
3. onnx/
   Hai bản xuất ONNX đang được trình duyệt sử dụng, tên giữ nguyên theo SHA-256.
4. inference/
   Mã xử lý thực tế: RGB/255, letterbox 640 với nền 114, ảnh toàn cảnh + ô 320 chồng lấn,
   loại khung sát mép ô và gộp khung trùng. Khung từ bộ phát hiện côn trùng chưa ghép được
   loài đủ tin cậy được ghi 'unknown' và vẫn được đếm. Không biến mọi dự đoán yếu thành côn trùng.
5. sample-images/
   Ba ảnh mẫu để trao đổi và kiểm tra. Nguồn và giấy phép có trong LICENSE-DATA.json.

XEM THÔNG TIN WEIGHTS BẰNG PYTHON
   pip install ultralytics==8.4.203
   python -c "from ultralytics import YOLO; m=YOLO('models/{generic_weights.name}'); print(m.names); m.info()"
   python -c "from ultralytics import YOLO; m=YOLO('models/PTIT_Trap_6Loai_CaiThien_v1.pt'); print(m.names); m.info()"

KIỂM TRA LOGIC GỘP KHUNG (Node.js)
   node inference/test-insect-core.cjs

LƯU Ý KHI SO SÁNH
   Chạy YOLO trực tiếp trên một ảnh toàn cảnh chưa tái hiện toàn bộ luồng trên web.
   ai-inference.js là Web Worker của trang web, cần ONNX Runtime Web 1.22.0 và máy chủ
   phục vụ các đường dẫn /static/ai/...; không chạy trực tiếp file đó bằng Python/Node.
   Gói này dành cho kiểm tra model và mã xử lý, không bao gồm toàn bộ website/backend.

   generic_test trong model.json là chỉ số của bộ phát hiện một lớp trên 197 ảnh kiểm thử
   công khai, không phải độ chính xác của cả luồng ghép hai model hoặc ảnh ESP32-CAM thực tế.
   Chỉ số sáu loài và giới hạn đánh giá nằm trong species-evaluation.json.
   Chưa bao gồm bộ dữ liệu huấn luyện; cần dữ liệu gán nhãn riêng nếu muốn huấn luyện tiếp.
   Các model vẫn có thể bỏ sót côn trùng nhỏ và nhầm rác bẫy. Không coi kết quả là xác nhận loài.

Không có token thiết bị, mật khẩu, khóa Cloudflare hoặc dữ liệu tài khoản trong gói này.
"""
    with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, path in files.items():
            archive.write(path, f"{PREFIX}/{name}")
        archive.writestr(f"{PREFIX}/inference/test-insect-core.cjs", test_source)
        archive.writestr(f"{PREFIX}/HUONG_DAN.txt", guide)
        archive.writestr(f"{PREFIX}/SHA256.json", json.dumps(hashes, indent=2))
    with zipfile.ZipFile(OUT) as archive:
        assert archive.testzip() is None
        for name, digest in hashes.items():
            assert hashlib.sha256(archive.read(f"{PREFIX}/{name}")).hexdigest() == digest
    print(f"Prepared {len(files)} source/model files, guide, checksums and inference tests; {OUT.stat().st_size / 1024**2:.1f} MiB.")


if __name__ == "__main__":
    main()
