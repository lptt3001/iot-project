# iot project

**PTIT Garden — IoT giám sát sâu bệnh.** ESP32-CAM qua Wi-Fi gửi số đo và ảnh lên Cloudflare. Bản Windows và Docker dùng để chạy mô phỏng hoặc thử thiết bị tại máy.

Repo công khai chỉ gồm mã nguồn, model cần thiết và tài liệu. Thông tin Wi-Fi, bot Telegram, tài khoản, cơ sở dữ liệu, ảnh trạm và kết quả kiểm tra riêng được giữ ngoài Git. Xem [cấu trúc và dữ liệu lưu ngoài repo](docs/PROJECT_STRUCTURE.md).

## Tìm file theo chức năng

| Phần | Điểm bắt đầu |
| --- | --- |
| Frontend dùng chung | [app/static](app/static), gồm dashboard, màn hình đăng nhập và mã phân tích ảnh trong trình duyệt |
| Backend Cloudflare | [worker.js](infra/cloudflare/src/worker.js), cấu hình Worker và SQL của D1 trong [infra/cloudflare](infra/cloudflare) |
| Backend chạy tại máy | [app/main.py](app/main.py), SQL PostgreSQL/TimescaleDB trong [database](database) |
| AI huấn luyện | Các file `*pestnu*` trong [scripts](scripts), xem [ghi chú PestNu](deliverables/AI_TIEP_TUC.md) |
| ESP32-CAM | [firmware](firmware), chia thành bản Wi-Fi và bản USB |
| Công cụ Windows | `START.cmd` và `STOP.cmd` ở thư mục gốc. Các lệnh Docker, COM5, nạp firmware và sao lưu ở [scripts/launchers](scripts/launchers) |
| Tài liệu và kết quả | [docs](docs) chứa tài liệu, [deliverables](deliverables) chứa các gói bàn giao. [output](output) gom báo cáo PDF, kết quả kiểm thử, bản sao lưu và ảnh xem trước |

## Chạy trên Windows

**Bấm đúp START.cmd** ở thư mục dự án. Khi sẵn sàng, trình duyệt mở **http://127.0.0.1:8000**. Lần đầu cần Internet để tải phụ thuộc; những lần sau dùng lại môi trường đã cài. Yêu cầu Python 3.12+ và Windows x64.

**Bấm đúp STOP.cmd** để dừng ứng dụng, broker và database. Mọi dữ liệu đã lưu được giữ lại. START.cmd có thể chạy lại khi hệ thống đang mở.

Trong PowerShell có thể dùng:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start_app.ps1
~~~

Script chạy các dịch vụ riêng của dự án, không cần Docker, không cài Windows service. PostgreSQL nằm trong LocalAppData để tránh đồng bộ database qua OneDrive; vị trí cụ thể trong `.runtime/native-database.json`. Nhật ký ứng dụng ở `.runtime/app.stderr.log`.

## Thử các chức năng

### Cảm biến thật qua USB / COM5

Khởi động backend bằng `scripts/launchers/DOCKER_START.cmd`, sau đó chạy `scripts/launchers/SERIAL_START.cmd` khi ESP32-CAM đang cắm COM5. Đóng Arduino Serial Monitor trước vì mỗi cổng chỉ mở được bởi một chương trình. Gateway đọc log ở 115200 baud, chuyển số đo thật qua MQTT TLS vào `station-001`, tạm dừng giả lập và dành riêng trạm đó cho phần cứng. `scripts/launchers/SERIAL_STOP.cmd` dừng gateway. Khi chuyển máy/cổng, dùng `.venv\Scripts\python.exe scripts/serial_gateway.py --port COMx`.

Gateway hỗ trợ dòng firmware dạng `T=28.0 C | RH=59.0 % | light=0 | rain=1 | soil=4095`. Nó lưu tạm mẫu chưa được broker xác nhận trong SQLite, gửi lại cùng UUID khi mất MQTT, và thử mở lại cổng khi rút/cắm USB. Thời gian đo đang dùng thời gian máy tính nhận log UTC vì firmware chưa cung cấp timestamp. RSSI không được tự điền khi log không có trường này. Dữ liệu lỗi DHT được bỏ từng phép đo, không thay bằng số 0. `soil_raw`, `light_do`, `rain_do` được lưu riêng; ADC 4095 chưa được quy đổi sang phần trăm. UI ghi rõ nguồn phần cứng và giá trị đất thô. Khi giả lập tắt và có trạm phần cứng, lịch sử và CSV mặc định chỉ lấy `source=hardware`; có thể dùng tham số `source=all` để xem cả dữ liệu cũ.

