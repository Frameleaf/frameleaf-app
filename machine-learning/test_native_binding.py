import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from frameleaf_ml import native_binding as module


@pytest.mark.asyncio
async def test_native_preload_rechecks_binding_around_loading(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock

    from frameleaf_ml import main

    entry = {"name": "fixture", "type": "textual", "task": "clip", "options": {"language": "en"}}
    spec = SimpleNamespace(entries={"clip": {}}, fixture_kind="text")
    binding = module.NativeBinding(spec, tmp_path, "d" * 64)
    events = []
    binding.check = Mock(side_effect=lambda *args: (events.append("check") or [entry], []))
    model = object()

    async def get(*args, **kwargs):
        assert args == ("fixture", "textual", "clip")
        assert kwargs == {"ttl": main.settings.model_ttl, "language": "en"}
        events.append("get")
        return model

    async def load(value):
        assert value is model
        events.append("load")

    monkeypatch.setattr(main.model_cache, "get", get)
    monkeypatch.setattr(main, "load", load)
    await binding.preload()
    assert events == ["check", "get", "load", "check"]


def test_one_native_binding_set_selects_exact_roles_and_rechecks_live_authority(tmp_path, monkeypatch):
    def binding(key, kind, options):
        model_type = "textual" if kind == "text" else "visual"
        spec = module.QualificationSpec.model_validate(
            {
                "protocolVersion": 1,
                "modelKey": key,
                "provider": "CPUExecutionProvider",
                "models": [
                    {"name": "fixture", "task": "clip", "type": model_type, "artifacts": {"model.onnx": "a" * 64}}
                ],
                "entries": {"clip": {model_type: {"modelName": "fixture", "options": options}}},
                "preprocessingSha256": "b" * 64,
                "fixtureFile": "fixture.txt" if kind == "text" else "fixture.png",
                "fixtureKind": kind,
                "fixtureSha256": "c" * 64,
                "expectedOutput": {"clip": "[1,2]"},
                "minMemoryBytes": 10,
            }
        )
        return module.NativeBinding(spec, tmp_path, "d" * 64)

    default = binding("default", "text", {})
    english = binding("english", "text", {"language": "en"})
    visual = binding("visual", "image", {})
    facts = {"fingerprint": "d" * 64, "availableMemoryBytes": 20}
    monkeypatch.setattr(module, "snapshot", lambda: facts)
    monkeypatch.setattr(module, "preprocessing_identity", lambda: "b" * 64)
    monkeypatch.setattr(module, "verify_models", lambda spec, cache: (([spec.model_key], []), []))
    group = module.NativeBindingSet([default, english, visual])
    assert group.check(default.spec.entries, "text") == (["default"], [])
    assert group.check(english.spec.entries, "text") == (["english"], [])
    assert group.check(visual.spec.entries, "image") == (["visual"], [])
    numeric = binding("numeric", "text", {"length": 1})
    with pytest.raises(ValueError, match="request_binding"):
        module.NativeBindingSet([numeric]).check(
            {"clip": {"textual": {"modelName": "fixture", "options": {"length": True}}}}, "text"
        )
    with pytest.raises(ValueError, match="request_binding"):
        group.check(default.spec.entries, "image")
    with pytest.raises(ValueError, match="request_binding"):
        group.check({"clip": {"textual": {"modelName": "other"}}}, "text")
    facts["fingerprint"] = "e" * 64
    with pytest.raises(ValueError, match="driver_changed"):
        group.check(visual.spec.entries, "image")
    with pytest.raises(ValueError, match="binding_set"):
        module.NativeBindingSet([default, default])
    with pytest.raises(ValueError, match="binding_set"):
        module.NativeBindingSet([])
    duplicate = binding("another-key", "text", {})
    with pytest.raises(ValueError, match="binding_set"):
        module.NativeBindingSet([default, duplicate])
    incompatible = binding("other-runtime", "image", {})
    incompatible.fingerprint = "e" * 64
    with pytest.raises(ValueError, match="binding_set"):
        module.NativeBindingSet([default, incompatible])
    with pytest.raises(ValueError, match="binding_set"):
        module.NativeBindingSet([binding(f"key-{index}", "text", {"language": str(index)}) for index in range(65)])
    with pytest.raises(ValueError, match="binding_set"):
        module.NativeBindingSet.load([], [], tmp_path, "CPUExecutionProvider")
    with pytest.raises(ValueError, match="binding_set"):
        module.NativeBindingSet.load([tmp_path / "absent"], [], tmp_path, "CPUExecutionProvider")

    facts["fingerprint"] = "d" * 64
    specs, reports = [], []
    for index, item in enumerate([default, english, visual]):
        raw = item.spec.model_dump_json(by_alias=True).encode()
        path = tmp_path / f"spec-{index}.json"
        path.write_bytes(raw)
        specs.append(path)
        report = tmp_path / f"report-{index}.json"
        report.write_text(
            json.dumps(
                {
                    "modelKey": item.spec.model_key,
                    "provider": "CPUExecutionProvider",
                    "state": "ready-cpu",
                    "reason": None,
                    "runtimeFingerprint": "d" * 64,
                    "bindingSha256": hashlib.sha256(raw).hexdigest(),
                }
            )
        )
        reports.append(report)
    loaded = module.NativeBindingSet.load(specs, reports, tmp_path, "CPUExecutionProvider")
    with pytest.raises(ValueError, match="report_invalid"):
        module.NativeBindingSet.load(specs, reports[::-1], tmp_path, "CPUExecutionProvider")

    from fastapi.testclient import TestClient

    from frameleaf_ml import main
    from frameleaf_ml.native_runtime import create_native_app

    async def predict(**kwargs):
        return main.ORJSONResponse({"role": kwargs["entries"][0][0]})

    monkeypatch.setattr(main, "predict", predict)
    from unittest.mock import AsyncMock

    preload = AsyncMock()
    monkeypatch.setattr(module.NativeBinding, "preload", preload)
    with TestClient(create_native_app(loaded)) as client:
        assert preload.await_count == 3
        for item in [default, english, visual, default]:
            data = {"entries": json.dumps(item.spec.entries)}
            if item is visual:
                response = client.post("/predict", data=data, files={"image": ("fixture", b"image")})
            else:
                response = client.post("/predict", data={**data, "text": "fixture"})
            assert response.status_code == 200
            assert response.json() == {"role": item.spec.model_key}

        async def changed(**kwargs):
            facts["fingerprint"] = "e" * 64
            return main.ORJSONResponse({"role": "must-not-publish"})

        monkeypatch.setattr(main, "predict", changed)
        response = client.post("/predict", data={"entries": json.dumps(default.spec.entries), "text": "fixture"})
        assert response.status_code == 409
        assert "must-not-publish" not in response.text


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
