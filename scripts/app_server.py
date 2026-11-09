"""Local single-process application with a graceful, project-specific stop signal."""
import os
from pathlib import Path
import sys
import threading
import time

import uvicorn

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)


def main():
    server = uvicorn.Server(uvicorn.Config('app.main:app', host='127.0.0.1', port=8000,
        workers=1, log_level='info', access_log=False))
    pidfile, stopfile = ROOT / '.runtime/app.pid', ROOT / '.runtime/app.stop'
    pidfile.write_text(str(os.getpid()))
    def watch():
        while not server.should_exit:
            try:
                if stopfile.exists() and stopfile.read_text().strip() == str(os.getpid()):
                    server.should_exit = True
                    stopfile.unlink(missing_ok=True)
                    return
            except OSError:
                # Windows/OneDrive can briefly lock a marker while it is written.
                # Keep watching instead of permanently losing the stop listener.
                pass
            time.sleep(.3)
    threading.Thread(target=watch,daemon=True).start()
    try:
        server.run()
    finally:
        if pidfile.exists() and pidfile.read_text().strip()==str(os.getpid()):
            pidfile.unlink(missing_ok=True)


if __name__=='__main__':
    main()
