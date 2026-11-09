-- PostgreSQL 17 core schema; init scripts run once on a new data volume.
BEGIN;
SET TIME ZONE 'UTC';
CREATE SCHEMA iot;

CREATE TABLE iot.app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text NOT NULL UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE iot.farms (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE iot.farm_members (
  farm_id text NOT NULL REFERENCES iot.farms(id),
  user_id uuid NOT NULL REFERENCES iot.app_users(id),
  role text NOT NULL CHECK (role IN ('owner','operator','viewer')),
  PRIMARY KEY (farm_id,user_id)
);
CREATE TABLE iot.plots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id text NOT NULL REFERENCES iot.farms(id),
  name text NOT NULL,
  crop text,
  area_m2 numeric CHECK (area_m2 > 0),
  UNIQUE (id,farm_id)
);
CREATE TABLE iot.devices (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  farm_id text NOT NULL REFERENCES iot.farms(id),
  plot_id uuid,
  name text NOT NULL,
  mqtt_username text NOT NULL UNIQUE,
  hardware_model text,
  firmware_version text,
  latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude BETWEEN -180 AND 180),
  enabled boolean NOT NULL DEFAULT true,
  installed_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  UNIQUE (id,farm_id),
  FOREIGN KEY (plot_id,farm_id) REFERENCES iot.plots(id,farm_id)
);

CREATE TABLE iot.sensor_readings (
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  device_id text NOT NULL,
  farm_id text NOT NULL,
  message_id uuid NOT NULL,
  temperature_c double precision CHECK (temperature_c BETWEEN -40 AND 125),
  air_humidity_pct double precision CHECK (air_humidity_pct BETWEEN 0 AND 100),
  soil_moisture_pct double precision CHECK (soil_moisture_pct BETWEEN 0 AND 100),
  battery_v double precision CHECK (battery_v BETWEEN 0 AND 30),
  rssi_dbm smallint CHECK (rssi_dbm BETWEEN -127 AND 0),
  PRIMARY KEY (device_id,observed_at,message_id),
  FOREIGN KEY (device_id,farm_id) REFERENCES iot.devices(id,farm_id),
  CHECK (temperature_c IS NOT NULL OR air_humidity_pct IS NOT NULL OR soil_moisture_pct IS NOT NULL),
  CHECK (observed_at <= received_at + interval '5 minutes')
);
CREATE INDEX sensor_readings_farm_time ON iot.sensor_readings(farm_id,observed_at DESC);

CREATE TABLE iot.image_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id text NOT NULL,
  farm_id text NOT NULL,
  captured_at timestamptz NOT NULL,
  object_key text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  width_px integer NOT NULL CHECK (width_px > 0),
  height_px integer NOT NULL CHECK (height_px > 0),
  FOREIGN KEY (device_id,farm_id) REFERENCES iot.devices(id,farm_id)
);
CREATE TABLE iot.pest_species (
  code text PRIMARY KEY,
  vietnamese_name text NOT NULL,
  scientific_name text NOT NULL
);
CREATE TABLE iot.inference_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id uuid NOT NULL REFERENCES iot.image_captures(id),
  model_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  error_message text,
  UNIQUE (image_id,model_version)
);
CREATE TABLE iot.pest_detections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inference_id uuid NOT NULL REFERENCES iot.inference_runs(id),
  pest_code text NOT NULL REFERENCES iot.pest_species(code),
  confidence double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  x_min double precision NOT NULL CHECK (x_min >= 0),
  y_min double precision NOT NULL CHECK (y_min >= 0),
  x_max double precision NOT NULL CHECK (x_max <= 1 AND x_max > x_min),
  y_max double precision NOT NULL CHECK (y_max <= 1 AND y_max > y_min)
);
CREATE TABLE iot.alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id text NOT NULL REFERENCES iot.farms(id),
  name text NOT NULL,
  metric text NOT NULL CHECK (metric IN ('temperature_c','air_humidity_pct','soil_moisture_pct','pest_count')),
  operator text NOT NULL CHECK (operator IN ('gt','gte','lt','lte')),
  threshold double precision NOT NULL CHECK (threshold > '-Infinity'::float8 AND threshold < 'Infinity'::float8),
  window_minutes integer NOT NULL CHECK (window_minutes BETWEEN 1 AND 10080),
  cooldown_minutes integer NOT NULL DEFAULT 60 CHECK (cooldown_minutes > 0),
  enabled boolean NOT NULL DEFAULT false,
  UNIQUE (id,farm_id)
);
CREATE TABLE iot.alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id text NOT NULL REFERENCES iot.farms(id),
  device_id text NOT NULL,
  rule_id uuid,
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  message text NOT NULL,
  triggered_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  FOREIGN KEY (device_id,farm_id) REFERENCES iot.devices(id,farm_id),
  FOREIGN KEY (rule_id,farm_id) REFERENCES iot.alert_rules(id,farm_id)
);
CREATE INDEX alerts_farm_time ON iot.alerts(farm_id,triggered_at DESC);
CREATE TABLE iot.notification_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id uuid NOT NULL REFERENCES iot.alerts(id),
  channel text NOT NULL CHECK (channel IN ('telegram','zalo')),
  recipient_ref text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  sent_at timestamptz,
  UNIQUE (alert_id,channel,recipient_ref)
);
COMMIT;
