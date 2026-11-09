"""Read small verified blocks over UART, then compare the entire backup to device MD5."""
import argparse
from datetime import datetime
import hashlib
from pathlib import Path
import time

from esptool.targets.esp32 import ESP32ROM


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',default='COM5')
    parser.add_argument('--baud',type=int,default=115200)
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]/'.runtime/firmware-backups'
    root.mkdir(parents=True,exist_ok=True)
    chip=ESP32ROM(args.port,115200)
    try:
        chip.connect('no_reset',3)
        chip=chip.STUB_CLASS(chip) if chip.sync_stub_detected else chip.run_stub()
        if args.baud!=115200: chip.change_baud(args.baud)
        chip.flash_spi_attach(0)
        total=4*1024*1024
        target=root/(datetime.now().strftime('%Y%m%d-%H%M%S')+'-verified-before-camera.bin')
        temporary=target.with_suffix('.partial')
        with temporary.open('wb') as output:
            for offset in range(0,total,65536):
                for attempt in range(3):
                    try:
                        data=chip.read_flash(offset,min(65536,total-offset))
                        break
                    except Exception:
                        if attempt==2: raise
                        time.sleep(.2)
                        chip.connect('no_reset',2)
                output.write(data)
                output.flush()
                print(f'Backup {offset+len(data)}/{total} bytes ({(offset+len(data))*100//total}%)',flush=True)
        expected=chip.flash_md5sum(0,total).lower()
        assert hashlib.md5(temporary.read_bytes()).hexdigest()==expected,'Backup MD5 does not match device'
        temporary.replace(target)
        target.with_suffix('.sha256').write_text(hashlib.sha256(target.read_bytes()).hexdigest())
        print('BACKUP_VERIFIED='+str(target),flush=True)
        # Return to ROM UART speed so ordinary esptool commands can reconnect.
        if args.baud!=115200: chip.change_baud(115200)
    finally:
        chip._port.close()


if __name__=='__main__': main()
