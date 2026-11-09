-- Mandatory extension, no silent fallback to a plain table.
CREATE EXTENSION IF NOT EXISTS timescaledb;
SELECT create_hypertable('iot.sensor_readings', by_range('observed_at', INTERVAL '1 day'), if_not_exists => TRUE);
SELECT add_retention_policy('iot.sensor_readings', INTERVAL '90 days', if_not_exists => TRUE);

CREATE MATERIALIZED VIEW iot.telemetry_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT farm_id, device_id, time_bucket(INTERVAL '1 hour',observed_at) AS bucket,
  count(*) AS sample_count,
  avg(temperature_c) AS avg_temperature_c,
  min(temperature_c) AS min_temperature_c,
  max(temperature_c) AS max_temperature_c,
  avg(air_humidity_pct) AS avg_air_humidity_pct,
  avg(soil_moisture_pct) AS avg_soil_moisture_pct
FROM iot.sensor_readings
GROUP BY farm_id,device_id,bucket
WITH NO DATA;
SELECT add_continuous_aggregate_policy('iot.telemetry_hourly',
  start_offset => INTERVAL '8 days', end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '15 minutes', if_not_exists => TRUE);
SELECT add_retention_policy('iot.telemetry_hourly', INTERVAL '365 days', if_not_exists => TRUE);
