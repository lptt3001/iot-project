"""Build the Cloudflare UI with cloud-only overrides; leave Docker's app/static intact."""
from pathlib import Path
import argparse
import os
import shutil
import sys
import json
import hashlib
import re

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]


def build(target):
    ai = ROOT / "infra/cloudflare/ai"
    config = json.loads((ai / "model.json").read_text(encoding="utf-8"))
    for kind in ("insect", "species"):
        name = config[f"{kind}_model"]
        if not re.fullmatch(r"model-[a-f0-9]{12}\.onnx", name):
            raise ValueError("Invalid model filename")
        if hashlib.sha256((ai / name).read_bytes()).hexdigest() != config[f"{kind}_sha256"]:
            raise ValueError("Model hash mismatch")
    allowed = {ROOT / "infra/cloudflare/.build/dashboard-assets"}
    camera = Path(os.environ.get("LOCALAPPDATA", "")) / "PTIT-Garden-Camera"
    allowed.update(camera / name / "dashboard-assets" for name in ("cloudflare-release", "cloudflare-capture-check"))
    if target.resolve() not in {p.resolve() for p in allowed} or target.is_symlink():
        raise ValueError("Output must be a recognized generated Cloudflare asset directory.")
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    for name in ("index.html", "app.js", "style.css", "accounts.css", "login.html", "login.js"):
        shutil.copy2(ROOT / "app/static" / name, target / name)
    shutil.copytree(ROOT / "app/static/ai/ort-1.22.0", target / "ai/ort-1.22.0")
    shutil.copytree(ROOT / "app/static/ai/licenses", target / "ai/licenses")
    shutil.copytree(ROOT / "infra/cloudflare/dashboard", target, dirs_exist_ok=True)
    shutil.copy2(ROOT / "infra/cloudflare/knowledge/plant-knowledge.cjs", target / "plant-knowledge.js")
    shutil.copytree(ROOT / "infra/cloudflare/ai", target / "ai", dirs_exist_ok=True)
    print(f"Built Cloudflare assets: {target}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "infra/cloudflare/.build/dashboard-assets")
    build(parser.parse_args().output)
