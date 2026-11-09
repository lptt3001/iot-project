# P2 ưu tiên ít bỏ sót trên ảnh camera — 09/11/2026

Đã fine-tune từ P2 đang hoạt động, không sử dụng checkpoint P2 nhập mới đã bị loại. Model mới: `ptit-insects-p2-camera-recall-20261109-v2`. Detector SHA-256 `03244ece87370b4b4f09c7950a5e8128aa1e0681ff3956d9d034e90de037c0e4`.

## Huấn luyện và chọn ngưỡng

- 819 ảnh train: 276 ảnh nguồn nguyên bản + 276 bản mô phỏng camera + 267 ảnh/vùng replay và nền âm tính lấy từ train.
- Các biến đổi camera gồm tối bằng gamma, tối rìa, Gaussian blur, nhiễu và nén JPEG. Nhãn nguồn được giữ nguyên với biến đổi chỉ thay điểm ảnh; augment hình học do Ultralytics cập nhật nhãn.
- Fine-tune 8 epochs, AdamW, LR đầu 0,0001, batch 8, ảnh vào 640, đóng băng 10 lớp đầu. Chọn checkpoint tốt nhất trên validation. Bảng đầy đủ trong `training-results.csv`.
- 95 ảnh validation và 197 ảnh test được mô phỏng camera từ các nhóm nguồn tách riêng. Kiểm tra nhóm train/val/test không giao nhau. Test nguồn đã từng được dùng trong báo cáo P2 trước; đây không phải bộ dữ liệu thực địa mới độc lập.
- Chọn ngưỡng theo F3 trên validation, đặt trọng số recall cao hơn precision, không dùng test chọn ngưỡng. Ngưỡng được chốt **0,075** trước khi đo test. Không nâng số khung bằng cách vẽ thêm khung hoặc dùng ảnh minh họa có sẵn.
- Bốn ảnh người dùng không đưa vào huấn luyện hay tính chỉ số có nhãn; chúng là hai cảnh chụp lại màn hình, dùng để kiểm tra tình huống.

## Đánh đổi trên 197 ảnh test mô phỏng camera

| Cấu hình | Recall | Precision | TP | FP | FN |
| --- | ---: | ---: | ---: | ---: | ---: |
| P2 trước, ngưỡng 0,525 | 13.6% | 58.5% | 332 | 236 | 2113 |
| P2 bổ sung, ngưỡng 0,075 | 79.7% | 21.7% | 1949 | 7037 | 496 |

Đây là phát hiện côn trùng một lớp với IoU đối chiếu 0,5, quét toàn ảnh + vùng 320 px và gộp NMS 0,45, trước bước gợi ý sáu loài. Nhãn công khai có thể thiếu côn trùng nhỏ. Recall tăng nhưng **precision chỉ khoảng 21,7% theo nhãn nguồn**, phù hợp yêu cầu chấp nhận nhận nhầm để giảm bỏ sót; không gọi đây là model chính xác tổng thể hơn. Nhiều khung có thể là nền ảnh, rác hoặc phần giao diện màn hình.

So cùng ngưỡng 0,075, P2 trước có recall 56,7%, precision 35,5%; P2 bổ sung đạt recall 79,7%, precision 21,7%. Vì vậy kết quả không chỉ do thay ngưỡng.

## Bốn ảnh người dùng

| Ảnh theo thứ tự gửi | Trước: P2/0,525 | Chỉ hạ ngưỡng P2/0,075 | P2 bổ sung/0,075 |
| --- | ---: | ---: | ---: |
| 1 | 0 | 7 | 20 |
| 2 | 0 | 6 | 23 |
| 3 | 0 | 7 | 25 |
| 4 | 0 | 8 | 16 |

Số trong bảng là khung dự đoán của detector và bộ gộp JavaScript sản xuất, không phải số côn trùng được người gán nhãn xác nhận. Trong ảnh đã thấy nhận nhầm ở viền/chữ/biểu tượng màn hình. Thử các phương án gamma sáng hơn và ảnh 1280 không cải thiện đều bốn tình huống, nên web giữ đầu vào tối đa 960 và cách quét hiện tại, tránh tăng số lượt xử lý.

## Cách hiển thị và cảnh báo

Web ghi **Côn trùng** cho đối tượng chưa có tên loài như yêu cầu. Ngưỡng gợi ý loài vẫn 0,70 và margin 0,15; giảm ngưỡng detector không ép gán loài. Các phát hiện chung chưa có loài không tự chuyển thành cảnh báo sâu/bệnh cây ăn quả. Ảnh camera mới dùng model mới qua cùng luồng tự động; ảnh đã có kết quả cũ có nút **Phân tích lại** để xem thử với model hiện tại, không ghi đè lịch sử.

Hai ONNX hiện phục vụ: detector `model-03244ece8737.onnx` và model sáu loài `model-ca8b834e8d52.onnx`. Hai ONNX dùng chung được giữ tại `infra/cloudflare/ai/`, không chép lặp trong gói báo cáo này. Detector P2 trước và cấu hình tham khảo nằm trong `deliverables/PTIT_P2_CaiThien_20261109`; thư mục rollback trùng đã được dọn. Docker không đổi.

## Kiểm chứng và tái lập

Đã kiểm tra PyTorch/ONNX tương đương trên cùng đầu vào và chạy detector mới bằng ONNX Runtime Web WASM một luồng, đầu ra `[1,5,34000]`. Thông số ở `onnx-parity.json`, `onnx-web-verification.json`. 63 kiểm thử Cloudflare và kiểm thử decoder/gộp khung đều đạt, gồm việc giữ phát hiện chung điểm thấp mà không giảm ngưỡng tên loài.

Mã: `scripts/camera_recall.py`, `scripts/camera_recall_postprocess.cjs`, `scripts/verify_camera_recall.cjs`. Dữ liệu và môi trường train nằm ngoài OneDrive tại `%LOCALAPPDATA%/PTIT-Garden-AI/camera-recall-20261109`.

```powershell
python scripts/camera_recall.py prepare
python scripts/camera_recall.py train --epochs 8
python scripts/camera_recall.py evaluate --name candidate --split val --weights <work>/runs/camera/weights/best.pt
# Chốt ngưỡng trên val, lưu selection-before-test.json, rồi mới evaluate --split test.
python scripts/camera_recall.py export --weights <checkpoint-da-chon>
node scripts/verify_camera_recall.cjs <work>
```

Tài liệu nguyên lý: [ngưỡng dự đoán Ultralytics](https://docs.ultralytics.com/usage/cfg/#predict-settings), [tăng cường dữ liệu](https://docs.ultralytics.com/guides/yolo-data-augmentation/). Các ngưỡng và kết quả ở đây do thử nghiệm dự án, không lấy độ chính xác từ tài liệu thư viện.

## Kiểm tra trên web đã triển khai

Đã mở trực tiếp trang sản xuất, chọn lần lượt bốn ảnh gốc của người dùng và chạy toàn bộ P2 + bộ gợi ý loài bằng Web Worker. Kết quả theo thứ tự: **21, 21, 23, 16** khung; cả bốn đều 0 gợi ý loài. Không bấm Lưu vào thư viện hoặc gửi Telegram trong kiểm tra này. Ảnh chụp kết quả đầu ở `WEB_ANH_1.png`, dữ liệu ở `web-verification.json`.

Số khung web hơi khác bảng chạy Python phía trên do đường resize/interpolation và backend xử lý ảnh khác nhau. Không thay số khung kiểm thử Python bằng số web để giả lập một phép đo giống hệt. Hai luồng dùng cùng trọng số và ngưỡng, và đều đã được kiểm chứng hoạt động.
