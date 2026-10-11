"""Resolve the shipped overlay without starting application or database containers."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize("base", ["docker-compose.yml", "docker-compose.rootless.yml"])
def test_isolated_compose_preserves_peers_and_excludes_server_secrets(tmp_path: Path, base: str) -> None:
    if not shutil.which("docker"):
        pytest.skip("Docker Compose is required to resolve its merge tags")
    docker = Path(__file__).parent.parent / "docker"
    for filename in [base, "docker-compose.ml-isolated.yml"]:
        shutil.copyfile(docker / filename, tmp_path / filename)
    (tmp_path / ".env").write_text(
        "UPLOAD_LOCATION=./media\nDB_DATA_LOCATION=./database\nDB_USERNAME=fixture\n"
        "DB_DATABASE_NAME=fixture\nDB_PASSWORD=server-only-fake\nCLOUD_PROVISIONING_TOKEN=server-only-fake\n"
    )
    if "rootless" in base:
        with (tmp_path / ".env").open("a") as env:
            env.write("FRAMELEAF_ML_CACHE=./ml-model-cache\n")
    (tmp_path / "machine-learning.env").write_text(
        "MACHINE_LEARNING_MODEL_TTL=42\nMACHINE_LEARNING_REQUEST_THREADS=3\nFRAMELEAF_ML_AUTH_TOKEN=worker-fake\n"
    )
    (tmp_path / "model-staging.env").write_text(
        "MACHINE_LEARNING_MODEL_SOURCE_URL=https://private-models.example\n"
        "MACHINE_LEARNING_MODEL_SOURCE_TOKEN=staging-only-fake\n"
    )
    result = subprocess.run(
        [
            "docker",
            "compose",
            "--profile",
            "model-staging",
            "-f",
            base,
            "-f",
            "docker-compose.ml-isolated.yml",
            "config",
            "--format",
            "json",
        ],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    config = json.loads(result.stdout)
    worker = config["services"]["immich-machine-learning"]
    staging = config["services"]["immich-model-staging"]
    assert set(worker["networks"]) == {"ml-inference"}
    assert set(staging["networks"]) == {"ml-downloads"}
    assert set(config["services"]["frameleaf-server"]["networks"]) == {"ml-inference", "default"}
    assert not worker.get("ports")
    assert not staging.get("ports")
    assert worker["security_opt"] == ["no-new-privileges:true"]
    assert staging["security_opt"] == ["no-new-privileges:true"]
    assert "ALL" in worker["cap_drop"] and "ALL" in staging["cap_drop"]
    if "rootless" in base:
        assert worker["user"] == "1000:1000"
    assert worker["environment"]["MACHINE_LEARNING_MODEL_DOWNLOADS"] == "false"
    assert worker["environment"]["MACHINE_LEARNING_MODEL_TTL"] == "42"
    assert worker["environment"]["FRAMELEAF_ML_AUTH_TOKEN"] == "worker-fake"
    assert "DB_PASSWORD" not in worker["environment"]
    assert "CLOUD_PROVISIONING_TOKEN" not in worker["environment"]
    assert "MACHINE_LEARNING_MODEL_SOURCE_TOKEN" not in worker["environment"]
    assert staging["environment"]["MACHINE_LEARNING_MODEL_SOURCE_TOKEN"] == "staging-only-fake"
    assert "CLOUD_PROVISIONING_TOKEN" not in staging["environment"]
    assert len(worker["volumes"]) == 1
    mount = worker["volumes"][0]
    assert mount["target"] == "/cache" and mount["read_only"] is True
    assert mount["source"] == (str(tmp_path / "ml-model-cache") if "rootless" in base else "model-cache")
    assert [mount["target"] for mount in staging["volumes"]] == ["/cache"]
    assert config["networks"]["ml-inference"]["internal"] is True
    assert config["networks"]["ml-inference"]["driver_opts"] == {
        "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
        "com.docker.network.bridge.gateway_mode_ipv6": "isolated",
    }
