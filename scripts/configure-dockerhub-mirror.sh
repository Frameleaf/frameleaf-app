#!/usr/bin/env bash
# Public cache only: keep all existing daemon settings and image references.
set -euo pipefail

sudo python3 - /etc/docker/daemon.json <<'PY'
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

path = Path(sys.argv[1])
contents = path.read_text() if path.exists() else ""
config = json.loads(contents) if contents.strip() else {}
if not isinstance(config, dict):
    raise ValueError("Docker daemon configuration must be an object")
mirrors = config.get("registry-mirrors", [])
if not isinstance(mirrors, list) or not all(isinstance(value, str) for value in mirrors):
    raise ValueError("Docker registry-mirrors must be a list of strings")
if not any(value.rstrip("/") == "https://mirror.gcr.io" for value in mirrors):
    config["registry-mirrors"] = [*mirrors, "https://mirror.gcr.io"]
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o644
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=".frameleaf-docker-")
    try:
        with os.fdopen(descriptor, "w") as output:
            output.write(json.dumps(config, indent=2) + "\n")
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
PY

sudo systemctl restart docker
docker info --format '{{json .RegistryConfig.Mirrors}}' |
  python3 -c 'import json, sys; mirrors = json.load(sys.stdin); assert isinstance(mirrors, list) and any(value.rstrip("/") == "https://mirror.gcr.io" for value in mirrors), "Public Docker Hub mirror is not active"'
