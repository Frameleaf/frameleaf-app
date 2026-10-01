"""Render both ML settings with the matching TrueNAS catalog library (no containers)."""
import copy
import importlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import jinja2
import yaml

app, library = map(Path, sys.argv[1:])
metadata = yaml.safe_load((app / "app.yaml").read_text())
assert library.name == "base_v" + metadata["lib_version"].replace(".", "_")
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
    postgres = result["services"]["pgvecto"]
    assert postgres["environment"]["PGDATA"] == "/var/lib/postgresql/14/docker"
    assert postgres["user"] == "999:999"
    assert any(mount["target"] == "/var/lib/postgresql" for mount in postgres["volumes"])
    assert "pg_isready" in str(postgres["healthcheck"])
    db = candidate["images"]["vectorchord_14_image"]
    assert result["services"]["pgvecto"]["image"] == f'{db["repository"]}:{db["tag"]}'
    assert result["services"]["pgvecto"]["image"].startswith("ghcr.io/frameleaf/frameleaf-postgres:")
print("TrueNAS library render passed with ML disabled and enabled")
