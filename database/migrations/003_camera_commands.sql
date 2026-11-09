CREATE TABLE iot.camera_requests (
 id uuid PRIMARY KEY,
 device_id text NOT NULL REFERENCES iot.devices(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','succeeded','failed')),
 test_mode boolean NOT NULL DEFAULT false,
 image_id uuid REFERENCES iot.image_captures(id),
 error text,
 completed_at timestamptz
);
CREATE INDEX camera_requests_queue ON iot.camera_requests(device_id,created_at) WHERE status IN ('queued','sent');
GRANT SELECT,INSERT,UPDATE,DELETE ON iot.camera_requests TO iot_app;
