ALTER TABLE iot.sensor_readings
  ADD COLUMN soil_raw integer CHECK (soil_raw BETWEEN 0 AND 4095),
  ADD COLUMN light_do smallint CHECK (light_do IN (0,1)),
  ADD COLUMN rain_do smallint CHECK (rain_do IN (0,1)),
  ADD COLUMN source text NOT NULL DEFAULT 'legacy'
    CHECK (source IN ('legacy','simulation','hardware','mqtt'));
ALTER TABLE iot.sensor_readings DROP CONSTRAINT sensor_readings_check;
ALTER TABLE iot.sensor_readings ADD CONSTRAINT sensor_readings_check CHECK (
  temperature_c IS NOT NULL OR air_humidity_pct IS NOT NULL OR soil_moisture_pct IS NOT NULL
  OR soil_raw IS NOT NULL OR light_do IS NOT NULL OR rain_do IS NOT NULL
);
