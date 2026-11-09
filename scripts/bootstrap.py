"""Create local demo secrets and a private CA. Existing credentials are preserved."""
from __future__ import annotations
import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import ipaddress
import json
from pathlib import Path
import secrets
import shutil

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--san', action='append', default=[], help='Extra MQTT DNS name or IP; generate before first start')
    parser.add_argument('--http-device', action='append', choices=('station-001', 'station-002'), default=[],
                        help='Provision a station token for HTTPS ingress')
    args = parser.parse_args()
    private = ROOT / '.secrets'
    certs = private / 'certs'
    certs.mkdir(parents=True, exist_ok=True)
    private.chmod(0o700)
    if args.http_device:
        token_path = private / 'device-http.json'
        tokens = json.loads(token_path.read_text()) if token_path.exists() else {}
        for device_id in args.http_device:
            if device_id not in tokens:
                tokens[device_id] = secrets.token_urlsafe(32)
        token_path.touch(mode=0o600, exist_ok=True)
        token_path.write_text(json.dumps(tokens, indent=2) + '\n')
        token_path.chmod(0o600)
    credentials_path = private / 'credentials.json'
    if credentials_path.exists():
        credentials = json.loads(credentials_path.read_text())
    else:
        credentials = {u: secrets.token_urlsafe(32) for u in ('station-001','station-002','backend-ingestor')}
        credentials_path.write_text(json.dumps(credentials, indent=2) + '\n')
    credentials_path.chmod(0o600)
    for name in ('db_admin_password','db_app_password','db_ingest_password'):
        path = private / name
        if not path.exists():
            path.write_text(secrets.token_urlsafe(40) + '\n')
        path.chmod(0o600)
    # Mosquitto's $7$ SHA512-PBKDF2 password format. Independent random salt per user.
    lines = []
    for username, password in credentials.items():
        salt = secrets.token_bytes(12)
        digest = hashlib.pbkdf2_hmac('sha512',password.encode(),salt,210000,dklen=64)
        lines.append(f'{username}:$7$210000${base64.b64encode(salt).decode()}${base64.b64encode(digest).decode()}')
    # The bind-mounted file must be readable by container uid 1883. Parent remains private.
    (private / 'mqtt-passwords').write_text('\n'.join(lines) + '\n')
    (private / 'mqtt-passwords').chmod(0o644)

    cert_files = [certs / n for n in ('ca.key','ca.crt','server.key','server.crt')]
    if any(p.exists() for p in cert_files) and not all(p.exists() for p in cert_files):
        raise SystemExit('Incomplete certificate set. Restore it or move .secrets/certs aside before regenerating.')
    if not (certs / 'server.crt').exists():
        now = datetime.now(timezone.utc)
        ca_key = rsa.generate_private_key(public_exponent=65537,key_size=3072)
        ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'PTIT IoT Demo CA')])
        ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
              .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
              .not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=365))
              .add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True)
              .add_extension(x509.KeyUsage(False,False,False,False,False,True,True,False,False),critical=True)
              .sign(ca_key,hashes.SHA256()))
        server_key = rsa.generate_private_key(public_exponent=65537,key_size=2048)
        server_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'mqtt.iot.local')])
        names = ['localhost','mosquitto','mqtt.iot.local','127.0.0.1', *args.san]
        sans = []
        for value in dict.fromkeys(names):
            try:
                sans.append(x509.IPAddress(ipaddress.ip_address(value)))
            except ValueError:
                sans.append(x509.DNSName(value))
        server = (x509.CertificateBuilder().subject_name(server_name).issuer_name(ca_name)
                  .public_key(server_key.public_key()).serial_number(x509.random_serial_number())
                  .not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=90))
                  .add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True)
                  .add_extension(x509.SubjectAlternativeName(sans),critical=False)
                  .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),critical=False)
                  .add_extension(x509.KeyUsage(True,False,True,False,False,False,False,False,False),critical=True)
                  .sign(ca_key,hashes.SHA256()))
        for name,key in [('ca.key',ca_key),('server.key',server_key)]:
            (certs / name).write_bytes(key.private_bytes(serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
            (certs / name).chmod(0o600 if name == 'ca.key' else 0o644)
        (certs / 'ca.crt').write_bytes(ca.public_bytes(serialization.Encoding.PEM))
        (certs / 'server.crt').write_bytes(server.public_bytes(serialization.Encoding.PEM))
    elif args.san:
        existing = x509.load_pem_x509_certificate((certs / 'server.crt').read_bytes())
        ext = existing.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        available = set(ext.get_values_for_type(x509.DNSName)) | {str(v) for v in ext.get_values_for_type(x509.IPAddress)}
        missing = set(args.san) - available
        if missing:
            raise SystemExit(f'Existing certificate lacks SAN {sorted(missing)}. Move certs aside and re-run to reissue; then restart broker.')

    (ROOT / '.runtime' / 'mosquitto-data').mkdir(parents=True,exist_ok=True)
    template = (ROOT / 'infra/mosquitto/mosquitto.conf').read_text()
    replacements = {
        'listener 8883 0.0.0.0': 'listener 8883 127.0.0.1',
        '/mosquitto/config/passwords': '.secrets/mqtt-passwords',
        '/mosquitto/config/acl': 'infra/mosquitto/acl',
        '/mosquitto/certs/': '.secrets/certs/',
        '/mosquitto/data/': '.runtime/mosquitto-data/',
    }
    for before,after in replacements.items():
        template = template.replace(before,after)
    (ROOT / 'infra/mosquitto/mosquitto.local.conf').write_text(template)
    if not (ROOT / '.env').exists():
        shutil.copyfile(ROOT / '.env.example', ROOT / '.env')
    print('Local credentials, CA, server certificate and broker configuration are ready. No secrets printed.')

if __name__ == '__main__':
    main()
