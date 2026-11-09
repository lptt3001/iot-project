# Báo cáo hoàn thành công việc tuần 1 - Trung

**Đề tài:** Hệ thống IoT & AI cảnh báo sớm sâu bệnh hại.  
**Thành viên:** Trung (trong các dòng chi tiết bảng nguồn ghi nhầm “Trumg”).  
**Vai trò:** Backend & Cloud. **Ngày bàn giao:** 26/10/2026.  
**Căn cứ:** [Bảng phân công nhóm, phần tuần 1](https://docs.google.com/spreadsheets/d/1kbjhxIWivJ_RlBTpdRQFfNxxPTZlrTjd/edit?gid=1054760256#gid=1054760256).

## 1. Nội dung được giao và kết quả

| Nhiệm vụ | Ưu tiên trong nguồn | Sản phẩm yêu cầu | Kết quả thực hiện |
|---|---|---|---|
| Thiết kế cơ sở dữ liệu quan hệ PostgreSQL và Time-series DB cho dữ liệu IoT | Cao | Database Schema và bản thiết kế kiến trúc hệ thống | Đã tạo và chạy schema PostgreSQL + TimescaleDB thật; 13 bảng, hypertable telemetry, aggregate theo giờ, retention, seed, truy vấn, ERD và tài liệu kiến trúc |
| Cài đặt Broker MQTT EMQX/Mosquitto và cấu hình kênh truyền bảo mật | Trung bình | Broker sẵn sàng nhận bản tin telemetry | Đã chạy Mosquitto 2.1.2 trên localhost:8883 với TLS, xác minh CA/SAN, mật khẩu riêng và ACL theo thiết bị; demo gửi/nhận/ghi DB thành công |

**Kết luận trong phạm vi tuần 1 của Trung:** Hoàn thành thiết kế, cấu hình, triển khai cục bộ và kiểm thử bằng phần mềm thật. Cần Lộc kết nối ESP32 và nhóm xác nhận liên module để nghiệm thu toàn bộ M1. Không xác nhận thay kết quả của các thành viên khác.

## 2. Sản phẩm bàn giao

1. `database/init/001_schema.sql`: khóa chính, khóa ngoại tổng hợp theo vườn, miền giá trị cảm biến, index, metadata ảnh/AI/cảnh báo dự trù.
2. `database/init/002_timescale.sql`: hypertable chunk 1 ngày, raw 90 ngày, aggregate giờ 365 ngày, refresh 15 phút với cửa sổ 8 ngày.
3. `database/init/003_seed.sql`, `database/queries.sql`: dữ liệu tổng hợp và truy vấn phục vụ kiểm tra/Dashboard.
4. `000_roles.sh`, `004_grants.sql`: tài khoản DB admin/app/ingest, mật khẩu riêng, phân quyền tối thiểu cho ingest.
5. `infra/mosquitto/`: cấu hình MQTT TLS, tài khoản bắt buộc và ACL giới hạn topic theo vườn/trạm.
6. `contracts/`: JSON Schema v1, đơn vị đo, timestamp UTC, định danh bản tin và ví dụ payload.
7. `scripts/`: tự tạo bí mật/chứng chỉ, cài binary Windows riêng, chạy/dừng broker/DB, demo đầu cuối, kiểm thử và đóng gói.
8. `compose.yaml`: phương án triển khai Docker thay thế. Đã kiểm tra cấu trúc YAML và tồn tại tag image; chưa chạy container trên máy này do không có Docker.
9. `docs/`: đánh giá đủ 24 tác vụ, kiến trúc, từ điển dữ liệu và hướng dẫn kết nối ESP32.
10. `output/verification/verification-full.json` và `output/verification/demo-telemetry.txt` lưu minh chứng kiểm thử và mẫu nhận được qua MQTT.

## 3. Môi trường và bằng chứng

Môi trường thực thi: Windows x64; PostgreSQL **17.11** + TimescaleDB **2.23.1**, Mosquitto **2.1.2**, Python **3.12**. Các binary tải từ nhà phát hành chính thức, chạy riêng cho dự án, không cài Windows service. PostgreSQL chỉ nghe 127.0.0.1:5432; MQTT native chỉ nghe 127.0.0.1:8883.

Database được đặt trong LocalAppData riêng, không đồng bộ file DB đang mở bằng OneDrive. Source, cấu hình, hướng dẫn và kết quả kiểm thử nằm trong dự án. Mật khẩu và private key tự sinh, không nằm trong gói nộp.

Tệp `output/verification/verification-full.json` ghi nhận **32/32 bài kiểm thử đạt, 0 failure, 0 error**.

| Nhóm | Số bài đạt | Nội dung kiểm tra |
|---|---:|---|
| Hợp đồng telemetry | 8 | Bản tin hợp lệ; sai UUID; thiếu phép đo; dư trường; sai topic; quá cũ/tương lai; sai độ ẩm; NaN |
| MQTT/TLS/ACL thật | 11 | Kết nối đúng; anonymous/sai mật khẩu bị chặn; sai CA/hostname bị từ chối; TLS1.2; QoS1 gửi nhận; chặn ghi chéo trạm/vườn; trạm không đọc; backend không ghi |
| PostgreSQL/TimescaleDB thật | 12 | Extension/hypertable; đủ policy; chống ghi lặp; miền giá trị; FK trạm/vườn/lô; thiếu đo; thời gian tương lai; NaN; quyền ingest và app |
| Aggregate thật | 1 | Vật hóa hai mẫu 20°C và 30°C, kiểm tra sample_count=2 và avg=25°C; dọn fixture sau kiểm thử |

Demo đầu cuối tạo UUID và thời gian mới, publish QoS1 bằng station-001 qua TLS, backend subscribe nhận đúng bản tin, xác minh hợp đồng và ghi DB bằng role iot_ingest. Ghi lại cùng mẫu trả số dòng 0, chứng minh khử trùng lặp. Giá trị demo 29,5°C, 76,2%RH, 58% độ ẩm đất là dữ liệu tổng hợp, không phải số đo thực địa.

## 4. Tiêu chí nghiệm thu phần Trung

| Tiêu chí | Minh chứng | Trạng thái |
|---|---|---|
| Có kiến trúc tổng thể, ERD và từ điển dữ liệu | Kien_truc/Thiet_ke_CSDL trong docs | Đạt |
| Schema chạy được trên PostgreSQL + Time-series engine | Cài native thật và suite DB | Đạt |
| Có raw telemetry, aggregate, retention và truy vấn | SQL, kiểm tra policy và aggregate | Đạt |
| Broker nhận telemetry có xác thực/bảo mật | Suite MQTT thật và demo | Đạt |
| TLS kiểm tra CA và định danh server | Sai CA/hostname đều bị từ chối | Đạt |
| Trạm không ghi sang topic khác | Bài kiểm tra chéo vườn/trạm | Đạt |
| Dữ liệu gửi lại không ghi trùng | PK và ON CONFLICT, demo DB | Đạt |
| Có hướng dẫn triển khai và bàn giao cho Lộc | README và MQTT_VA_TICH_HOP.md | Đạt |
| ESP32 thật nối broker, đo và truyền dữ liệu | Cần phần cứng/firmware của Lộc | Chờ phối hợp |
| Triển khai cloud, kiểm thử tải/backup đầy đủ | Thuộc kế hoạch tuần 2-3 | Chưa thuộc nghiệm thu tuần 1 |

## 5. Đánh giá bảng phân công và kiến nghị

Đã đánh giá đủ 24 tác vụ trong `DANH_GIA_PHAN_CONG.md`, gồm sản phẩm, phụ thuộc và tiêu chí nghiệm thu cần bổ sung. Lỗi “Trumg”/“Trung” và “P Minh”/“Phạm Minh” khiến phần tổng hợp đếm sai; trạng thái M1 và các dòng tác vụ chưa nhất quán. Nên chuẩn hóa tên/mã thành viên, bổ sung ngày bắt đầu, link sản phẩm và bằng chứng nghiệm thu. Chưa sửa trực tiếp bảng nguồn.

Phần broker nên được ưu tiên Cao vì chặn tích hợp tuần 2 nếu chậm. Chốt metric AI thống nhất, quy tắc gán nhãn/split dữ liệu và loại cây/vườn thử nghiệm; không coi mAP và Accuracy là cùng một số đo. Ngưỡng nguy cơ và khuyến cáo nông học cần người có chuyên môn xác nhận.

## 6. Việc nối tiếp đã xác định

- Lộc: xác nhận cảm biến/đơn vị, đưa CA public và credential đúng trạm vào firmware, NTP và retry ổn định; phối hợp test ESP32 thật.
- Khởi: xác nhận mã lớp sâu, bbox xyxy chuẩn hóa, model_version và định dạng suy luận để API tích hợp tuần 2.
- P Minh: nhận cấu trúc dữ liệu, đơn vị, múi giờ và trạng thái thiếu dữ liệu/offline để xây Dashboard.
- Trung tuần 2: dịch vụ ingest liên tục có session/ACK/retry bền vững, REST/OpenAPI/WebSocket, nhận ảnh, tích hợp AI và luật cảnh báo. Schema tương lai không có nghĩa các tính năng này đã được triển khai.

## 7. Cách tái hiện nhanh

Theo README: chạy `scripts/setup_windows.ps1`, `scripts/setup_database_windows.py`, sau đó `scripts/verify.py --database` và `scripts/demo_telemetry.py --database` bằng Python trong `.venv`. Gói nộp chứa source và minh chứng, loại toàn bộ `.secrets`, `.env`, `.venv`, runtime và dữ liệu DB.
