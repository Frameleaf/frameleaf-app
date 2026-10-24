import os
import subprocess
import sys
from pathlib import Path


def test_native_startup_preloads_before_health() -> None:
    from fastapi.testclient import TestClient

    from frameleaf_ml.native_runtime import create_native_app

    class Binding:
        loaded = False

        async def preload(self):
            self.loaded = True

    binding = Binding()
    with TestClient(create_native_app(binding)) as client:
        assert binding.loaded
        assert client.get("/ping").status_code == 200


def test_failed_native_preload_prevents_readiness() -> None:
    import pytest
    from fastapi.testclient import TestClient

    from frameleaf_ml.native_runtime import create_native_app

    class Binding:
        async def preload(self):
            raise ValueError("native_staged_hash_mismatch")

    with pytest.raises(ValueError, match="native_staged_hash_mismatch"):
        with TestClient(create_native_app(Binding())):
            raise AssertionError("startup published readiness after preload failure")


def test_native_settings_pin_models_and_refuse_conflicting_preload_aliases(tmp_path: Path, monkeypatch) -> None:
    from frameleaf_ml.config import Settings
    from frameleaf_ml.native_runtime import NativeRuntimeOptions, configure_runtime

    environment = {"FRAMELEAF_ML_AUTH_TOKEN": "x" * 48}
    for key, value in {
        "MACHINE_LEARNING_MODEL_DOWNLOADS": "true",
        "MACHINE_LEARNING_MODEL_TTL": "1",
        "MACHINE_LEARNING_PRELOAD__CLIP__VISUAL": "unapproved",
        "MACHINE_LEARNING_CACHE_FOLDER": "/unapproved",
    }.items():
        environment[key] = environment[key.lower()] = value
    configured = configure_runtime(NativeRuntimeOptions(tmp_path, 34219), environment)
    assert not any(key.upper().startswith("MACHINE_LEARNING_PRELOAD") for key in configured)
    for key in list(os.environ):
        if key.upper().startswith("MACHINE_LEARNING_"):
            monkeypatch.delenv(key)
    for key, value in configured.items():
        monkeypatch.setenv(key, value)
    actual = Settings()
    assert actual.model_downloads is False
    assert actual.model_ttl == 0
    assert actual.cache_folder == tmp_path.resolve()
    assert actual.preload is None


def test_shared_config_does_not_import_unix_worker_dependencies() -> None:
    script = """
import importlib.abc
import sys
class NoUnixWorker(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "fcntl" or fullname.startswith("gunicorn") or fullname == "uvicorn.workers":
            raise ImportError("Unix worker dependency imported by native configuration: " + fullname)
sys.meta_path.insert(0, NoUnixWorker())
import frameleaf_ml.config
assert "gunicorn.arbiter" not in sys.modules
"""
    result = subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).parent, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr


def test_native_settings_require_auth_and_only_use_private_verified_models(tmp_path: Path) -> None:
    import pytest

    from frameleaf_ml.native_runtime import NativeRuntimeOptions, configure_runtime

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
    from frameleaf_ml.native_runtime import native_path_allowed

    assert native_path_allowed("/predict")
    assert native_path_allowed("/ping")
    for path in ["/hardware", "/transcribe", "/capabilities", "/docs", "/studio", "/predict/../hardware"]:
        assert not native_path_allowed(path)


def test_container_worker_legacy_import_stays_available() -> None:
    if os.name == "nt":
        return
    from frameleaf_ml.config import CustomUvicornWorker

    assert CustomUvicornWorker.__name__ == "CustomUvicornWorker"


def test_native_transport_authenticates_health_and_blocks_container_routes() -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from frameleaf_ml.native_runtime import NativeScope

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
            [sys.executable, "-m", "frameleaf_ml.native_runtime", "--cache-dir", str(tmp_path), "--port", str(port)],
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

    from frameleaf_ml.native_runtime import library_entries

    for task in ["inpaint", "semantic-mask", "transcribe"]:
        with pytest.raises(HTTPException) as error:
            library_entries('{"' + task + '": {"visual": {"modelName": "unapproved"}}}')
        assert error.value.status_code == 422
    entries = library_entries('{"clip": {"textual": {"modelName": "ViT-B-32__openai"}}}')
    assert entries[0][0]["task"] == "clip"


def test_unqualified_native_app_cannot_predict() -> None:
    from fastapi.testclient import TestClient

    from frameleaf_ml.native_runtime import create_native_app

    with TestClient(create_native_app(None)) as client:
        response = client.post("/predict", data={"entries": "{}", "text": "fixture"})
        assert response.status_code == 503


def test_bound_native_app_refuses_changed_request_and_changed_runtime(monkeypatch) -> None:
    from fastapi.testclient import TestClient

    from frameleaf_ml import main
    from frameleaf_ml.native_runtime import create_native_app

    class Binding:
        calls = 0
        changed = False

        async def preload(self):
            pass

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


