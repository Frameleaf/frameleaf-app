import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from immich_ml import native_binding as module


def test_binding_rechecks_artifacts_driver_preprocessing_and_capacity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    spec = {
        "protocolVersion": 1,
        "modelKey": "fixture",
        "provider": "CPUExecutionProvider",
        "models": [{"name": "fixture", "task": "clip", "type": "textual", "artifacts": {"model.onnx": "a" * 64}}],
        "entries": {"clip": {"textual": {"modelName": "fixture"}}},
        "preprocessingSha256": "b" * 64,
        "fixtureFile": "fixture.txt",
        "fixtureKind": "text",
        "fixtureSha256": "c" * 64,
        "expectedOutput": {"clip": "[1,2]"},
        "minMemoryBytes": 10,
    }
    raw = json.dumps(spec).encode()
    spec_path = tmp_path / "spec.json"
    spec_path.write_bytes(raw)
    report = {
        "modelKey": "fixture",
        "provider": "CPUExecutionProvider",
        "state": "ready-cpu",
        "reason": None,
        "runtimeFingerprint": "d" * 64,
        "bindingSha256": hashlib.sha256(raw).hexdigest(),
    }
    report_path = tmp_path / "report.json"
    report_path.write_text(json.dumps(report))
    facts: dict[str, Any] = {"fingerprint": "d" * 64, "availableMemoryBytes": 20}
    monkeypatch.setattr(module, "snapshot", lambda: facts)
    monkeypatch.setattr(module, "preprocessing_identity", lambda: "b" * 64)
    calls = []

    def verify(spec, cache):
        calls.append(cache)
        return ([], []), []

    monkeypatch.setattr(module, "verify_models", verify)
    binding = module.NativeBinding.load(spec_path, report_path, tmp_path, "CPUExecutionProvider")
    binding.check(spec["entries"], "text")
    assert len(calls) == 2
    with pytest.raises(ValueError, match="request_binding"):
        binding.check({}, "text")
    with pytest.raises(ValueError, match="request_binding"):
        binding.check(spec["entries"], "image")
    facts["fingerprint"] = "e" * 64
    with pytest.raises(ValueError, match="driver_changed"):
        binding.check(spec["entries"], "text")
    facts["fingerprint"] = "d" * 64
    facts["availableMemoryBytes"] = 1
    with pytest.raises(ValueError, match="memory_insufficient"):
        binding.check(spec["entries"], "text")
    facts["availableMemoryBytes"] = 20
    monkeypatch.setattr(module, "preprocessing_identity", lambda: "f" * 64)
    with pytest.raises(ValueError, match="preprocessing_changed"):
        binding.check(spec["entries"], "text")
    report["bindingSha256"] = "a" * 64
    report_path.write_text(json.dumps(report))
    with pytest.raises(ValueError, match="report_invalid"):
        module.NativeBinding.load(spec_path, report_path, tmp_path, "CPUExecutionProvider")
