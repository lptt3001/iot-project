import base64
import io
from pathlib import Path
import sys
import tempfile
import unittest
import uuid

from PIL import Image

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from serial_camera import CameraBridge


class CameraProtocolTests(unittest.TestCase):
    def make_bridge(self, folder):
        bridge=CameraBridge.__new__(CameraBridge)
        bridge.folder=Path(folder)
        bridge.active=None
        return bridge

    def test_jpeg_reassembled_exactly(self):
        buf=io.BytesIO(); Image.new('RGB',(100,80),'green').save(buf,format='JPEG')
        data=buf.getvalue(); ident=str(uuid.uuid4())
        with tempfile.TemporaryDirectory() as folder:
            bridge=self.make_bridge(folder)
            bridge.line(f'@IMGBEGIN {ident} {len(data)}')
            for offset in range(0,len(data),384):
                bridge.line('@IMGDATA '+base64.b64encode(data[offset:offset+384]).decode())
            bridge.line('@IMGEND '+ident)
            self.assertEqual((Path(folder)/(ident+'.jpg')).read_bytes(),data)

    def test_missing_chunk_is_rejected(self):
        ident=str(uuid.uuid4())
        with tempfile.TemporaryDirectory() as folder:
            bridge=self.make_bridge(folder)
            bridge.line(f'@IMGBEGIN {ident} 1000')
            bridge.line('@IMGDATA /9j/2Q==')
            with self.assertRaises(ValueError): bridge.line('@IMGEND '+ident)
            self.assertEqual(list(Path(folder).glob('*.jpg')),[])

    def test_oversize_and_path_injection_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            bridge=self.make_bridge(folder)
            with self.assertRaises(ValueError): bridge.line('@IMGBEGIN ../../escape 100')
            with self.assertRaises(ValueError): bridge.line(f'@IMGBEGIN {uuid.uuid4()} 99999999')
