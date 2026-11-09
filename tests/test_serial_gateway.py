import sys
from pathlib import Path
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from serial_gateway import parse_sample


class SerialTests(unittest.TestCase):
    def test_actual_log(self):
        sample=parse_sample('T=28.0 C | RH=59.0 % | light=0 | rain=1 | soil=4095\r')
        self.assertEqual(sample,dict(temperature_c=28.,air_humidity_pct=59.,light_do=0,rain_do=1,soil_raw=4095))
        self.assertNotIn('soil_moisture_pct',sample)

    def test_missing_dht_is_not_zero(self):
        sample=parse_sample('T=nan C | RH=nan % | light=1 | rain=0 | soil=4000')
        self.assertNotIn('temperature_c',sample)
        self.assertNotIn('air_humidity_pct',sample)
        self.assertEqual(sample['rain_do'],0)

    def test_ignores_chatter_and_bad_adc(self):
        self.assertIsNone(parse_sample('MQTT loi: -2'))
        self.assertIsNone(parse_sample('T=28.0 C | RH=59.0 % | light=0 | rain=1 | soil=9999'))
