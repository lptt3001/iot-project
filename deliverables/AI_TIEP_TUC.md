# Tiếp tục tích hợp AI PTIT Garden

## Phạm vi đã chốt

- Bản thử dùng ảnh bẫy dính thật của [PestNu](https://zenodo.org/records/7139220), giấy phép CC BY 4.0.
- Phát hiện, vẽ khung và đếm theo hai nhãn `whitefly` (bọ phấn trắng) và `black_aphid` (rệp đen).
- Model chạy theo yêu cầu trong trình duyệt. Ảnh ESP32-CAM thực địa cần được kiểm thử riêng trước khi dùng kết quả để cảnh báo.

## Trạng thái

- Dữ liệu PestNu đã tải và kiểm tra MD5. Đã chia theo ảnh gốc thành 180 ảnh huấn luyện, 22 ảnh xác thực và 23 ảnh kiểm thử, rồi cắt vùng ảnh 416 × 416.
- Phiên Windows này chưa cấp quyền CUDA cho PyTorch. Quá trình CPU dùng trọng số YOLOX-Nano COCO, giữ backbone và huấn luyện lại phần phát hiện hai nhóm.
- Môi trường và dữ liệu huấn luyện nằm dưới `%LOCALAPPDATA%\PTIT-Garden-AI`.
- Mã cấu hình nằm trong `scripts/pestnu_yolox.py`. Dùng Python của `%LOCALAPPDATA%\PTIT-Garden-AI\venv` để chạy `scripts/train_pestnu_cpu.py`, truyền thư mục `%LOCALAPPDATA%\PTIT-Garden-AI` và `--epochs 10`. Script tiếp tục từ checkpoint CPU nếu có.
- Checkpoint nằm trong `%LOCALAPPDATA%\PTIT-Garden-AI\runs\ptit_pestnu_nano` và tiến độ trong `%LOCALAPPDATA%\PTIT-Garden-AI\train-cpu.log`.
- Đã hoàn thành 10 vòng huấn luyện CPU và kiểm tra ONNX khớp đầu ra PyTorch trên một ảnh mẫu. Model dùng trên web là `app/static/ai/model-6a865cbacfae.onnx`, ngưỡng độ tin cậy 0,30 được chọn trên tập xác thực.
- Trên 275 vùng kiểm thử từ 23 ảnh gốc, sai lệch số đếm trung bình là 1,04 con mỗi vùng. Recall theo nhãn và IoU 0,5 là 37,2% với bọ phấn trắng và 24,0% với rệp đen. Kết quả chi tiết nằm trong `%LOCALAPPDATA%\PTIT-Garden-AI\runs\ptit_pestnu_nano\metrics.json`.
- Checkpoint PyTorch đã sao lưu tại `deliverables/PTIT_PestNu_YOLOX_Nano.pth`. Bước cải thiện tiếp theo là gán nhãn ảnh bẫy ESP32-CAM và tinh chỉnh bằng dữ liệu từ chính mạch.
- Đã triển khai bản Cloudflare `7f5d5a26-dd06-4e69-a85e-2c0a00e2f0a3`. Đã thử đủ bốn ảnh PestNu và một ảnh từ camera trực tiếp trên web. Gói `deliverables/PTIT_Garden_MoPhong.zip` chứa model ONNX, ảnh demo, runtime và mã nguồn.

## Bản v2 ưu tiên giảm báo nhầm

- Tinh chỉnh thêm 5 vòng từ checkpoint v1, mở phần neck và head, giữ backbone. Checkpoint tiếp tục nằm tại `%LOCALAPPDATA%\PTIT-Garden-AI\runs\ptit_pestnu_nano_refine\cpu_latest_ckpt.pth`. Checkpoint tốt nhất đã sao lưu tại `deliverables/PTIT_PestNu_YOLOX_Nano_v2.pth`.
- Tập xác thực chọn ngưỡng 0,40 cho bọ phấn trắng và 0,35 cho rệp đen. Cùng tập kiểm thử 275 vùng, số dự đoán sai giảm từ 250 xuống 145. Precision là 64,5% và 46,3%, recall là 37,2% và 21,3% theo thứ tự hai lớp. Sai số đếm trung bình tăng từ 1,04 lên 1,19 con mỗi vùng.
- Model ONNX là `app/static/ai/model-736268ae7b96.onnx`. So sánh chi tiết nằm trong `%LOCALAPPDATA%\PTIT-Garden-AI\runs\ptit_pestnu_nano_refine\precision-metrics.json`.