def test_binding_set_cli_is_explicit_and_checks_pair_counts_before_imports(tmp_path):
    for args, reason in [
        (
            ["--spec", "a", "--qualification-report", "b", "--spec", "c", "--qualification-report", "d"],
            "native_binding_set_flag_required",
        ),
        (["--binding-set", "--spec", "a"], "native_binding_pair_required"),
        (["--binding-set"], "native_binding_pair_required"),
    ]:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "frameleaf_ml.native_runtime",
                "--cache-dir",
                str(tmp_path),
                "--port",
                "19999",
                *args,
            ],
            cwd=Path(__file__).parent,
            capture_output=True,
            text=True,
            timeout=15,
            env={},
        )
        assert result.returncode == 2
        assert reason in result.stderr


async def native_request(chunks, *, headers=(), path="/predict"):
    from frameleaf_ml.native_runtime import NativeScope

    received, sent, parsed = [], [], []
    messages = iter(chunks)

    async def receive():
        value = next(messages)
        received.append(value)
        return value

    async def send(value):
        sent.append(value)

    async def parser(scope, read, write):
        while True:
            value = await read()
            parsed.append(value)
            if not value.get("more_body", False):
                break
        await write({"type": "http.response.start", "status": 200, "headers": []})
        await write({"type": "http.response.body", "body": b"ok"})

    await NativeScope(parser, "a" * 48)(
        {
            "type": "http",
            "path": path,
            "method": "POST",
            "headers": [
                (b"authorization", b"Bearer " + b"a" * 48),
                *headers,
            ],
        },
        receive,
        send,
    )
    return received, sent, parsed


def test_native_request_is_bounded_before_form_parsing():
    import asyncio

    # The authenticated body itself is bounded, even with a missing or misleading Content-Length.
    for headers in [(), ((b"content-length", b"1"),)]:
        received, sent, parsed = asyncio.run(
            native_request(
                [
                    {"type": "http.request", "body": b"x" * (17 * 1024 * 1024), "more_body": True},
                    {"type": "http.request", "body": b"x", "more_body": True},
                    {"type": "http.request", "body": b"unread", "more_body": False},
                ],
                headers=headers,
            )
        )
        assert sent[0]["status"] == 413
        assert not parsed
        assert len(received) == 2


def test_native_request_replays_exact_bounded_body_to_parser():
    import asyncio

    _, sent, parsed = asyncio.run(
        native_request(
            [
                {"type": "http.request", "body": b"first", "more_body": True},
                {"type": "http.request", "body": b"second", "more_body": False},
            ]
        )
    )
    assert sent[0]["status"] == 200
    assert b"".join(part["body"] for part in parsed) == b"firstsecond"


def test_native_disconnect_never_parses_an_incomplete_body():
    import asyncio

    _, sent, parsed = asyncio.run(
        native_request(
            [
                {"type": "http.request", "body": b"partial", "more_body": True},
                {"type": "http.disconnect"},
            ]
        )
    )
    assert not parsed
    assert not sent


def test_native_body_timeout_releases_buffer_without_parsing(monkeypatch):
    import asyncio

    from frameleaf_ml import native_runtime as module

    monkeypatch.setattr(module, "REQUEST_BODY_SECONDS", 0.01)

    async def exercise():
        parsed, sent, cancelled = [], [], []

        reads = 0

        async def stalled():
            nonlocal reads
            reads += 1
            if reads == 1:
                return {"type": "http.request", "body": b"partial", "more_body": True}
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.append(True)

        async def parser(*args):
            parsed.append(True)

        async def send(value):
            sent.append(value)

        await module.NativeScope(parser, "a" * 48)(
            {
                "type": "http",
                "path": "/predict",
                "method": "POST",
                "headers": [
                    (b"authorization", b"Bearer " + b"a" * 48),
                ],
            },
            stalled,
            send,
        )
        assert not parsed
        assert cancelled == [True]
        assert sent[0]["status"] == 408

    asyncio.run(exercise())


def test_bounded_native_transport_preserves_multipart_inputs():
    from fastapi import FastAPI, File, Form
    from fastapi.testclient import TestClient

    from frameleaf_ml.native_runtime import NativeScope

    app = FastAPI()

    @app.post("/predict")
    async def predict(entries: str = Form(), image: bytes = File()):
        return {"entries": entries, "bytes": len(image)}

    with TestClient(NativeScope(app, "a" * 48)) as client:
        response = client.post(
            "/predict",
            headers={"Authorization": "Bearer " + "a" * 48},
            data={"entries": "{}"},
            files={"image": ("fixture.png", b"synthetic")},
        )
        assert response.status_code == 200
        assert response.json() == {"entries": "{}", "bytes": len(b"synthetic")}
        entries = "{}".ljust(65536)
        response = client.post(
            "/predict",
            headers={"Authorization": "Bearer " + "a" * 48},
            data={"entries": entries},
            files={"image": ("fixture.png", b"x" * (16 * 1024 * 1024))},
        )
        assert response.status_code == 200
        assert response.json() == {"entries": entries, "bytes": 16 * 1024 * 1024}


