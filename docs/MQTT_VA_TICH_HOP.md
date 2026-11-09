# MQTT bảo mật và hợp đồng tích hợp

## 1. Cấu hình bàn giao

Mosquitto 2.1.2, MQTT v5 trong bộ kiểm thử (broker đồng thời hỗ trợ 3.1.1 cho ESP32), listener TLS 8883, tối thiểu TLS 1.2, tắt anonymous. Chứng chỉ server có SAN `localhost`, `127.0.0.1`, `mosquitto`, `mqtt.iot.local`; CA nội bộ cho demo, server certificate 90 ngày, CA 365 ngày. CA private key không được giao cho thiết bị.

File nguồn Docker: `infra/mosquitto/mosquitto.conf`. File local được bootstrap sinh từ cấu hình đó, đổi đường dẫn và bind loopback. Broker có persistence, giới hạn packet 16 KiB, payload 8 KiB và hàng đợi 1.000 message. Không mở cổng MQTT plaintext 1883.

## 2. Tài khoản và quyền

| Tài khoản | Được ghi | Được đọc |
|---|---|---|
| `station-001` | `iot/v1/farms/farm-demo/devices/station-001/telemetry` và `/status` | Không có quyền đọc topic |
| `station-002` | Tương tự nhưng chỉ station-002 | Không có quyền đọc topic |
| `backend-ingestor` | Không có quyền ghi | `iot/v1/farms/+/devices/+/telemetry` và `/status` |

Mật khẩu riêng, tự sinh trong `.secrets/credentials.json`. Broker dùng file băm PBKDF2-SHA512 với salt riêng, không dùng mật khẩu mặc định. ACL cho thiết bị là đường dẫn chính xác, không mở wildcard theo dữ liệu do client tự cung cấp. Username không được tự do đổi farm bằng nội dung JSON.

Mosquitto có thể trả SUBACK thành công ngay cả khi tài khoản không có quyền đọc, rồi lọc bản tin ở bước delivery. Bài kiểm thử quyền đọc xác nhận trạm không nhận được bản tin trong khi tài khoản backend nhận đúng cùng bản tin, không dựa riêng vào mã SUBACK.

## 3. Hợp đồng telemetry

Topic gồm 7 phân đoạn:

```text
iot/v1/farms/{farm_id}/devices/{device_id}/telemetry
```

Payload đầy đủ ở `contracts/telemetry.example.json`, hợp đồng máy kiểm tra ở `contracts/telemetry.schema.json`.

```json
{
  "schema_version": 1,
  "message_id": "00000000-0000-4000-8000-000000000200",
  "device_id": "station-001",
  "farm_id": "farm-demo",
  "observed_at": "2026-10-26T02:00:00Z",
  "measurements": {
    "temperature_c": 29.5,
    "air_humidity_pct": 76.2,
    "soil_moisture_pct": 58
  },
  "battery_v": 3.9,
  "rssi_dbm": -62
}
```

Timestamp trên là ví dụ tĩnh. Khi chạy demo, script tự tạo timestamp/UUID mới để vượt kiểm tra độ trễ.

- Telemetry: QoS1, retain=false, chu kỳ đề xuất 60 giây, payload UTF-8 JSON. DHT22/SHT30 không được đo nhanh hơn mức phần cứng cho phép; tần suất thực chốt cùng Lộc.
- Có ít nhất một phép đo môi trường; các phép đo khác có thể bỏ trường. Không gửi null/chuỗi “NaN” cho cảm biến lỗi. Giá trị phải là số hữu hạn, đúng đơn vị.
- `observed_at` bắt buộc UTC với hậu tố Z. Máy trạm cần NTP trước khi xác minh chứng chỉ và tạo timestamp. Chấp nhận backlog tối đa 7 ngày, lệch tương lai tối đa 5 phút ở bộ kiểm tra ingest.
- `farm_id`/`device_id` trong JSON phải khớp topic; DB registry phải khớp và enabled. Broker không xác minh các điều kiện JSON này; demo đã kiểm tra, dịch vụ ingest tuần 2 phải sử dụng cùng quy tắc.
- Mất kết nối: reconnect có backoff và jitter; gửi lại mẫu giữ nguyên message_id+observed_at. Đây là yêu cầu bàn giao firmware, chưa phải firmware đã viết trong tuần 1.

