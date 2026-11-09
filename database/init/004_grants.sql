GRANT USAGE ON SCHEMA iot TO iot_app,iot_ingest;
-- iot_app is the future trusted API service; farm authorization belongs in that API.
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA iot TO iot_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA iot TO iot_app;
GRANT SELECT ON iot.devices TO iot_ingest;
GRANT INSERT,SELECT ON iot.sensor_readings TO iot_ingest;
GRANT UPDATE(last_seen_at) ON iot.devices TO iot_ingest;
ALTER DEFAULT PRIVILEGES IN SCHEMA iot GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO iot_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA iot GRANT USAGE,SELECT ON SEQUENCES TO iot_app;
