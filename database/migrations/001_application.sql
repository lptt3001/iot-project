CREATE TABLE iot.app_settings (key text PRIMARY KEY, value jsonb NOT NULL);
INSERT INTO iot.app_settings VALUES ('simulation', '{"running":true,"scenario":"normal","interval_seconds":5,"camera_seconds":45,"offline_devices":[]}');
CREATE TABLE iot.local_notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id uuid NOT NULL UNIQUE REFERENCES iot.alerts(id),
  created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz
);
CREATE TABLE iot.device_status (
  device_id text PRIMARY KEY REFERENCES iot.devices(id),
  online boolean NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE iot.ingest_rejections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(), topic text NOT NULL, reason text NOT NULL
);
ALTER TABLE iot.image_captures ADD COLUMN source text NOT NULL DEFAULT 'upload';
ALTER TABLE iot.image_captures ADD COLUMN simulation_count integer;
ALTER TABLE iot.inference_runs ADD COLUMN attempts integer NOT NULL DEFAULT 0;
UPDATE iot.devices SET latitude=21.0285, longitude=105.8048 WHERE id='station-001';
UPDATE iot.devices SET latitude=21.0288, longitude=105.8052 WHERE id='station-002';
INSERT INTO iot.alert_rules (farm_id,name,metric,operator,threshold,window_minutes,cooldown_minutes,enabled) VALUES
('farm-demo','Nhiệt độ cao (demo)','temperature_c','gte',35,1,5,true),
('farm-demo','Không khí ẩm (demo)','air_humidity_pct','gte',85,1,5,true),
('farm-demo','Đất khô (demo)','soil_moisture_pct','lte',30,1,5,true),
('farm-demo','Mật độ sâu cao (demo)','pest_count','gte',5,1,5,true);
CREATE INDEX captures_farm_time ON iot.image_captures(farm_id,captured_at DESC);
CREATE INDEX inference_queue ON iot.inference_runs(status,created_at);
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA iot TO iot_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA iot TO iot_app;