def test_native_checks_decoded_image_envelope_before_prediction(monkeypatch):
    from io import BytesIO
    from unittest.mock import AsyncMock, Mock

    from fastapi.testclient import TestClient
    from PIL import Image

    from frameleaf_ml import main
    from frameleaf_ml.native_runtime import create_native_app

    class Binding:
        async def preload(self):
            pass

        def check(self, entries, kind):
            assert kind == "image"
            return ([], [])

    prediction = AsyncMock(return_value=main.ORJSONResponse({"accepted": True}))
    monkeypatch.setattr(main, "predict", prediction)
    cases = []
    for dimensions, status in [((8193, 1), 413), ((1, 8193), 413), ((4096, 4097), 413), ((8192, 2048), 200)]:
        output = BytesIO()
        with Image.new("RGB", dimensions) as image:
            image.save(output, format="PNG")
        cases.append((output.getvalue(), status))
    # A tiny encoded header can declare billions of pixels without allocating them in the fixture.
    import struct
    import zlib

    bomb = bytearray(cases[0][0])
    bomb[16:24] = struct.pack(">II", 90000, 90000)
    bomb[29:33] = struct.pack(">I", zlib.crc32(bomb[12:29]))
    cases.append((bytes(bomb), 413))
    cases.append((b"not an image", 422))
    Image.init()  # Plugin registration may create its own tiny prototype image.
    with TestClient(create_native_app(Binding())) as client:
        # Even an accepted header does not allocate pixels in the admission check.
        load = Mock(side_effect=AssertionError("pixels decoded before admission"))
        monkeypatch.setattr(Image.Image, "load", load)
        for payload, status in cases:
            prediction.reset_mock()
            response = client.post("/predict", data={"entries": "{}"}, files={"image": ("fixture", payload)})
            assert response.status_code == status
            assert prediction.await_count == (1 if status == 200 else 0)
        load.assert_not_called()


def test_native_webp_dimensions_precede_canvas_decoder(monkeypatch):
    import struct
    from unittest.mock import Mock

    import pytest
    from fastapi import HTTPException
    from PIL import WebPImagePlugin

    from frameleaf_ml.native_runtime import check_image_envelope

    def chunk(tag, payload):
        return tag + struct.pack("<I", len(payload)) + payload + b"\0" * (len(payload) % 2)

    def webp(payload):
        return b"RIFF" + struct.pack("<I", len(payload) + 4) + b"WEBP" + payload

    # VP8, VP8L, VP8X and animated frame dimensions can all reach native allocations.
    vp8 = b"\0\0\0\x9d\x01\x2a" + struct.pack("<HH", 8193, 1)
    vp8l = b"\x2f" + struct.pack("<I", 8192)
    vp8x = b"\0" * 4 + (8192).to_bytes(3, "little") + b"\0" * 3
    anmf = b"\0" * 6 + (8192).to_bytes(3, "little") + b"\0" * 7
    decoder = Mock(side_effect=AssertionError("native canvas allocated before admission"))
    monkeypatch.setattr(WebPImagePlugin._webp, "WebPAnimDecoder", decoder)
    for tag, payload in [(b"VP8 ", vp8), (b"VP8L", vp8l), (b"VP8X", vp8x), (b"ANMF", anmf)]:
        with pytest.raises(HTTPException) as error:
            check_image_envelope(webp(chunk(tag, payload)))
        assert error.value.status_code == 413
    decoder.assert_not_called()


def test_native_preview_codecs_and_animation_headers_remain_supported():
    from io import BytesIO

    from PIL import Image

    from frameleaf_ml.native_runtime import check_image_envelope

    for codec in ["JPEG", "PNG", "WEBP", "AVIF"]:
        encoded = BytesIO()
        with Image.new("RGB", (8, 8), "white") as image:
            image.save(encoded, format=codec)
        check_image_envelope(encoded.getvalue())
    for codec in ["PNG", "WEBP"]:
        encoded = BytesIO()
        with Image.new("RGB", (8, 8), "white") as image, Image.new("RGB", (8, 8), "black") as frame:
            image.save(encoded, format=codec, save_all=True, append_images=[frame], duration=100, loop=0)
        check_image_envelope(encoded.getvalue())


def test_native_container_headers_are_bounded_before_pillow_open(monkeypatch):
    import struct
    import zlib
    from io import BytesIO
    from unittest.mock import Mock

    import pytest
    from fastapi import HTTPException
    from PIL import Image

    from frameleaf_ml.native_runtime import check_image_envelope

    encoded = BytesIO()
    with Image.new("RGB", (8, 8)) as image:
        image.save(encoded, format="PNG")
    oversized = bytearray(encoded.getvalue())
    oversized[16:24] = struct.pack(">II", 8193, 1)
    oversized[29:33] = struct.pack(">I", zlib.crc32(oversized[12:29]))
    unopened = Mock(side_effect=AssertionError("canvas opener invoked before size admission"))
    monkeypatch.setattr(Image, "open", unopened)
    with pytest.raises(HTTPException) as error:
        check_image_envelope(bytes(oversized))
    assert error.value.status_code == 413
    unopened.assert_not_called()
