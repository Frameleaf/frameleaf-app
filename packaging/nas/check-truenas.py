"""Render both ML settings with the matching TrueNAS catalog library (no containers)."""
import copy
import hashlib
import importlib
import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

import jinja2
import yaml

app, library = map(Path, sys.argv[1:])
metadata = yaml.safe_load((app / "app.yaml").read_text())
if library.name != "base_v" + metadata["lib_version"].replace(".", "_"):
    raise ValueError("TrueNAS library version mismatch")
if not library.is_dir() or library.is_symlink():
    raise ValueError("Missing or symlinked TrueNAS library")
files = []
for entry in library.rglob("*"):
    if entry.is_symlink():
        raise ValueError("Symlink in TrueNAS library")
    if entry.is_file():
        files.append(entry)
if not files:
    raise ValueError("Empty TrueNAS library")
expected_hash = metadata["lib_version_hash"]
if not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
    raise ValueError("Invalid TrueNAS library hash")
# TrueNAS apps_validation/catalog_reader/hash_utils.py: hash each regular file,
# sort sha256sum lines, take their first fields, then hash the newline-separated digests.
# Equal digests produce identical fields, so their filename tie order cannot affect the result.
digests = sorted(hashlib.sha256(entry.read_bytes()).hexdigest() for entry in files)
actual_hash = hashlib.sha256(("\n".join(digests) + "\n").encode()).hexdigest()
if actual_hash != expected_hash:
    raise ValueError("TrueNAS library hash mismatch")
# Verification precedes every library import; avoid mutating its pinned source with bytecode.
sys.dont_write_bytecode = True
sys.path.insert(0, str(library.parent))
render = importlib.import_module(f"{library.name}.render")
values = yaml.safe_load((app / "templates/test_values/basic-values.yaml").read_text())
values.update(yaml.safe_load((app / "ix_values.yaml").read_text()))
values["ix_context"] = {"app_name": "frameleaf", "app_metadata": metadata}
template = jinja2.Environment(extensions=["jinja2.ext.do"], undefined=jinja2.StrictUndefined).from_string(
    (app / "templates/docker-compose.yaml").read_text()
)
for enabled in (False, True):
    candidate = copy.deepcopy(values)
    candidate["frameleaf"]["enable_ml"] = enabled
    result = json.loads(template.render(values=candidate, ix_lib=SimpleNamespace(base=SimpleNamespace(render=render))))
    assert result["services"]["server"]["environment"]["FRAMELEAF_MACHINE_LEARNING_ENABLED"] == str(enabled).lower()
    assert ("machine-learning" in result["services"]) == enabled
    # FL-300: no metrics ports are asked for, published or passed to the server
    assert not any("METRICS" in name for name in result["services"]["server"]["environment"])
    assert "api_metrics_port" not in candidate["network"] and "microservices_metrics_port" not in candidate["network"]
    postgres = result["services"]["postgres"]
    assert postgres["environment"]["PGDATA"] == "/var/lib/postgresql/19/docker"
    assert postgres["user"] == "999:999"
    assert any(mount["target"] == "/var/lib/postgresql" for mount in postgres["volumes"])
    assert "pg_isready" in str(postgres["healthcheck"])
    db = candidate["images"]["pgvector_19_image"]
    assert result["services"]["postgres"]["image"] == f'{db["repository"]}:{db["tag"]}'
    assert result["services"]["postgres"]["image"].startswith("ghcr.io/frameleaf/frameleaf-postgres:")
print("TrueNAS library render passed with ML disabled and enabled")