## 4. Trạng thái thiết bị

Topic `iot/v1/farms/{farm_id}/devices/{device_id}/status`. Đề xuất payload `{"online":true}` khi kết nối và Last Will `{"online":false}`, QoS1, retain=true. Khác telemetry, trạng thái có thể retain để client mới biết trạng thái cuối.

Thiết bị dùng Deep Sleep sẽ thường xuyên mất kết nối có chủ đích. UI không nên chỉ dựa vào Last Will để báo lỗi; API cần kết hợp `last_seen_at`, chu kỳ gửi và lịch ngủ dự kiến. Hợp đồng status cần chốt cùng Lộc trong bước tích hợp tuần 2; bộ kiểm thử tuần 1 tập trung telemetry/TLS/ACL.

## 5. Kết nối ESP32 trong LAN

1. Chọn IP/hostname ổn định của máy broker, ví dụ IP LAN do nhóm thực tế cung cấp.
2. Trước khi cấp chứng chỉ lần đầu, chạy `python scripts/bootstrap.py --san <IP-LAN>` hoặc `--san <hostname>`. Với bộ chứng chỉ đã có, script sẽ báo nếu SAN yêu cầu còn thiếu, không lặng lẽ bỏ qua.
3. Nếu đổi SAN, lưu riêng bộ `.secrets/certs` cũ trong nơi riêng tư, tạo bộ mới bằng bootstrap, khởi động lại broker và cập nhật CA public trên client. Không trộn cert mới với key/CA cũ.
4. Với Docker, đặt `MQTT_BIND_ADDRESS=0.0.0.0` trong `.env`; với native, đổi riêng listener của `mosquitto.local.conf` sang địa chỉ LAN/0.0.0.0. Chỉ mở firewall TCP8883 cho mạng/trạm cần thiết.
5. Lộc nhận `ca.crt`, host, port8883, username/password đúng trạm và topic. Dùng TLS client có kiểm tra CA/tên server; không dùng `setInsecure()` hay tắt xác minh chứng chỉ.
6. Gửi payload mẫu với thời gian thực và đối chiếu log nhận. Không dùng `localhost` làm địa chỉ broker trên ESP32 vì nó chỉ chính ESP32.

Phần cấu hình LAN này là hướng dẫn; chưa tự thay firewall, cấp IP hay chạy thử ESP32 thật. Hiện máy chạy loopback cho demo an toàn và tái lập.

## 6. Bổ sung/thu hồi trạm

Thêm một trạm cần đồng thời: bản ghi devices đúng vườn/lô; mật khẩu ngẫu nhiên trong credentials; ACL chỉ đúng farm/device; chạy lại bootstrap để tạo file băm; restart/reload broker; cấp riêng CA public và credential cho trạm. Chỉnh JSON credentials không tự cập nhật DB hoặc ACL.

Khi thu hồi: đặt enabled=false trong DB, bỏ tài khoản khỏi file credentials, sinh lại password file và khởi động lại broker để đóng phiên đang kết nối. Giữ lịch sử telemetry. Luân chuyển mật khẩu và chứng chỉ trước khi hết hạn; tuần 3 bổ sung quy trình tự động nếu cần.

## 7. Nghiệm thu

```powershell
.\.venv\Scripts\python.exe scripts/verify.py --database
.\.venv\Scripts\python.exe scripts/demo_telemetry.py --database
```

Bài kiểm thử có TLS đúng CA, TLS1.2, sai CA, sai hostname, anonymous, sai mật khẩu, quyền ghi chéo trạm/vườn, backend không được publish và thiết bị không được đọc dữ liệu. Luồng demo chỉ ghi bản tin thực sự nhận được qua broker; sau đó gửi lại cùng mẫu vào DB để xác nhận khử trùng lặp.
