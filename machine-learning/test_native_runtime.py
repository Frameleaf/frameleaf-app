import os
import subprocess
import sys
from pathlib import Path


def test_shared_config_does_not_import_unix_worker_dependencies() -> None:
    script = """
import importlib.abc
import sys
class NoUnixWorker(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "fcntl" or fullname.startswith("gunicorn") or fullname == "uvicorn.workers":
            raise ImportError("Unix worker dependency imported by native configuration: " + fullname)
sys.meta_path.insert(0, NoUnixWorker())
import immich_ml.config
assert "gunicorn.arbiter" not in sys.modules
"""
    result = subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).parent, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_native_settings_require_auth_and_only_use_private_verified_models(tmp_path: Path) -> None:
    import pytest

    from immich_ml.native_runtime import NativeRuntimeOptions, configure_runtime

    options = NativeRuntimeOptions(cache_dir=tmp_path, port=34219)
    configured = configure_runtime(options, {"FRAMELEAF_ML_AUTH_TOKEN": "x" * 48})
    assert configured["MACHINE_LEARNING_MODEL_DOWNLOADS"] == "false"
    assert configured["MACHINE_LEARNING_WORKERS"] == "1"
    assert configured["MACHINE_LEARNING_REQUEST_THREADS"] == "1"
    assert configured["MACHINE_LEARNING_CACHE_FOLDER"] == str(tmp_path.resolve())
    assert configured["FRAMELEAF_HOST"] == "127.0.0.1"
    with pytest.raises(ValueError, match="auth_token_required"):
        configure_runtime(options, {})


def test_native_scope_refuses_transcription_and_unrelated_container_routes() -> None:
    from immich_ml.native_runtime import native_path_allowed

    assert native_path_allowed("/predict")
    assert native_path_allowed("/ping")
    for path in ["/hardware", "/transcribe", "/capabilities", "/docs", "/studio", "/predict/../hardware"]:
        assert not native_path_allowed(path)


def test_container_worker_legacy_import_stays_available() -> None:
    if os.name == "nt":
        return
    from immich_ml.config import CustomUvicornWorker

    assert CustomUvicornWorker.__name__ == "CustomUvicornWorker"


def test_native_transport_authenticates_health_and_blocks_container_routes() -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from immich_ml.native_runtime import NativeScope

    app = FastAPI()

    @app.get("/ping")
    def ping() -> dict[str, bool]:
        return {"ready": True}

    token = "a" * 48
    with TestClient(NativeScope(app, token)) as client:
        assert client.get("/ping").status_code == 401
        assert client.get("/ping", headers={"Authorization": "Bearer wrong"}).status_code == 401
        headers = {"Authorization": "Bearer " + token}
        assert client.get("/ping", headers=headers).json() == {"ready": True}
        assert client.get("/hardware", headers=headers).status_code == 404
        assert client.get("/docs", headers=headers).status_code == 404
        assert client.get("/predict", headers=headers).status_code == 404
        assert client.post("/ping", headers=headers).status_code == 404
        assert client.get("/ping", headers=[("Authorization", "Bearer " + token)] * 2).status_code == 401


def test_native_process_starts_without_gunicorn_and_requires_auth(tmp_path: Path) -> None:
    import socket
    import time
    from urllib.error import HTTPError, URLError
    from urllib.request import Request, urlopen

    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    token = "b" * 48
    environment = dict(os.environ, FRAMELEAF_ML_AUTH_TOKEN=token)
    with (tmp_path / "runtime.log").open("w+") as output:
        process = subprocess.Popen(
            [sys.executable, "-m", "immich_ml.native_runtime", "--cache-dir", str(tmp_path), "--port", str(port)],
            cwd=Path(__file__).parent,
            env=environment,
            stdout=output,
            stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 30
            while True:
                assert process.poll() is None, "native process exited before becoming ready"
                try:
                    with urlopen(Request(f"http://127.0.0.1:{port}/ping"), timeout=1):
                        raise AssertionError("health exposed without authentication")
                except HTTPError as error:
                    assert error.code == 401
                    break
                except URLError:
                    assert time.monotonic() < deadline, "native process did not start"
                    time.sleep(0.1)
            request = Request(f"http://127.0.0.1:{port}/ping", headers={"Authorization": "Bearer " + token})
            with urlopen(request, timeout=5) as response:
                assert response.status == 200
        finally:
            process.terminate()
            process.wait(timeout=15)
        output.seek(0)
        log = output.read()
        assert token not in log
        assert "Starting gunicorn" not in log


def test_native_predict_rejects_studio_tasks_before_model_loading() -> None:
    import pytest
    from fastapi import HTTPException

    from immich_ml.native_runtime import library_entries

    for task in ["inpaint", "semantic-mask", "transcribe"]:
        with pytest.raises(HTTPException) as error:
            library_entries('{"' + task + '": {"visual": {"modelName": "unapproved"}}}')
        assert error.value.status_code == 422
    entries = library_entries('{"clip": {"textual": {"modelName": "ViT-B-32__openai"}}}')
    assert entries[0][0]["task"] == "clip"


def test_unqualified_native_app_cannot_predict() -> None:
    from fastapi.testclient import TestClient

    from immich_ml.native_runtime import create_native_app

    with TestClient(create_native_app(None)) as client:
        response = client.post("/predict", data={"entries": "{}", "text": "fixture"})
        assert response.status_code == 503


def test_bound_native_app_refuses_changed_request_and_changed_runtime(monkeypatch) -> None:
    from fastapi.testclient import TestClient

    from immich_ml import main
    from immich_ml.native_runtime import create_native_app

    class Binding:
        calls = 0
        changed = False

        def check(self, entries, kind):
            self.calls += 1
            if entries != {"clip": {"textual": {"modelName": "ViT-B-32__openai"}}} or kind != "text":
                raise ValueError("native_request_binding_mismatch")
            if self.changed:
                raise ValueError("native_runtime_or_driver_changed")
            return ([], [])

    binding = Binding()

    async def predict(**kwargs):
        assert main.active_requests > 0, "native request must retain existing idle-shutdown fencing"
        binding.changed = True
        return main.ORJSONResponse({"clip": "[1,2]"})

    monkeypatch.setattr(main, "predict", predict)
    entries = '{"clip":{"textual":{"modelName":"ViT-B-32__openai"}}}'
    with TestClient(create_native_app(binding)) as client:
        assert client.post("/predict", data={"entries": "{}", "text": "fixture"}).status_code == 409
        assert binding.calls == 1
        response = client.post("/predict", data={"entries": entries, "text": "fixture"})
        assert response.status_code == 409
        assert "clip" not in response.json()
        assert binding.calls == 3
