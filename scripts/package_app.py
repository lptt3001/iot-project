"""Package runnable source without credentials, runtime data or old reports."""
from pathlib import Path
import zipfile

ROOT=Path(__file__).resolve().parents[1]
FILES=['README.md','requirements.txt','requirements-serial.txt','requirements-trap-ai.txt','compose.yaml','compose.cloud.yaml','Dockerfile',
       '.dockerignore','.gitignore','.env.example','.env.cloud.example',
       'START.cmd','STOP.cmd','scripts/launchers/BACKUP.cmd','scripts/launchers/DOCKER_START.cmd',
       'scripts/launchers/DOCKER_STOP.cmd','scripts/launchers/SERIAL_START.cmd','scripts/launchers/SERIAL_STOP.cmd',
       'scripts/launchers/FLASH_CAMERA.cmd']
SCRIPTS=['app_server.py','backup.py','benchmark.py','bootstrap.py','common.py','demo_telemetry.py',
         'trap_detector.py','adapt_trap_model.py','evaluate_trap_adaptation.py','run_trap_inference.py',
         'prepare_pestnu.py','pestnu_yolox.py','train_pestnu.ps1','train_pestnu_cpu.py','evaluate_pestnu.py','export_pestnu.py','telegram-chat-id.ps1',
         'package_app.py','run_broker.ps1','setup_database_windows.py','setup_windows.ps1','start_app.ps1',
         'stop_app.ps1','verify.py','verify_application.py','verify_resilience.py','windows_environment.ps1','docker_app.ps1','verify_docker.py','serial_gateway.py','serial_camera.py','verify_camera.py','build_firmware.ps1','flash_camera.ps1']


def main():
    paths=[ROOT/name for name in FILES]+[ROOT/'scripts'/name for name in SCRIPTS]
    for folder in ('app','contracts','database','infra','tests','firmware'):
        paths.extend(path for path in (ROOT/folder).rglob('*') if path.is_file()
                     and '__pycache__' not in path.parts and path.suffix!='.pyc'
                     and '.wrangler' not in path.parts and not path.name.startswith('.dev.vars')
                     and path.name not in {'mosquitto.local.conf', 'cloud_config.h'})
    target=ROOT/'deliverables/PTIT_Garden_MoPhong.zip'
    target.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(set(paths)):
            archive.write(path,path.relative_to(ROOT).as_posix())
    with zipfile.ZipFile(target) as archive:
        assert archive.testzip() is None
        assert not any(name.startswith(('.secrets/','.runtime/','docs/','output/')) for name in archive.namelist())
        print(f'Packaged {len(archive.namelist())} source files: {target}')


if __name__=='__main__':
    main()