Firmware `firmware/ptit_usb_camera/ptit_usb_camera.ino` bổ sung ảnh JPEG qua USB cùng luồng cảm biến. Cần nạp firmware này trước khi dùng nút Chụp thử camera thật; firmware cũ chỉ có log cảm biến sẽ bị báo chưa sẵn sàng. Gateway ghép ảnh có kiểm tra độ dài, lưu tạm và gửi multipart vào backend; ảnh thật không được đưa vào bộ nhận diện mô phỏng. Tự chụp mỗi 30 phút khi tối (DO=1) và khô (DO=1). Chụp thử cho phép lúc sáng nhưng vẫn chặn mưa (DO=0). Kết nối Google Sheets/Drive chưa được triển khai. Để quay về mô phỏng: dừng gateway, rồi cập nhật `/api/simulation` với `external_devices: []` và `running: true` bằng phiên ứng dụng; lịch sử phần cứng vẫn được giữ.

1. **Tổng quan:** cảm biến cập nhật trực tiếp, biểu đồ 1 giờ–7 ngày, sơ đồ hai trạm, ảnh gần nhất và cảnh báo.
2. **Phòng mô phỏng:** chọn bình thường, nóng/khô, ẩm cao hoặc nhiều sâu; chọn trạm mất kết nối, chu kỳ cảm biến và camera; bấm **Áp dụng kịch bản**. Ngưỡng môi trường mặc định lấy trung bình 1 phút nên cảnh báo có thể cần khoảng 1 phút để xuất hiện.
3. **Thử camera ngay:** tạo ảnh 0–20 đối tượng; xem khung trong **Camera & nhận diện**. Luật mặc định cảnh báo từ 5 đối tượng/ảnh, nghỉ 5 phút trên mỗi trạm trước khi gửi lặp.
4. **Cảnh báo:** lọc trạng thái và xác nhận; nút chuông mở hộp thư cục bộ. **Thiết lập ngưỡng** cho phép đổi giá trị, cửa sổ trung bình và khoảng nghỉ.
5. **Trạm & cảm biến:** xem lịch sử, sửa tên/vị trí, bật hoặc tắt nhận dữ liệu, tải CSV.

Đây là môi trường demo cục bộ: ứng dụng tự mở phiên người vận hành cho farm-demo, chỉ bind loopback. Chưa cấu hình để công khai trên Internet.

## Phần mô phỏng và phần chạy thật

- **Mô phỏng:** ESP32, số đo, tọa độ và ảnh bẫy. Ảnh được tạo bằng chương trình.
- **Chạy thật:** MQTT qua TLS và ACL, kiểm tra JSON Schema, lưu đệm trước ACK, ghi TimescaleDB chống trùng, xử lý hàng đợi ảnh, luật cảnh báo, hộp thư, REST API và WebSocket.
- **Nhận diện demo:** tách các hình màu của ba lớp trong ảnh tổng hợp, sinh khung từ thành phần liên thông. Chưa có bộ dữ liệu/YOLO đã huấn luyện nên không công bố độ chính xác thực địa. Ảnh tải lên được lưu nhưng không tạo dự đoán sâu bệnh giả. Muốn xử lý ảnh thực tế cần bổ sung model đã huấn luyện.
- **Thông báo:** bản cục bộ dùng hộp thư trong web. Bản Cloudflare hỗ trợ gửi cảnh báo mới qua Telegram sau khi cấu hình bot và chat nhận.

Khi có phần cứng, giữ đúng hợp đồng `contracts/telemetry.schema.json` và topic hiện có để gửi vào cùng broker. Mỗi thiết bị có tài khoản MQTT riêng; bí mật nằm trong `.secrets/`.

## Sao lưu và khôi phục thử

**Bấm đúp `scripts/launchers/BACKUP.cmd` khi hệ thống đang chạy.** Bản ZIP nằm trong `output/backups/`, gồm database nhất quán, các ảnh được tham chiếu, hàng đợi đang chờ và mã băm; không kèm mật khẩu/khóa riêng.

Khôi phục sang một database mới để kiểm tra:

~~~powershell
.\.venv\Scripts\python.exe scripts/backup.py --restore output/backups/<ten-ban-sao>.zip --database iot_restore_kiemtra
~~~

