-- All rows below are synthetic demo fixtures, not field measurements.
INSERT INTO iot.app_users(id,auth_subject,display_name) VALUES
('00000000-0000-4000-8000-000000000001','demo:trung','Trung (demo)');
INSERT INTO iot.farms(id,name) VALUES ('farm-demo','Vườn thử nghiệm PTIT'),('farm-other','Vườn kiểm thử phân quyền');
INSERT INTO iot.farm_members(farm_id,user_id,role) VALUES
('farm-demo','00000000-0000-4000-8000-000000000001','owner');
INSERT INTO iot.plots(id,farm_id,name,crop,area_m2) VALUES
('00000000-0000-4000-8000-000000000010','farm-demo','Lô rau thử nghiệm','Cải',100);
INSERT INTO iot.devices(id,farm_id,plot_id,name,mqtt_username,hardware_model) VALUES
('station-001','farm-demo','00000000-0000-4000-8000-000000000010','Trạm 01','station-001','ESP32 + DHT22/SHT30'),
('station-002','farm-demo','00000000-0000-4000-8000-000000000010','Trạm 02','station-002','ESP32 + DHT22/SHT30');
INSERT INTO iot.pest_species(code,vietnamese_name,scientific_name) VALUES
('sau-to','Sâu tơ','Plutella xylostella'),
('ray-nau','Rầy nâu','Nilaparvata lugens'),
('bo-tri','Bọ trĩ','Thysanoptera (bậc bộ; cần Khởi xác nhận loài)');
INSERT INTO iot.sensor_readings(observed_at,device_id,farm_id,message_id,temperature_c,air_humidity_pct,soil_moisture_pct,battery_v,rssi_dbm)
VALUES (date_trunc('minute',now()) - interval '1 minute','station-001','farm-demo',
'00000000-0000-4000-8000-000000000100',29.5,76.2,58,3.9,-62);
