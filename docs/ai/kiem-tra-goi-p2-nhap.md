# Kiểm tra gói AI nhập ngày 09/11/2026

**Kết luận: chưa đạt điều kiện thay model trên web. Không triển khai checkpoint P2 mới.**

Gói nguồn được chuyển từ thư mục gốc `PTIT_AI_Dang_Chay_Web` vào `deliverables/AI_Nhap_20261109`. Đối chiếu SHA-256 xác nhận giữ nguyên toàn bộ 118 tệp nguồn, tổng 665.691.000 byte. Tài liệu này được thêm sau khi đối chiếu. Thư mục mã/model bên trong là `PTIT_AI_Dang_Chay_Web/`.

## Chạy thực tế

Model mới: `onnx/model-decf618d72b0.onnx` (12.455.634 byte), SHA-256 `decf618d72b08b7e59a04a544480a6b3661b247439928af6ce18b9a0b6d4d23e`.

| Ảnh mẫu | Điểm côn trùng cao nhất của P2 nhập mới | P2 đang phục vụ web |
| --- | ---: | ---: |
| cn_01.jpg | 0.012881 | 0.813332 |
| os_01.jpg | 0.012810 | 0.826937 |
| pl_01.jpg | 0.012766 | 0.637261 |

Bảng dùng cùng ảnh gốc toàn cảnh, letterbox 640, RGB /255 và ONNX Runtime CPU. Điểm model không phải xác suất đúng đã hiệu chuẩn; số điểm/khung không chứng minh độ chính xác.

Quét thêm toàn cảnh + vùng 320 px (bước 160) + vùng 160 px (bước 100), với cả ảnh gốc và ảnh qua LAB CLAHE + bilateral + unsharp theo script nhập: **240 lượt suy luận trên 3 ảnh, không có ứng viên nào đạt 0,25**. Ngưỡng trong cấu hình gói là 0,38 nên cũng không thể tạo khung. Không hạ ngưỡng xuống khoảng 0,01 để tạo khung không đáng tin.

File `models/PTIT_InsectDetector_P2_best.pt` cũng được chạy trực tiếp bằng PyTorch trên cả ba ảnh. Điểm cao nhất tương đương ONNX; sai số điểm lớn nhất giữa hai bản dưới 0,000001. Vì vậy lỗi không nằm riêng ở bước xuất ONNX; cần sửa/huấn luyện lại checkpoint.

## Những điểm trong gói cần sửa

- Hai lần train đều ghi precision, recall, mAP50 và mAP50-95 bằng 0. Không dùng số lượng đầu P2/điểm dự đoán để suy ra chất lượng.
- `dataset/p2_data.yaml` dùng `images/train` cho cả train và validation. `train_p2_model.py` gom ba ảnh mẫu cùng năm ảnh khó tổng hợp vào tập này. Cần tách dữ liệu và kiểm tra nhãn trước lần train tiếp theo; không dùng bộ đó làm bằng chứng kiểm thử độc lập.
- `inference_enhanced.py` mặc định dùng `PTIT_InsectDetector_v1.pt`, quét đa tầng và ngưỡng thấp để tạo ảnh minh họa. Ảnh nhiều khung trong `outputs/` không chứng minh checkpoint P2 mới đã hoạt động.
- Worker JavaScript trong gói chỉ tăng tương phản RGB đơn giản, chưa thực hiện LAB CLAHE như mô tả; phần được gọi Soft-NMS cũng chưa có bước giảm điểm Gaussian như script Python. Không chép nguyên gói rồi khẳng định hai luồng tương đương.
- Nhãn xanh trong bản demo không có nghĩa “chắc chắn 100%”. Gợi ý loài cần đối chiếu và không phải chẩn đoán bệnh cây.

## Trạng thái web

Giữ P2 `ptit-insects-p2-preserved-20261109-v1`, detector `model-56593aaff227.onnx` và bộ gợi ý sáu loài hiện có. Chưa copy model nhập vào tài nguyên web, chưa đổi ngưỡng hay cơ chế gửi Telegram. Không triển khai lại Worker cho gói chưa đạt này.

Kết quả máy đọc: `output/verification/imported-ai-model-audit.json`. Bảng mã băm khi di chuyển: `output/verification/imported-ai-folder-manifest.json`.

Tái lập bằng Python có `onnxruntime`, `opencv-python`, `torch`, `ultralytics`:

```powershell
python scripts/audit_imported_insect_model.py --complete
```


Ghi chú: gói model không đạt và script kiểm tra một lần đã được chuyển vào Thùng rác khi tinh giản dự án. Báo cáo này giữ lại kết luận lịch sử; model web hiện dùng bản fine-tune camera riêng, xem `deliverables/PTIT_Camera_Recall_20261109/BAO_CAO.md`.
