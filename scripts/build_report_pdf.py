"""Create the Vietnamese handover PDF from verified results and assignment review.

Authoring dependency: reportlab. The application bundled Python includes it.
"""
from __future__ import annotations
from collections import Counter
from datetime import datetime
from html import escape
import json
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
from reportlab.graphics.shapes import Drawing, Rect, Line, String, Polygon

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/pdf/Bao_cao_Tuan_1_Trung.pdf'
SOURCE='https://docs.google.com/spreadsheets/d/1kbjhxIWivJ_RlBTpdRQFfNxxPTZlrTjd/edit?gid=1054760256#gid=1054760256'
INK=colors.HexColor('#18354A'); TEAL=colors.HexColor('#146C70'); PALE=colors.HexColor('#EFF6F7')
GREY=colors.HexColor('#5A6874'); LINE=colors.HexColor('#D8E1E6')

def main():
    font_dir=Path('C:/Windows/Fonts')
    for name,file in [('Arial','arial.ttf'),('ArialBold','arialbd.ttf'),('ArialItalic','ariali.ttf')]:
        pdfmetrics.registerFont(TTFont(name,str(font_dir/file)))
    pdfmetrics.registerFontFamily('Arial',normal='Arial',bold='ArialBold',italic='ArialItalic',boldItalic='ArialBold')
    styles=getSampleStyleSheet()
    styles.add(ParagraphStyle(name='TitleV',fontName='ArialBold',fontSize=25,leading=32,textColor=INK,spaceAfter=15))
    styles.add(ParagraphStyle(name='H1V',fontName='ArialBold',fontSize=17,leading=23,textColor=INK,spaceAfter=13))
    styles.add(ParagraphStyle(name='H2V',fontName='ArialBold',fontSize=11.8,leading=17,textColor=TEAL,spaceBefore=10,spaceAfter=7))
    styles.add(ParagraphStyle(name='BodyV',fontName='Arial',fontSize=10,leading=15,spaceAfter=8,textColor=INK))
    styles.add(ParagraphStyle(name='SmallV',fontName='Arial',fontSize=8.8,leading=12.5,spaceAfter=5,textColor=GREY))
    styles.add(ParagraphStyle(name='CellV',fontName='Arial',fontSize=8.6,leading=11.7,textColor=INK))
    styles.add(ParagraphStyle(name='CellSmallV',fontName='Arial',fontSize=8.1,leading=10.9,textColor=INK))
    styles.add(ParagraphStyle(name='HeadCellV',fontName='ArialBold',fontSize=8.7,leading=12,textColor=colors.white))
    story=[]
    def clean(text): return str(text).replace('—','-').replace('–','-').replace('‑','-').replace('`','')
    def p(text,style='BodyV'): return Paragraph(escape(clean(text)),styles[style])
    def add(text,style='BodyV'): story.append(p(text,style))
    def heading(title): add(title,'H1V')
    def sub(title): add(title,'H2V')
    def table(headers,rows,widths,small=False):
        data=[[p(v,'HeadCellV') for v in headers]]+[[p(v,'CellSmallV' if small else 'CellV') for v in row] for row in rows]
        tab=Table(data,colWidths=widths,repeatRows=1,hAlign='LEFT')
        tab.setStyle(TableStyle([
            ('BACKGROUND',(0,0),(-1,0),INK),('VALIGN',(0,0),(-1,-1),'TOP'),
            ('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),
            ('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7),
            ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,PALE]),
            ('LINEBELOW',(0,0),(-1,0),0.5,INK),('LINEBELOW',(0,1),(-1,-1),0.3,LINE),
        ])); story.append(tab); story.append(Spacer(1,8))
    def page(): story.append(PageBreak())
    evidence=json.loads((ROOT/'output/verification/verification-full.json').read_text(encoding='utf-8'))
    assert evidence['successful'] and evidence['tests_run']==32

    # 1. Outcome and assignment.
    add('BÁO CÁO BÀN GIAO','SmallV')
    add('Tuần 1 - Trung','TitleV')
    add('Hệ thống IoT & AI cảnh báo sớm sâu bệnh hại','H2V')
    add('Backend & Cloud  |  Ngày 26/10/2026','SmallV')
    add('Hoàn thành thiết kế cơ sở dữ liệu, kiến trúc và MQTT bảo mật; đã triển khai và kiểm thử trực tiếp trên Windows bằng PostgreSQL, TimescaleDB và Mosquitto thật.')
    table(['Nhiệm vụ theo phân công','Sản phẩm bàn giao','Kết quả'],[
        ['Thiết kế PostgreSQL và Time-series DB. Ưu tiên: Cao.','Schema, ERD, kiến trúc, dữ liệu mẫu, aggregate và retention.','Đã triển khai cục bộ và kiểm thử.'],
        ['Cài Broker MQTT và kênh truyền bảo mật. Ưu tiên: Trung bình.','Mosquitto TLS, tài khoản riêng, ACL, topic/payload, demo nhận telemetry.','Đã chạy broker và thử gửi/nhận/ghi DB.'],
    ],[160,235,120])
    sub('Kết quả thực thi')
    add('32/32 bài kiểm thử đạt; 0 lỗi, 0 thất bại. Demo gửi mẫu qua MQTT TLS, nhận ở backend, ghi TimescaleDB và bỏ qua bản tin gửi trùng.')
    sub('Phạm vi nghiệm thu')
    add('Đủ sản phẩm kỹ thuật tuần 1 của Trung trong môi trường cục bộ. ESP32 thật và nghiệm thu liên module của toàn nhóm cần phối hợp với Lộc và các thành viên còn lại. REST API, WebSocket, AI và thông báo thuộc tuần 2-3.')
    sub('Nguồn và lưu ý phân công')
    story.append(Paragraph(f'<link href="{escape(SOURCE,quote=True)}" color="#146C70">Bảng phân công công việc do người dùng cung cấp</link>',styles['BodyV']))
    add('Tên chi tiết “Trumg” được đối chiếu thành Trung theo vai trò. Có lỗi tên khiến tổng hợp đếm 0; mốc M1 ghi đã nghiệm thu nhưng tác vụ vẫn đang thực hiện. Chưa sửa trực tiếp file nguồn.','SmallV')
    page()

    # 2. Architecture.
    heading('01  Kiến trúc và luồng dữ liệu')
    add('PostgreSQL quản lý dữ liệu quan hệ. TimescaleDB mở rộng cùng instance để lưu chuỗi thời gian, giữ được khóa ngoại và giao dịch. Mosquitto chịu trách nhiệm truyền tin bảo mật.')
    drawing=Drawing(515,290)
    def box(x,y,w,h,title,subtitle,fill=PALE,dash=False):
        drawing.add(Rect(x,y,w,h,rx=6,ry=6,fillColor=fill,strokeColor=TEAL,strokeWidth=1,strokeDashArray=[4,3] if dash else None))
        drawing.add(String(x+w/2,y+h-20,title,fontName='ArialBold',fontSize=10,fillColor=INK,textAnchor='middle'))
        for i,line in enumerate(subtitle):
            drawing.add(String(x+w/2,y+h-37-i*13,line,fontName='Arial',fontSize=8.3,fillColor=GREY,textAnchor='middle'))
    def arrow(x1,y1,x2,y2,dash=False):
        drawing.add(Line(x1,y1,x2,y2,strokeColor=TEAL,strokeWidth=1.3,strokeDashArray=[4,3] if dash else None))
        if x2>x1: points=[x2,y2,x2-6,y2+3,x2-6,y2-3]
        else: points=[x2,y2,x2-3,y2+6,x2+3,y2+6]
        drawing.add(Polygon(points,fillColor=TEAL,strokeColor=TEAL))
    box(0,195,110,75,'ESP32 / cảm biến',['Giao diện đã thiết kế','Chờ thử phần cứng'],dash=True)
    box(139,195,115,75,'Mosquitto',['TLS 8883','Tài khoản + ACL'])
    box(283,195,100,75,'Demo nhận tin',['Kiểm tra JSON','Ghi nhận một mẫu'])
    box(412,195,103,75,'PostgreSQL',['TimescaleDB','Quan hệ + thời gian'])
    arrow(110,232,139,232,True); arrow(254,232,283,232); arrow(383,232,412,232)
    box(20,35,140,88,'Ingest + API',['Tuần 2','Retry, REST, WebSocket'],dash=True)
    box(188,35,140,88,'AI + cảnh báo',['Tuần 2-3','YOLO, cooldown, notify'],dash=True)
    box(356,35,140,88,'Dashboard',['Tuần 2-3','Biểu đồ, bản đồ, ảnh'],dash=True)
    arrow(196,195,196,150,True); arrow(196,150,90,150,True); arrow(90,150,90,123,True)
    arrow(160,78,188,78,True); arrow(328,78,356,78,True)
    drawing.add(String(0,8,'Khối nét liền: đã chạy ở tuần 1. Nét đứt: giao diện hoặc phần tích hợp tiếp theo.',fontName='Arial',fontSize=8.5,fillColor=GREY))
    story.append(drawing)
    sub('Luồng nghiệm thu đã chạy')
    add('Trạm mô phỏng tạo UUID + timestamp mới -> MQTT QoS1 qua TLS -> backend subscribe -> xác minh schema/topic/thời gian -> ghi DB bằng role iot_ingest -> thử ghi lại cùng mẫu, nhận 0 dòng mới.')
    sub('Điểm chốt tích hợp')
    add('Telemetry dùng MQTT; ảnh dùng HTTPS/object storage ở tuần 2. Tách observed_at (thời gian đo) và received_at (thời gian nhận). Các bản tin retry giữ nguyên message_id và observed_at.')
    add('Demo một bản tin chưa thay thế ingest liên tục. Tuần 2 cần persistent session, ACK sau commit, retry và hàng đợi lỗi. Không coi QoS1 là đảm bảo ghi DB exactly-once.')
    sub('Quy mô thiết kế giả định')
    add('10 trạm, 1 mẫu/phút: 14.400 mẫu/ngày và 1.296.000 mẫu/90 ngày. Đây là tính tải lý thuyết; benchmark hiệu năng, backup và restore thuộc tuần 3.','SmallV')
    page()

    # 3. Database dictionary.
    heading('02  Thiết kế cơ sở dữ liệu')
    add('13 bảng trong schema iot và continuous aggregate telemetry_hourly. Chi tiết cột, kiểu và SQL thực thi nằm trong docs/THIET_KE_CSDL.md và database/init/.')
    table(['Nhóm / bảng','Vai trò dữ liệu','Ràng buộc chính'],[
        ['app_users','Định danh người dùng qua auth_subject.','UUID PK, auth_subject duy nhất; không lưu password người dùng.'],
        ['farms, farm_members','Vườn và quyền thành viên.','Slug vườn an toàn cho topic; role owner/operator/viewer.'],
        ['plots','Lô đất, cây trồng, diện tích.','FK vườn; diện tích >0; khóa tổng hợp (id,farm).'],
        ['devices','Trạm, vị trí, firmware, trạng thái.','MQTT username duy nhất; lô và thiết bị phải cùng vườn.'],
        ['sensor_readings','Telemetry theo thời gian.','PK (device,observed_at,message_id), FK (device,farm), CHECK miền đo.'],
        ['image_captures','Metadata ảnh và object_key.','FK trạm/vườn; SHA256, chiều rộng/cao >0.'],
        ['pest_species','Nhãn sâu tơ, rầy nâu, bọ trĩ.','Mã lớp cần chốt với Khởi; bọ trĩ cần xác nhận loài.'],
        ['inference_runs','Lần suy luận và model_version.','Duy nhất (image,model); có trạng thái lỗi/chờ/thành công.'],
        ['pest_detections','Loài, confidence và bounding box.','Confidence 0..1; bbox chuẩn hóa xyxy, min<max trong [0,1].'],
        ['alert_rules, alerts','Ngưỡng và sự kiện cảnh báo.','Rule và device phải cùng farm; rule mặc định tắt.'],
        ['notification_deliveries','Theo dõi gửi Telegram/Zalo.','Chống tạo lặp (alert,channel,recipient); lưu attempts/status.'],
    ],[110,192,213])
    sub('Quan hệ quan trọng')
    add('User -> farm_members -> farm -> plot -> device -> sensor_readings / image_captures. Ảnh -> inference_runs -> pest_detections -> pest_species. Farm/rule/device -> alerts -> notification_deliveries.')
    add('FK tổng hợp ngăn gán trạm/lô/rule sang vườn khác. Không cascade xóa lịch sử; ngừng sử dụng bằng enabled=false. Các bảng AI/thông báo mới là schema dự trù, chưa là dịch vụ hoàn chỉnh.','SmallV')
    page()

    # 4. Timeseries and database roles.
    heading('03  Time-series, quyền và dữ liệu mẫu')
    table(['Thiết kế','Thông số bàn giao'],[
        ['Engine','PostgreSQL 17.11 + TimescaleDB 2.23.1; không fallback lặng lẽ về bảng thường.'],
        ['Hypertable','sensor_readings, phân vùng observed_at, chunk 1 ngày.'],
        ['Dữ liệu raw','Giữ 90 ngày theo thời gian đo; có index device/time và farm/time.'],
        ['Aggregate giờ','Theo farm/device, sample_count, avg/min/max nhiệt độ, avg độ ẩm không khí/đất.'],
        ['Policy aggregate','Giữ 365 ngày; refresh 15 phút, cửa sổ 8 ngày tới 1 giờ trước; bật real-time aggregate.'],
        ['Chống trùng','ON CONFLICT (device_id,observed_at,message_id) DO NOTHING. Firmware giữ nguyên khóa khi retry.'],
        ['Thời gian','UTC ở DB/payload; giao diện chuyển UTC+7. Payload muộn tối đa 7 ngày, tương lai tối đa 5 phút.'],
    ],[118,397])
    sub('Tài khoản và biên bảo mật')
    table(['Role','Quyền'],[
        ['iot_admin','Cài đặt, schema và vận hành; không dùng cho API/ingest.'],
        ['iot_ingest','Đọc devices; INSERT/SELECT telemetry; UPDATE riêng last_seen_at. Không đọc user hay DELETE telemetry.'],
        ['iot_app','Role API tin cậy, CRUD nghiệp vụ; không superuser và không CREATE schema.'],
    ],[118,397])
    add('Chưa bật row-level security: API tuần 2 bắt buộc kiểm tra farm_members và lọc theo vườn được cấp quyền. Không cấp credential DB cho trình duyệt. DB native chỉ nghe loopback và dùng SCRAM-SHA-256; chưa có TLS PostgreSQL từ xa.')
    sub('Seed và dữ liệu thử')
    add('1 user demo, 2 vườn (1 vườn kiểm thử phân quyền), 1 lô, 2 trạm, 3 nhãn sâu và 1 mẫu cảm biến. Toàn bộ là dữ liệu tổng hợp. Cảm biến lỗi/không gắn dùng NULL hoặc bỏ trường, không thay bằng 0.')
    add('Kiểm thử aggregate thật: hai mẫu 20°C và 30°C được vật hóa thành count=2, avg=25°C. Fixture được dọn sau kiểm thử.','SmallV')
    page()

    # 5. MQTT.
    heading('04  MQTT bảo mật và hợp đồng telemetry')
    table(['Hạng mục','Thiết lập'],[
        ['Broker','Mosquitto 2.1.2; MQTT v5 dùng trong test, hỗ trợ 3.1.1 cho ESP32.'],
        ['Kết nối','TLS 8883; tối thiểu TLS1.2; xác minh CA + SAN hostname/IP; không anonymous, không listener 1883.'],
        ['Chứng chỉ','CA demo 365 ngày, server 90 ngày. SAN localhost, 127.0.0.1, mosquitto, mqtt.iot.local; thêm IP LAN khi triển khai.'],
        ['Tài khoản','Mỗi station mật khẩu ngẫu nhiên riêng; password file băm PBKDF2-SHA512 với salt riêng.'],
        ['ACL','Trạm chỉ ghi telemetry/status của chính farm/device; backend-ingestor chỉ đọc telemetry/status.'],
        ['Giới hạn','Packet 16 KiB, payload 8 KiB; persistence; hàng đợi tối đa 1.000 message.'],
    ],[112,403])
    sub('Topic và payload')
    add('iot/v1/farms/{farm_id}/devices/{device_id}/telemetry','SmallV')
    add('JSON v1 gồm schema_version, message_id UUID, device_id, farm_id, observed_at UTC Z và measurements. Có thể thêm battery_v và rssi_dbm. Ít nhất một phép đo; không cho trường lạ hay giá trị không hữu hạn.')
    table(['Metric','Đơn vị và miền dữ liệu'],[
        ['temperature_c','°C, -40..125; không phải cam kết độ chính xác cảm biến.'],
        ['air_humidity_pct','%RH, 0..100.'],
        ['soil_moisture_pct','%, 0..100 sau hiệu chuẩn; không gửi ADC thô.'],
        ['battery_v / rssi_dbm','0..30 V / -127..0 dBm.'],
    ],[145,370])
    sub('Giao cho Lộc')
    add('CA public, host/IP có trong SAN, port8883, credential riêng của trạm và JSON Schema. ESP32 cần NTP, xác minh TLS, QoS1 không retain cho telemetry và backoff/retry. Không chuyển private key/CA key cho thiết bị.')
    add('Broker không kiểm tra JSON hay tự ghi DB. Việc disabled thiết bị trong DB không tự thu hồi MQTT; cần đổi/xóa tài khoản và restart/reload broker.','SmallV')
    page()

    # 6. Acceptance evidence and operations.
    heading('05  Kiểm thử và hướng dẫn tái hiện')
    date=datetime.fromisoformat(evidence['executed_at_utc'])
    add(f"Kết quả ghi lúc {date.strftime('%d/%m/%Y %H:%M:%S')} UTC trong output/verification/verification-full.json. Chạy trên binary Windows thật, không dùng mock cho MQTT hoặc PostgreSQL/TimescaleDB.")
    table(['Nhóm','Đạt','Các kiểm tra chính'],[
        ['Hợp đồng JSON','8/8','Payload hợp lệ; sai UUID, topic, độ ẩm, trường dư/thiếu, thời gian, NaN.'],
        ['MQTT/TLS/ACL','11/11','Auth, CA/SAN, TLS1.2, QoS1; chặn anonymous, mật khẩu sai, ghi chéo trạm/vườn, backend ghi và trạm đọc.'],
        ['PostgreSQL/TimescaleDB','12/12','Hypertable/policy, FK/check, chống trùng, role ingest/app.'],
        ['Aggregate thật','1/1','Refresh cagg, xác nhận 2 mẫu trung bình 25°C và dọn dữ liệu thử.'],
    ],[135,45,335])
    sub('Chạy trên Windows từ source')
    for line in [r'.\scripts\setup_windows.ps1',r'.\.venv\Scripts\python.exe scripts/setup_database_windows.py',r'.\.venv\Scripts\python.exe scripts/verify.py --database',r'.\.venv\Scripts\python.exe scripts/demo_telemetry.py --database']:
        add(line,'SmallV')
    add('Python 3.12+, Windows x64; tải binary chính thức ở lần đầu. Không cài Windows service. DB đặt riêng trong LocalAppData để tránh OneDrive và đường dẫn Unicode; vị trí ghi ở .runtime/native-database.json.')
    sub('Trạng thái hiện tại và dừng dịch vụ')
    add('MQTT native: localhost:8883. DB native: 127.0.0.1:5432, database iot. Bí mật nằm trong .secrets/, không đóng gói. Dừng bằng run_broker.ps1 -Stop và setup_database_windows.py --stop; dữ liệu được giữ.')
    sub('Phương án Docker')
    add('compose.yaml cung cấp database + mosquitto, volume và secrets. Đã kiểm tra YAML và tag image; chưa chạy container vì máy chưa có Docker/WSL. Không chạy native và Docker cùng cổng; hai môi trường dùng vùng dữ liệu độc lập.')
    add('Chưa thử ESP32 thật, mạng thực địa, tải dài hạn, backup/restore hoặc triển khai cloud. Đây là các bài phối hợp và giai đoạn tiếp theo, không được ghi nhận như đã đạt.','SmallV')
    page()

    # 7-9. Complete 24 task assessment, copied from the detailed source-grounded review.
    review=(ROOT/'docs/DANH_GIA_PHAN_CONG.md').read_text(encoding='utf-8')
    rows=[]
    for line in review.splitlines():
        if line.startswith('| W'):
            values=[v.strip() for v in line.strip('|').split('|')]
            rows.append(values)
    assert len(rows)==24
    for week in (1,2,3):
        heading(f'0{5+week}  Đánh giá phân công - tuần {week}')
        if week==1: add('Đối chiếu đầy đủ 24 tác vụ, không xác nhận tiến độ của các thành viên khác. Mỗi tuần 8 tác vụ; mỗi người 6 tác vụ trong toàn dự án.','SmallV')
        else: add('Đánh giá sản phẩm, điều kiện phụ thuộc và tiêu chí cần bổ sung để nghiệm thu có căn cứ.','SmallV')
        selected=[row for row in rows if row[0].startswith(f'W{week}-')]
        table(['Mã','Người','Công việc / bàn giao','Đánh giá và điều kiện nghiệm thu'],
              [[r[0],r[1].split('/')[1].strip(),r[2],r[3]] for r in selected],[42,49,150,274],small=True)
        add('Chi tiết và chuỗi phụ thuộc: docs/DANH_GIA_PHAN_CONG.md. Các ưu tiên, trạng thái nguồn chưa được sửa trực tiếp.','SmallV')
        page()

    # 10. Corrections, next handoff, references.
    heading('09  Kiến nghị và bàn giao tiếp theo')
    sub('Những điểm cần chỉnh ở bảng phân công')
    for text in [
        'Chuẩn hóa “Trumg” thành Trung và “P Minh” thành Phạm Minh; dùng mã thành viên/danh sách chọn để tổng hợp không đếm 0 sai.',
        'M1 ghi đã nghiệm thu nhưng 16 dòng chi tiết vẫn đang thực hiện và 8 dòng chưa thực hiện. Cần đồng bộ trạng thái bằng minh chứng, không tự coi toàn nhóm đã hoàn thành.',
        'Bổ sung ngày bắt đầu/hạn thực tế, link sản phẩm và người nghiệm thu. “Ngày 7/14/21” hiện chỉ là mốc tương đối.',
        'Đề nghị nâng broker lên ưu tiên Cao do phụ thuộc firmware/API. Thống nhất mAP50, mAP50-95, precision/recall; không đồng nhất Accuracy với mAP.',
    ]: add(text)
    sub('Phối hợp sau bàn giao tuần 1')
    table(['Thành viên','Việc cần chốt'],[
        ['Lộc','Cảm biến/đơn vị, NTP, CA/credential đúng trạm, test ESP32 thật, quy tắc Deep Sleep/offline.'],
        ['Khởi','Mã nhãn sâu, bbox xyxy chuẩn hóa, định dạng model/input/output, model_version.'],
        ['P Minh','Cấu trúc dữ liệu, đơn vị, múi giờ, dữ liệu thiếu, trạm offline và phân quyền theo vườn.'],
        ['Trung tuần 2','Ingest liên tục có session/ACK/retry; REST/OpenAPI/WebSocket, nhận ảnh, AI và luật cảnh báo.'],
    ],[100,415])
    sub('Tài liệu kỹ thuật tham khảo')
    links=[('PostgreSQL - binary Windows','https://www.postgresql.org/download/windows/'),
           ('TimescaleDB - cài đặt self-hosted','https://www.tigerdata.com/docs/get-started/choose-your-path/install-timescaledb'),
           ('TimescaleDB - hypertable API','https://www.tigerdata.com/docs/reference/timescaledb/hypertables/create_hypertable'),
           ('Mosquitto - cấu hình TLS và ACL','https://www.mosquitto.org/man/mosquitto-conf-5.html')]
    for label,url in links:
        story.append(Paragraph(f'<link href="{url}" color="#146C70">{escape(label)}</link>',styles['SmallV']))
    add('Gói bàn giao kèm SQL, cấu hình, script, tài liệu chi tiết và kết quả kiểm thử; không chứa mật khẩu, private key, runtime hoặc dữ liệu DB.','SmallV')

    OUT.parent.mkdir(parents=True,exist_ok=True)
    def footer(canvas,doc):
        canvas.saveState()
        canvas.setStrokeColor(LINE); canvas.line(40,39,555,39)
        canvas.setFont('Arial',8); canvas.setFillColor(GREY)
        canvas.drawString(40,26,'PTIT | IoT & AI cảnh báo sâu bệnh | Trung - Tuần 1')
        canvas.drawRightString(555,26,f'{doc.page}')
        canvas.restoreState()
    doc=SimpleDocTemplate(str(OUT),pagesize=(595.28,841.89),rightMargin=40,leftMargin=40,
                          topMargin=38,bottomMargin=52,title='Báo cáo tuần 1 - Trung - Hệ thống IoT và AI',
                          author='Trung',pageCompression=1)
    doc.build(story,onFirstPage=footer,onLaterPages=footer)
    print('Created output/pdf/Bao_cao_Tuan_1_Trung.pdf')

if __name__=='__main__': main()
