import hashlib
import json
import os
import sys

import pytest

from frameleaf_ml import native_qwen
from frameleaf_ml.native_binding import NativeBinding
from frameleaf_ml.native_hardware import snapshot
from frameleaf_ml.native_qualification import preprocessing_identity
from frameleaf_ml.staging import RECEIPT, cache_hashes


@pytest.fixture
def qwen_binding(tmp_path):
    cache = tmp_path / "cache"
    directory = native_qwen.model_directory(cache)
    (directory / "visual").mkdir(parents=True)
    for name in native_qwen.ARTIFACTS:
        (directory / name).write_bytes(b"GGUF" + name.encode())
    hashes = cache_hashes(directory)
    (directory / RECEIPT).write_text(json.dumps(hashes))
    entries = {native_qwen.TASK: {"visual": {"modelName": native_qwen.MODEL, "options": {}}}}
    spec = {
        "engine": "qwen-gguf",
        "protocolVersion": 1,
        "modelKey": "qwen-candidate",
        "models": [{"name": native_qwen.MODEL, "task": native_qwen.TASK, "type": "visual", "artifacts": hashes}],
        "entries": entries,
        "preprocessingSha256": preprocessing_identity("qwen-gguf"),
        "provider": "CPUExecutionProvider",
        "fixtureFile": "test.png",
        "fixtureKind": "image",
        "fixtureSha256": "a" * 64,
        "expectedOutput": {},
        "minMemoryBytes": 1,
    }
    raw = json.dumps(spec).encode()
    specification = tmp_path / "spec.json"
    specification.write_bytes(raw)
    report = {
        "engine": spec["engine"],
        "protocolVersion": 1,
        "modelKey": spec["modelKey"],
        "bindingSha256": hashlib.sha256(raw).hexdigest(),
        "state": "ready-cpu",
        "provider": spec["provider"],
        "fixtureSha256": spec["fixtureSha256"],
        "preprocessingSha256": spec["preprocessingSha256"],
        "runtimeFingerprint": snapshot()["fingerprint"],
    }
    result = tmp_path / "report.json"
    result.write_text(json.dumps(report))
    return cache, specification, result, entries


@pytest.mark.parametrize("artifact", native_qwen.ARTIFACTS)
def test_qwen_refuses_changed_artifacts_even_if_staging_receipt_is_rewritten(qwen_binding, artifact):
    cache, spec, report, entries = qwen_binding
    binding = NativeBinding.load(spec, report, cache, "CPUExecutionProvider")
    directory = native_qwen.model_directory(cache)
    (directory / artifact).write_bytes(b"GGUFchanged")
    (directory / RECEIPT).write_text(json.dumps(cache_hashes(directory)))
    with pytest.raises(ValueError, match="native_qwen_artifact_changed"):
        binding.check(entries, "image")


def test_qwen_refuses_legacy_report(qwen_binding):
    cache, spec, report, _ = qwen_binding
    unbound = json.loads(report.read_bytes())
    del unbound["engine"]
    report.write_text(json.dumps(unbound))
    with pytest.raises(ValueError, match="native_binding_report_invalid"):
        NativeBinding.load(spec, report, cache, "CPUExecutionProvider")


@pytest.mark.skipif(os.name != "posix", reason="Qwen candidate uses a private Unix socket")
def test_authenticated_native_qwen_prediction(qwen_binding, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from frameleaf_ml.native_runtime import NativeScope, create_native_app

    cache, spec, report, entries = qwen_binding
    binary = tmp_path / "llama-server"
    binary.write_text(
        f"#!{sys.executable}\n"
        + """import json, os, socketserver, sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
args = sys.argv
Path(args[0]).with_suffix(".pid").write_text(str(os.getpid()))
token = Path(args[args.index("--api-key-file") + 1]).read_text().strip()
assert "--offline" in args and "--no-mmproj-offload" in args
assert Path(args[args.index("-m") + 1]).name == "model.gguf"
assert Path(args[args.index("--mmproj") + 1]).name == "mmproj.gguf"
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass
    def reply(self, body):
        assert self.headers["Authorization"] == "Bearer " + token
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())
    def do_GET(self):
        assert self.path == "/props"
        self.reply({"build_info": "b1-7fe450e19"})
    def do_POST(self):
        assert self.path == "/v1/chat/completions"
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert body["messages"][0]["content"][0]["image_url"]["url"].startswith("data:image/png;base64,")
        assert body["chat_template_kwargs"] == {"enable_thinking": False}
        self.reply({"choices": [{"finish_reason": "stop", "message": {"content": '{"description":"A red square."}'}}]})
with socketserver.UnixStreamServer(args[args.index("--host") + 1], Handler) as server:
    server.serve_forever()
"""
    )
    binary.chmod(0o700)
    monkeypatch.setattr(native_qwen, "BINARY", binary)
    token = "x" * 64
    binding = NativeBinding.load(spec, report, cache, "CPUExecutionProvider")
    with TestClient(NativeScope(create_native_app(binding), token)) as client:
        body = {"entries": json.dumps(entries)}
        image = {"image": ("fixture.png", b"\x89PNG\r\n\x1a\nfixture", "image/png")}
        assert client.post("/predict", data=body, files=image).status_code == 401
        headers = {"Authorization": f"Bearer {token}"}
        assert client.post("/predict", data={"entries": "{}"}, files=image, headers=headers).status_code == 409
        response = client.post("/predict", data=body, files=image, headers=headers)
        assert response.status_code == 200
        assert response.json()[native_qwen.TASK]["description"] == "A red square."
        with pytest.raises(ProcessLookupError):
            os.kill(int(binary.with_suffix(".pid").read_text()), 0)
