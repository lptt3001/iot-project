# Cấu trúc iot project

| Thư mục | Nội dung |
| --- | --- |
| `infra/cloudflare/src` | Worker HTTPS, D1, camera, AI tự động và Telegram nhiều người nhận |
| `infra/cloudflare/dashboard` | Giao diện web Cloudflare |
| `infra/cloudflare/ai` | Hai ONNX hiện phục vụ, cấu hình, core, ảnh mẫu và giấy phép |
| `infra/cloudflare/*.sql` | Các migration D1, thứ tự trong DEPLOY.md |
| `firmware` | Mã ESP32-CAM Wi-Fi/USB và cấu hình mẫu |
| `app`, `database`, `contracts` | Backend cục bộ, schema và hợp đồng dữ liệu |
| `scripts`, `tests` | Công cụ chạy, train, đóng gói và kiểm tra |
| `deliverables` | Checkpoint cần thiết, kết quả đánh giá và tài liệu AI |
| `docs` | Hướng dẫn và ghi chú dự án |

## Dữ liệu không đưa lên GitHub

- `.env`, `.secrets`, cấu hình Wi-Fi/token thật và khóa TLS.
- `.runtime`, `.venv`, `node_modules`, `.wrangler`, `infra/cloudflare/.build` và cache Python.
- `output`: ảnh trạm, log, backup, ảnh chụp kiểm chứng và dữ liệu thử của phiên làm việc.
- Gói ZIP và firmware đã biên dịch: tạo lại bằng script khi cần. Bản USB cần chạy build trước khi flash. Bản firmware Wi-Fi riêng đã chuẩn bị vẫn được giữ trong vùng runtime cục bộ.
- Báo cáo PDF riêng tại thư mục gốc.

Nguồn dữ liệu/model gốc của gói sáu loài được giữ ngoài dự án tại `%LOCALAPPDATA%/PTIT-Garden-AI/project-archives/cleanup-20261109/he_thong_nhan_dien_con_trung/`. Công cụ `adapt_trap_model.py` nhận `--source-package` để trỏ đến gói này trên máy khác. Dữ liệu train/val/test và môi trường AI hoạt động nằm tại `%LOCALAPPDATA%/PTIT-Garden-AI`.

Gói AI nhập không đạt, ZIP trùng, các bản sao ONNX/core/script và cache không cần thiết đã chuyển vào Thùng rác. Hai ONNX đang chạy chỉ có một bản chuẩn trong `infra/cloudflare/ai`; bản local trong `app/static` dùng cấu hình riêng và được giữ nguyên.

Các mô hình/thư viện và ảnh dữ liệu có giấy phép riêng. Xem `infra/cloudflare/ai/LICENSE-DATA.json`, `infra/cloudflare/ai/licenses` và `app/static/ai/licenses`; không coi toàn bộ trọng số/ảnh mẫu là dữ liệu tự tạo.