Chọn tên mới mỗi lần. Script kiểm tra mã băm ảnh và đối chiếu số dòng sau restore, giữ nguyên database đang chạy. Quy trình TimescaleDB dùng pre_restore/post_restore theo [tài liệu chính thức](https://www.tigerdata.com/docs/deploy/self-hosted/backup-and-restore/logical-backup). Giữ riêng `.secrets/` nếu chuyển hệ thống sang máy khác.

Database khôi phục có thể được dùng bằng biến môi trường DB_NAME; MEDIA_DIR trỏ vào thư mục ảnh khôi phục do script in ra. Đây là bước chuyển cấu hình thủ công, không tự thay thế dữ liệu ứng dụng.

## Kiểm thử

Chạy khi ứng dụng đã sẵn sàng:

~~~powershell
.\.venv\Scripts\python.exe scripts/verify_application.py
.\.venv\Scripts\python.exe scripts/verify.py --database
.\.venv\Scripts\python.exe scripts/benchmark.py
~~~

Kết quả máy đọc được nằm trong `output/verification/`. Các bài kiểm thử dùng broker/database thật. Kiểm thử ứng dụng tạm thay kịch bản rồi trả lại cấu hình, đồng thời tạo một số ảnh và cảnh báo demo.

## Docker (phương án thay thế)

Mở Docker Desktop, chờ Linux engine sẵn sàng, rồi bấm **`scripts/launchers/DOCKER_START.cmd`**. Script chuẩn bị thông tin kết nối, dừng bản Windows để tránh trùng cổng, build và chờ ứng dụng sẵn sàng trước khi mở trình duyệt. **`scripts/launchers/DOCKER_STOP.cmd`** dừng container và giữ dữ liệu trong named volumes. Dữ liệu Docker tách biệt với Windows, lần đầu chạy sẽ dùng dữ liệu demo mới.

Trong terminal có thể dùng `docker compose up -d --build --wait --wait-timeout 180`, xem trạng thái bằng `docker compose ps` và xem lỗi bằng `docker compose logs --tail=100`. Không dùng `docker compose down -v` nếu muốn giữ dữ liệu. Trạng thái kiểm thử thực tế được ghi trong `output/verification/` sau khi chạy các bài kiểm tra.

Kiểm tra bản Docker đang chạy bằng `python scripts/verify_application.py`, `python scripts/verify.py --database` trong môi trường `.venv`; `python scripts/verify_docker.py` kiểm tra thêm dữ liệu và ảnh còn nguyên sau khi tạo lại container. Lệnh sao lưu ở trên dành cho bản Windows. Ảnh của bản Docker nằm trong volume `app_data`.

Ngày 27/10/2026, bản Docker đã chạy thực tế và đạt 10 kiểm thử ứng dụng cùng 32 kiểm thử hợp đồng dữ liệu, MQTT/TLS/ACL và PostgreSQL/TimescaleDB.

## Nhận dữ liệu 24/7 bằng Cloudflare Workers Free

Phương án này dùng tài khoản Cloudflare Free, có địa chỉ HTTPS `workers.dev` và dùng D1 để lưu số đo, ảnh JPEG và cảnh báo. Sau khi đăng nhập, dashboard online hiển thị trạng thái ESP32-CAM, biểu đồ, lịch sử, thư viện ảnh và thiết lập ngưỡng. Cloudflare kiểm tra các nhóm cảnh báo theo cảm biến bằng lịch mỗi 5 phút. Biểu đồ và CSV dùng mẫu gần nhất trong mỗi khoảng thời gian. Worker giữ số đo khoảng 7 ngày và tối đa 100 ảnh. Firmware Wi-Fi gửi ảnh tối đa 512 KiB.

Trong **Camera & nhận diện**, mục **Thử AI trên ảnh mẫu bẫy thật** dùng ba ảnh mẫu RicePest-30 để thử P2 và bộ gợi ý sáu loài. Đây là ảnh mẫu, không phải ảnh mới của vườn. Phân tích tại trình duyệt chỉ là bản xem trước; nút **Gửi cảnh báo thử từ kết quả này** gửi tin có nhãn thử đến người nhận được chọn. Với ảnh trạm, có thể mở ảnh rồi chọn **Phân tích ảnh này** để thử tại trình duyệt. Luồng ảnh camera mới được AI tự động trên cloud phân tích và xét cảnh báo riêng.

Bản web hiện dùng YOLOv8 P2 phát hiện côn trùng + model sáu loài, chạy bằng ONNX Runtime Web. Các kết quả là gợi ý cần đối chiếu thực địa. Các script `*pestnu*` và dữ liệu thử bọ phấn/rệp thuộc thí nghiệm trước; không phải model đang phục vụ trên web.

Model YOLOv8 sáu loài có bộ chạy Python riêng trong `scripts/run_trap_inference.py`. Tạo môi trường AI riêng, cài `requirements-trap-ai.txt`, rồi chạy:

~~~powershell
python scripts/run_trap_inference.py --model deliverables/PTIT_Trap_6Loai_CaiThien_v1.pt --config deliverables/PTIT_Trap_6Loai_CaiThien_v1.json --input output/ai/anh_bay_that_RicePest30/anh_goc --output output/ai/ket_qua_model_cai_thien
~~~

Lệnh tạo ảnh vẽ khung, JSON chứa tọa độ chuẩn hóa và `counts.csv`. Mặc định dùng ảnh toàn cảnh cùng các vùng 320 px chồng lấn, bỏ khung cắt qua mép trong và gộp trùng; thêm `--full-frame` để chỉ quét toàn ảnh. Sáu lớp giữ đúng thứ tự trong checkpoint; nhãn rút gọn trên ảnh là CM, PX, OF, SC, CP và DI. Số đếm chỉ áp dụng cho các lớp model hỗ trợ.

`scripts/adapt_trap_model.py` chuẩn bị dữ liệu, fine-tune và hỗ trợ `--resume`; `--phase2` cân bằng lại lớp yếu trong tập học và mở toàn bộ mạng. Tập nguồn được chia theo nhóm thứ tự tên ảnh, có nhóm đệm quanh test, loại ảnh trùng và các ảnh đối chiếu 15 mẫu. `scripts/evaluate_trap_adaptation.py` chọn ngưỡng trên validation trước khi đo test. Các nhóm này chưa được xác nhận là các ngày/bẫy độc lập ngoài thực địa; nhãn nguồn vẫn cần kiểm chứng chuyên môn.

**P2 thử nghiệm ngày 09/11/2026:** [báo cáo và ảnh so sánh](deliverables/PTIT_P2_CaiThien_20261109/BAO_CAO.md). P2 được huấn luyện lại bằng nhãn nguồn, giữ các nhánh P3/P4/P5 của detector cũ và thêm nhánh P2. Trên cùng 197 ảnh test, F1 phát hiện một lớp côn trùng tăng từ 48,0% lên 58,2%, MAE số đếm giảm từ 6,51 xuống 4,38 con/ảnh; precision giảm từ 73,0% xuống 70,2% và xử lý GPU chậm hơn khoảng 2,1 lần. Ngưỡng của từng model được chọn trên validation trước khi đo test. Bộ nhận diện sáu loài giữ nguyên; kết quả này không phải độ chính xác phân loại loài hay kiểm chứng trên ảnh ESP32 mới. Bản P2 gốc dùng ngưỡng 0,525; web hiện dùng bản fine-tune camera và ngưỡng 0,075 theo yêu cầu ưu tiên ít bỏ sót (xem cập nhật dưới đây); model phát hiện cũ không còn trong tài nguyên web. Docker giữ cấu hình riêng.

**Cập nhật camera 09/11/2026:** đã fine-tune P2 đang hoạt động 8 vòng trên 819 ảnh nguồn và ảnh mô phỏng mờ/tối/nhiễu; bốn ảnh người dùng giữ ngoài train. Chốt ngưỡng detector 0,075 theo F3 trên validation, giữ ngưỡng tên loài 0,70/margin 0,15. Trên test mô phỏng camera, recall tăng 13,6% → 79,7%, precision giảm 58,5% → 21,7%; đây là lựa chọn chấp nhận nhiều nhận nhầm để giảm bỏ sót, chưa phải độ chính xác thực địa. Web ghi “Côn trùng” và có nút Phân tích lại cho ảnh cũ. [Báo cáo, model và ảnh đối chiếu](deliverables/PTIT_Camera_Recall_20261109/BAO_CAO.md). Gói P2 nhập bị lỗi trước đó vẫn không được sử dụng.

Mã tái lập P2 nằm trong `scripts/improve_p2_detector.py`, `scripts/compare_p2_detectors.py`, `scripts/package_p2_detector.py` và `scripts/verify_p2_onnx_web.cjs`. Dùng môi trường Ultralytics riêng; dữ liệu/cache tại `%LOCALAPPDATA%\PTIT-Garden-AI`, kết quả lần này tại `p2-improved-20261109`. Core trên Cloudflare hỗ trợ cả 8.400 điểm của model sáu loài và 34.000 điểm của detector P2.

Ảnh mới trên Cloudflare ghi nguồn chụp và tài khoản đã yêu cầu chụp từ web hoặc tải ảnh lên. Ảnh camera không gắn yêu cầu chụp từ web được ghi là cảm biến tự chụp; ảnh lịch sử thiếu thông tin sẽ ghi rõ chưa lưu nguồn/tài khoản. Khi mở ảnh, bấm vùng trống bên ngoài cửa sổ, nút × hoặc Escape để đóng.

Cloudflare tự gửi lệnh chụp **07:00 mỗi ngày, giờ Việt Nam (UTC+7)**. Trạm cần bật, có Wi-Fi và không báo mưa. Lệnh dùng cơ chế chụp từ xa hiện có nên không cần nạp lại firmware chỉ để bật lịch này. Ảnh camera mới được đưa vào hàng đợi AI trên cloud (kiểm tra mỗi 5 phút), chạy P2 + model sáu loài, lưu kết quả vào thư viện và gửi Telegram nếu ảnh đạt ngưỡng của ít nhất một loài đã chọn trong hồ sơ cây khi nhận ảnh. Không cần mở web hay bật máy tính. Ảnh không có côn trùng không phát cảnh báo; nhóm chưa xác định loài chỉ cảnh báo khi đã bật và đạt ngưỡng riêng. AI gợi ý côn trùng, chưa chẩn đoán bệnh lá. Bản Free của Browser Run giới hạn 10 phút xử lý/ngày cho cả tài khoản; chi tiết cấu hình, giới hạn và cách thử lại xem [hướng dẫn triển khai](infra/cloudflare/DEPLOY.md).

Mục **Telegram & thiết lập** có bốn hồ sơ riêng: **ổi, lựu, sầu riêng, lê**. Một trạm chọn một hồ sơ theo cây/vị trí đang đặt; từng hồ sơ giữ thiết lập riêng. Ba nhóm cảnh báo thay cho nhiệt độ cao/độ ẩm cao chung:

- **Đất ướt kéo dài:** đầu dò ADC cần hiệu chuẩn hai mốc đất khô/ướt phù hợp vị trí. Mặc định nhắc kiểm tra tưới, thoát nước và rễ khi chỉ số ướt tương đối ≥85% trong 120 phút. Đây không phải % thể tích nước hay chẩn đoán thối rễ. Chưa hiệu chuẩn thì nhóm này chờ, không tự đoán ADC.
- **Môi trường ẩm kéo dài:** nhiệt độ và RH phải đồng thời khớp, duy trì liên tục. Mặc định ổi/lựu 25–30°C, sầu riêng 24–30°C, RH ≥85% trong 60 phút; lê 15–25°C, RH ≥85% trong 120 phút. Nội dung nhắc kiểm tra tương ứng thán thư/đốm quả, Phytophthora hoặc đốm nâu lê. Các con số là ngưỡng giám sát vận hành, chưa phải mô hình dự báo nhiễm bệnh đã kiểm chứng; tham khảo lê cần xác nhận giống/địa phương.
- **Sâu hại trong ảnh:** chọn bật/tắt và ngưỡng 1–300 con/ảnh riêng cho ngài sâu cuốn lá nhỏ, ngài sâu tơ, ngài sâu đục thân ngô, bọ xít đen, ngài đục quả và ngài sâu xanh dưa. Mặc định cả sáu loài bật ở mức 1 con/ảnh; ngưỡng ngài đục quả đã lưu trước đó được giữ lại. Có thể bật thêm nhóm **Côn trùng chưa xác định**, mặc định tắt. Ảnh camera mới tạo một cảnh báo trên web và gửi Telegram khi ít nhất một loài được chọn đạt ngưỡng riêng. Không cộng số lượng giữa các loài. Từng cây lưu lựa chọn và ngưỡng riêng. Đây là cảnh báo côn trùng tại vị trí bẫy, không khẳng định cây đang bị hại hoặc nhiễm bệnh.

Hai nhóm cảm biến nghỉ mặc định 6 giờ giữa các cảnh báo cùng cây/nhóm. Khoảng trống mẫu quá 2 phút, số đo lỗi hoặc thiếu cảm biến liên quan ngắt chuỗi của nhóm đó. Đổi hồ sơ/lưu luật bắt đầu tính thời gian lại. DHT11 ngoài 0–50°C/20–90% RH và ADC sát biên được coi là dữ liệu không đủ tin cậy cho đánh giá. Mưa DO là ướt/khô, ánh sáng DO hỗ trợ bẫy/đèn; không dùng hai giá trị này để khẳng định bệnh. Nguồn và giới hạn hiển thị trên web và trong [hướng dẫn triển khai](infra/cloudflare/DEPLOY.md). Lịch sử cảnh báo cũ vẫn giữ; luật nhiệt độ/độ ẩm chung ngừng phát mới.

Từ thư mục `infra/cloudflare`, dùng Node.js và npm để triển khai trên tài khoản đã đăng nhập:

~~~sh
npx wrangler@4 login
npx wrangler@4 d1 create ptit-garden
# Điền database_id được cấp vào wrangler.jsonc.
npx wrangler@4 d1 execute ptit-garden --remote --file schema.sql
npx wrangler@4 d1 execute ptit-garden --remote --file alerts.sql
npx wrangler@4 d1 execute ptit-garden --remote --file telegram.sql
npx wrangler@4 d1 execute ptit-garden --remote --file auth.sql
npx wrangler@4 d1 execute ptit-garden --remote --file register.sql
npx wrangler@4 d1 execute ptit-garden --remote --file camera-requests.sql
npx wrangler@4 d1 execute ptit-garden --remote --file automation.sql
npx wrangler@4 d1 execute ptit-garden --remote --file plant-health.sql
npx wrangler@4 d1 execute ptit-garden --remote --file telegram-pairing.sql
npx wrangler@4 d1 execute ptit-garden --remote --file station-startups.sql
npx wrangler@4 d1 execute ptit-garden --remote --file telegram-recipients.sql
npx wrangler@4 d1 execute ptit-garden --remote --file led.sql
npx wrangler@4 d1 execute ptit-garden --remote --file observation-alerts.sql
npm ci
npx wrangler@4 deploy
npx wrangler@4 secret put DEVICE_TOKEN
npx wrangler@4 secret put DASHBOARD_PASSWORD
npx wrangler@4 secret put DASHBOARD_ACCOUNT_PEPPER
~~~

Dùng các bí mật khác nhau. Tạo `DASHBOARD_ACCOUNT_PEPPER` từ 32 byte ngẫu nhiên dưới dạng 64 ký tự hex và giữ lại khi triển khai phiên bản mới để tài khoản đã tạo tiếp tục đăng nhập được. Đăng nhập quản trị tại `/login` với tên người dùng `garden` và mật khẩu `DASHBOARD_PASSWORD`. Thành viên đăng ký tại trang này và có thể đăng nhập sau khi quản trị viên duyệt trong mục **Duyệt tài khoản**. Thành viên có quyền xem số đo, ảnh và cảnh báo. Đặt URL HTTPS của Worker và `DEVICE_TOKEN` vào firmware `station-001` theo hướng dẫn nạp bên dưới. Dùng gói Workers Free khi tạo ứng dụng.

Với firmware Wi-Fi hỗ trợ nhận lệnh, quản trị viên có thể chọn **Chụp ảnh ngay** trong mục **Camera & nhận diện**. Mạch nhận yêu cầu qua HTTPS và dùng mã của yêu cầu để gửi ảnh về đúng phiên chụp. Chụp thủ công hoạt động khi sáng hoặc tối, vẫn dừng nếu cảm biến báo mưa. Mỗi trạm xử lý một yêu cầu tại một thời điểm, tối đa 90 giây.

Trong **Camera & nhận diện**, mục **Đèn hỗ trợ camera** cho quản trị viên bật/tắt LED ngoài trên **IO12**. Web phân biệt lệnh đang lưu với trạng thái mạch đã xác nhận; xác nhận GPIO không đo được ánh sáng thực tế. Lệnh được giữ khi mất mạng và áp dụng sau khi kết nối lại. Firmware khởi động với đèn tắt, lấy lệnh mỗi khoảng 5 giây khi có mạng; tải ảnh hoặc kết nối chậm có thể làm tăng thời gian chờ. Thành viên chỉ xem trạng thái.

Cần nạp lại `firmware/ptit_cloud_camera/ptit_cloud_camera.ino` cùng `cloud_transport.h`, giữ `cloud_config.h` của mạch (Wi-Fi, URL, token, CA). Mặc định LED bật ở mức HIGH: IO12 → điện trở hạn dòng → LED → GND. Mạch công suất/relay cần bộ điều khiển phù hợp; không cấp tải công suất trực tiếp từ GPIO. `REMOTE_LED_ACTIVE_HIGH` cho phép đổi cực điều khiển. [GPIO12 chọn điện áp flash lúc reset](https://docs.espressif.com/projects/esp-idf/en/release-v5.4/esp32/api-reference/peripherals/sd_pullup_requirements.html), nên mạch ngoài phải giữ chân này ở mức thấp khi khởi động trên ESP32-CAM dùng flash 3,3 V. Phần này không sử dụng thẻ SD.

### Nhận cảnh báo qua Telegram

1. Dùng một bot của dự án, cấu hình token bằng secret `TELEGRAM_BOT_TOKEN` trên Cloudflare. Không đưa token vào web hoặc mã nguồn.
2. Từng tài khoản web đã được duyệt mở **Telegram & thiết lập → Kết nối người nhận**. Bấm **Mở bot Telegram**, gửi lệnh kết nối/Start, quay lại web và xác nhận đúng người nhận. Mã hết hạn sau 10 phút; mỗi tài khoản có yêu cầu riêng.
3. Người mới được **thêm** vào danh sách. Bot gửi tin **“Đã nhận kết nối”** sau khi xác nhận. Quản trị viên có thể thêm nhiều người; tài khoản thường quản lý kết nối của mình.
4. Bấm **Danh sách người kết nối** để xem tên, tài khoản web, mã chat đã che, ngày kết nối, trạng thái gửi và lần gửi thành công gần nhất. Có nút tạm dừng/bật lại, mở đúng bot và gửi tin thử ngay. Biên nhận gửi thử hiển thị tên bot và mã tin do Telegram trả về; không phải dấu hiệu người nhận đã đọc.

Trong **Camera & nhận diện → Thử AI trên ảnh mẫu bẫy thật**, ảnh RicePest-30 chỉ dùng minh họa. Sau khi phân tích, chọn người nhận và bấm **Gửi cảnh báo thử từ kết quả này** để gửi đúng số đếm đang xem (tổng/gợi ý loài/chưa xác định). Tin luôn ghi rõ **ẢNH MẪU / CẢNH BÁO THỬ**, không tạo cảnh báo sâu bệnh thật cho vườn. Ảnh camera mới từ trạm vẫn được AI trên cloud tự xử lý và phát cảnh báo theo luồng riêng.

Mọi người đang bật nhận sẽ được gửi cảnh báo mới về môi trường, sâu hại, nguy cơ bệnh và khởi động trạm. Mỗi sự kiện/người nhận có hàng đợi riêng; lỗi của một người không chặn người khác. Kết nối mới hoặc bật lại không nhận lại cảnh báo cũ. Worker thử gửi ngay với thông báo kết nối/tin thử/số đo, và kiểm tra lại mỗi 5 phút khi lỗi tạm thời. Trạng thái dựa trên kết quả gửi thực tế, không suy đoán người nhận đang online. Chi tiết migration và kiểm thử xem [DEPLOY.md](infra/cloudflare/DEPLOY.md).

## Chạy trên Google Cloud Compute Engine

Chuẩn bị một VM Linux có Docker Engine và Compose v2, tên miền trỏ về IP công khai của VM và firewall cho phép TCP 80/443. Dùng thư mục triển khai riêng, tạo bí mật mới trên VM và giữ lại các Docker volume khi cập nhật.

~~~sh
docker run --rm -it caddy:2.10-alpine caddy hash-password
cp .env.cloud.example .env.cloud
# Điền tên miền, tài khoản dashboard và hash vừa tạo vào .env.cloud.
python3 -m venv .venv
.venv/bin/pip install cryptography
.venv/bin/python scripts/bootstrap.py --http-device station-001
docker compose --env-file .env.cloud -f compose.yaml -f compose.cloud.yaml up -d --build --wait
~~~

Proxy Caddy cấp HTTPS cho tên miền và yêu cầu tài khoản dashboard. Chỉ proxy công bố cổng ra Internet. PostgreSQL, Mosquitto và FastAPI kết nối qua mạng Docker. Token theo trạm nằm trong `.secrets/device-http.json`. Chuyển token riêng cho người cấu hình thiết bị. Giữ định kỳ bản sao database và volume ảnh ngoài VM, theo dõi hạn chứng chỉ nội bộ Mosquitto do `bootstrap.py` tạo.

### Giao thức ESP32 qua HTTPS

- Gửi header `Authorization: Bearer <token>` theo trạm. Đồng bộ giờ qua NTP và xác minh chứng chỉ HTTPS của máy chủ.
- `POST /device/v1/station-001/telemetry` nhận `application/json` tối đa 16 KiB theo `contracts/telemetry.schema.json`. Dùng `farm_id` là `farm-demo`, `device_id` là `station-001` và `observed_at` theo UTC với hậu tố `Z`. Trường cảm biến gồm `temperature_c`, `air_humidity_pct`, `soil_raw`, `light_do`, `rain_do`. Bỏ trường chưa đọc được. Mỗi mẫu có `message_id` UUID và thời điểm đo riêng. Giữ nguyên cả hai khi gửi lại. Backend trả `200` và `duplicate: true` nếu mẫu đó đã lưu. Gửi khoảng 10 giây/lần để phù hợp cửa sổ trạng thái trực tuyến 20 giây.
- `PUT /device/v1/station-001/images/<capture_uuid>` nhận byte JPEG trực tiếp với `Content-Type: image/jpeg`, tối đa 512 KiB trên Cloudflare và 2 MiB trên backend Docker. Giữ nguyên UUID ảnh khi gửi lại. Backend trả `201` cho lần nhận đầu và khi gửi lại cùng UUID.
- Với Cloudflare, `GET /device/v1/station-001/camera/next` trả `204` khi không có yêu cầu hoặc `200` kèm mã `id` của lệnh. Mạch dùng chính mã đó khi gửi JPEG. Nếu không thể hoàn tất, mạch gửi `POST /device/v1/station-001/camera/<id>/fail` với JSON có trường `error` là `rain`, `camera` hoặc `upload`. Các API này dùng cùng token của trạm.
- Firmware Wi-Fi mới gửi `POST /device/v1/station-001/startup` với JSON `{"boot_id":"<UUID>"}` sau khi khởi động và có Wi-Fi/giờ UTC hợp lệ. Mạch giữ nguyên UUID khi gửi lại hoặc kết nối lại Wi-Fi. Backend chống tạo trùng sự kiện và gửi Telegram tới chat đang cấu hình, có hàng đợi thử lại. Cần nạp firmware mới để bật chức năng này; firmware cũ không tự phát sinh thông báo khởi động.
- Thử lại với cùng mẫu khi timeout hoặc gặp lỗi máy chủ `5xx`, có giãn cách giữa các lần thử. Kiểm tra cấu hình và payload nếu gặp `401`, `404`, `413`, `415` hoặc `422`.

### Nạp firmware ESP32-CAM qua Wi-Fi

Sketch `firmware/ptit_cloud_camera/ptit_cloud_camera.ino` dùng chân theo code ESP32-CAM mới nhất. Xác nhận DHT11 IO13, ánh sáng IO15, mưa IO14 và đất IO2 trước khi nạp. Mạch chụp một ảnh sau khi chuyển sáng sang tối và cảm biến mưa báo khô. Để thử, để cảm biến sáng trước rồi che lại và chờ ít nhất 3 giây. Hàng đợi gửi lại có giới hạn và nằm trong RAM của mạch.

Tạo `cloud_config.h` từ `firmware/ptit_cloud_camera/cloud_config.example.h` sau khi backend có địa chỉ HTTPS. Điền Wi-Fi, URL gốc HTTPS, mã trạm, token và chứng chỉ CA gốc phù hợp với máy chủ. Giữ file cấu hình và bản `.bin` đã biên dịch riêng vì chúng chứa thông tin kết nối. Trong Arduino IDE, dùng board AI Thinker ESP32-CAM và thư viện DHT sensor library. Nếu dùng toolchain Windows đã cài cho dự án, chạy `scripts/build_firmware.ps1 -Cloud -CloudConfig <đường-dẫn-config>`. Chạy với `-Cloud` riêng để kiểm tra biên dịch bằng cấu hình mẫu.

Sau khi nạp, kiểm tra Serial Monitor ở 115200 baud. Backend trả `200` khi nhận số đo và `201` khi nhận ảnh. Mở dashboard để kiểm tra trạm `station-001` và ảnh mới, sau đó thử lại với ESP32 ở mạng khác và máy cá nhân tắt.

## Firmware camera USB

Chân theo cấu hình đã bàn giao: DHT11 IO13, ánh sáng DO IO14, mưa DO IO15, đất AO IO2, LED bẫy active-low IO33, camera AI Thinker pinout với PWDN IO32. Không bật SD hoặc Wi-Fi trong firmware USB này. Ảnh mặc định VGA khi có PSRAM, QVGA khi không có; Serial 115200.

Biên dịch bằng Arduino IDE với ESP32 core 2.0.17, board AI Thinker ESP32-CAM và DHT sensor library 1.4.7; hoặc `scripts/build_firmware.ps1` khi công cụ đã được chuẩn bị. Windows cần thư mục build không dấu để compiler xử lý đường dẫn đúng. `scripts/launchers/FLASH_CAMERA.cmd` sao lưu toàn bộ flash vào `.runtime/firmware-backups` trước khi ghi mới; không tiếp tục nếu sao lưu thất bại. Đưa mạch vào chế độ nạp bằng IO0 + RST; tín hiệu đất ở IO2 có thể cần tạm rút vì GPIO2 phải thấp/để hở lúc bootloader. Sau nạp: thả IO0, reset, cắm lại AO và chạy gateway.

Kiểm thử phần truyền/nhận bằng `python -m unittest discover -s tests -p test_serial_camera.py -v` và `python scripts/verify_camera.py` (backend Docker đang chạy). Script dùng ảnh JPEG sinh riêng làm fixture và xóa sau khi kiểm tra, không coi đó là ảnh chụp từ mạch. Chỉ xác nhận camera hoạt động sau khi nhận được JPEG thật từ firmware.
