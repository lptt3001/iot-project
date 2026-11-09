"""Package reviewable source, documents and evidence; exclude all private/runtime data."""
from pathlib import Path
import zipfile

ROOT=Path(__file__).resolve().parents[1]
TARGET=ROOT/'deliverables/Trung_Tuan1_IoT.zip'
ALLOWED_ROOT={'.gitignore','.env.example','README.md','compose.yaml','requirements.txt'}
ALLOWED_DIRS={'database','infra','contracts','scripts','tests','docs'}
REJECTED={'.secrets','.runtime','.venv','.wrangler','node_modules','__pycache__'}

def main():
    TARGET.parent.mkdir(exist_ok=True)
    paths=[]
    for path in ROOT.rglob('*'):
        if not path.is_file(): continue
        rel=path.relative_to(ROOT)
        if any(part in REJECTED for part in rel.parts): continue
        if path.name=='mosquitto.local.conf' or path.name.startswith('.dev.vars') or path.suffix in ('.pyc','.log','.zip'): continue
        if (rel.parts[0] in ALLOWED_DIRS or rel.as_posix() in ALLOWED_ROOT
                or rel.parts[:2]==('output','verification')
                or (rel.parts[:2]==('output','pdf') and path.suffix=='.pdf')):
            paths.append(path)
    with zipfile.ZipFile(TARGET,'w',zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(paths):
            rel=path.relative_to(ROOT).as_posix()
            info=zipfile.ZipInfo(rel)
            info.create_system=3
            info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=(0o100755 if path.suffix=='.sh' else 0o100644)<<16
            archive.writestr(info,path.read_bytes())
    with zipfile.ZipFile(TARGET) as archive:
        assert archive.testzip() is None
        for name in archive.namelist():
            assert not any(part in REJECTED for part in Path(name).parts)
            assert not name.endswith(('server.key','ca.key','credentials.json','mosquitto.local.conf'))
        print(f'Packaged {len(archive.namelist())} public files: {TARGET.relative_to(ROOT).as_posix()}')

if __name__=='__main__': main()
