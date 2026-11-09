"""Framed base64 camera transfer over the same UART as sensor logs."""
import base64
import json
import logging
from pathlib import Path
import time
import uuid

import httpx

log=logging.getLogger('serial-camera')


class CameraBridge:
    def __init__(self, root, api, device):
        self.folder=Path(root)/'.runtime/serial-images'/device
        self.folder.mkdir(parents=True,exist_ok=True)
        self.device=device
        self.http=httpx.Client(base_url=api,headers={'X-Garden-Request':'1'},timeout=8)
        self.ready=False
        self.active=None
        self.last_poll=0
        self.last_hello=0
        self.last_heartbeat=0
        self.login()

    def login(self):
        self.http.post('/api/session').raise_for_status()

    def line(self, line):
        if line.startswith('@CAMREADY '):
            self.ready=True
            log.info('Firmware supports USB camera.')
            return True
        if line.startswith('@IMGBEGIN '):
            _, ident, size=line.split()
            ident=str(uuid.UUID(ident))
            size=int(size)
            if not 4<=size<=2*1024*1024:
                raise ValueError('Invalid camera image size')
            self.active={'id':ident,'size':size,'data':bytearray(),'at':time.monotonic()}
            return True
        if line.startswith('@IMGDATA '):
            if self.active:
                block=base64.b64decode(line[9:],validate=True)
                self.active['data'].extend(block)
                if len(self.active['data'])>self.active['size']:
                    self.active=None
                    raise ValueError('Camera image exceeds declared size')
            return True
        if line.startswith('@IMGEND '):
            if self.active:
                frame=self.active
                self.active=None
                data=frame['data']
                if line[8:]!=frame['id'] or len(data)!=frame['size'] or data[:2]!=b'\xff\xd8' or data[-2:]!=b'\xff\xd9':
                    raise ValueError('Incomplete/corrupt JPEG over serial')
                target=self.folder/(frame['id']+'.jpg')
                temporary=target.with_suffix('.partial')
                temporary.write_bytes(data)
                temporary.replace(target)
                log.info('Real JPEG received: %s (%s bytes)',frame['id'],len(data))
            return True
        if line.startswith('@IMGERROR '):
            _,ident,reason=line.split(' ',2)
            ident=str(uuid.UUID(ident))
            self.active=None
            self.http.post(f'/api/camera/requests/{ident}/fail',json={'error':reason}).raise_for_status()
            log.warning('Camera refused capture: %s',reason)
            return True
        return False

    def tick(self, port):
        if self.active:
            if time.monotonic()-self.active['at']>90:
                log.warning('Camera transfer timed out.')
                self.active=None
            return
        if not port.is_open:
            self.ready=False
            return
        if time.monotonic()-self.last_hello>10:
            port.write(b'CAMERA_HELLO\n')
            self.last_hello=time.monotonic()
        if time.monotonic()-self.last_poll<2:
            return
        self.last_poll=time.monotonic()
        try:
            if time.monotonic()-self.last_heartbeat>5:
                heartbeat=self.http.post('/api/camera/heartbeat',json={'device_id':self.device,'ready':self.ready})
                if heartbeat.status_code==401:
                    self.login()
                    return
                heartbeat.raise_for_status()
                self.last_heartbeat=time.monotonic()
            for image in sorted(self.folder.glob('*.jpg'))[:1]:
                ident=str(uuid.UUID(image.stem))
                with image.open('rb') as f:
                    response=self.http.post('/api/camera/serial-upload',params={'capture_id':ident,'device_id':self.device},
                        files={'file':(image.name,f,'image/jpeg')})
                if response.status_code==401:
                    self.login()
                    return
                response.raise_for_status()
                image.unlink()
                log.info('Backend saved real image %s',ident)
            if self.ready:
                response=self.http.post('/api/camera/claim',json={'device_id':self.device})
                if response.status_code==401:
                    self.login()
                    return
                response.raise_for_status()
                command=response.json()
                if command:
                    port.write(f"PHOTO:{command['id']}:{int(command['test_mode'])}\n".encode('ascii'))
                    log.info('Photo command sent to ESP32: %s',command['id'])
        except (httpx.HTTPError,ValueError) as exc:
            log.warning('Camera backend retry: %s',exc)

    def close(self):
        self.http.close()
