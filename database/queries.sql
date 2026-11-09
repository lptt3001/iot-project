-- Latest measurements for a device (replace example ids with bound API parameters).
SELECT * FROM iot.sensor_readings
WHERE device_id = 'station-001' AND observed_at >= now() - interval '24 hours'
ORDER BY observed_at DESC LIMIT 100;

-- Hourly chart, half-open date range prevents double-counting at boundaries.
SELECT bucket,sample_count,avg_temperature_c,avg_air_humidity_pct,avg_soil_moisture_pct
FROM iot.telemetry_hourly
WHERE farm_id = 'farm-demo' AND bucket >= now() - interval '7 days' AND bucket < now()
ORDER BY bucket;

-- Readiness of the time-series engine and retention/refresh background jobs.
SELECT * FROM timescaledb_information.hypertables WHERE hypertable_schema = 'iot';
SELECT application_name,proc_name,schedule_interval FROM timescaledb_information.jobs;
