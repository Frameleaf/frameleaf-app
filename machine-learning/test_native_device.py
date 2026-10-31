from contextlib import contextmanager

import numpy as np
import pytest

from test_native_qualification import graph


class Observer:
    provider = "CoreMLExecutionProvider"

    def __init__(self):
        self.active = False
        self.calls = []
        self.version = "OS build one"
        self.bindings = {}

    def bind(self, models):
        self.bindings.update(models)

    def facts(self):
        return {
            "abiVersion": 1,
            "collectorSha256": "a" * 64,
            "osBuild": self.version,
            "devices": [{"name": "GPU", "identitySha256": "b" * 64}],
        }

    @contextmanager
    def observe(self, path):
        assert not self.active
        self.active = True
        try:
            yield
            self.calls.append(path)
        finally:
            self.active = False


def test_native_observer_cannot_attach_to_a_different_provider(tmp_path, monkeypatch):
    from frameleaf_ml import native_ort

    monkeypatch.setattr(native_ort, "_policy", None)
    with pytest.raises(ValueError, match="observer"):
        native_ort.configure("CPUExecutionProvider", tmp_path, observer=Observer())


def test_actual_session_output_is_observed_and_observer_refusal_blocks_publication(tmp_path, monkeypatch):
    from frameleaf_ml import native_ort
    from frameleaf_ml.sessions.ort import OrtSession

    observer = Observer()
    policy = native_ort.NativeOrtPolicy("CPUExecutionProvider", None, observer=observer)
    monkeypatch.setattr(native_ort, "_policy", policy)
    path = tmp_path / "model.onnx"
    graph(path)
    session = OrtSession(path)
    assert session.run(None, {"input": np.ones((1, 2), dtype=np.float32)})[0].shape == (1, 4)
    assert observer.calls == [path]
    assert not observer.active

    @contextmanager
    def refuse(path):
        yield
        raise ValueError("device_proof_missing")

    monkeypatch.setattr(observer, "observe", refuse)
    with pytest.raises(ValueError, match="device_proof_missing"):
        session.run(None, {"input": np.ones((1, 2), dtype=np.float32)})


def test_observer_device_facts_participate_in_runtime_fingerprint(monkeypatch):
    from frameleaf_ml import native_hardware, native_ort

    monkeypatch.setattr(native_ort, "_policy", None)
    cpu = native_hardware.snapshot()
    assert "deviceEvidence" not in cpu["facts"]
    observer = Observer()
    policy = native_ort.NativeOrtPolicy("CoreMLExecutionProvider", None, observer=observer)
    monkeypatch.setattr(native_ort, "_policy", policy)
    first = native_hardware.snapshot()
    assert first["facts"]["deviceEvidence"] == observer.facts()
    observer.version = "OS build two"
    assert native_hardware.snapshot()["fingerprint"] != first["fingerprint"]


def test_device_proof_requires_all_approved_models_and_matching_hardware():
    from frameleaf_ml.native_device import validate_evidence

    facts = Observer().facts()
    proof = {
        "provider": "CoreMLExecutionProvider",
        "facts": facts,
        "models": [
            {"sha256": "c" * 64, "calls": 2, "computeBuffers": 12, "computeDispatches": 518, "gpuNanoseconds": 100.0}
        ],
    }
    validate_evidence(proof, {"c" * 64}, facts)
    with pytest.raises(ValueError):
        validate_evidence(proof, {"d" * 64}, facts)
    with pytest.raises(ValueError):
        validate_evidence(proof, {"c" * 64}, {**facts, "osBuild": "changed"})
    for key, value in [("calls", True), ("calls", 1), ("computeBuffers", 0), ("gpuNanoseconds", float("nan"))]:
        bad = {**proof, "models": [{**proof["models"][0], key: value}]}
        with pytest.raises(ValueError):
            validate_evidence(bad, {"c" * 64}, facts)


def test_confirmed_coreml_is_mixed_and_still_requires_both_device_and_ort_proof():
    from frameleaf_ml.native_device import confirm_coreml_execution

    facts = Observer().facts()
    proof = {
        "provider": "CoreMLExecutionProvider",
        "facts": facts,
        "models": [
            {"sha256": "c" * 64, "calls": 2, "computeBuffers": 12, "computeDispatches": 518, "gpuNanoseconds": 100.0}
        ],
    }
    item = {
        "state": "incompatible",
        "reason": "coreml_device_execution_unproven",
        "nodes": {"CoreMLExecutionProvider": 2},
        "microseconds": {"CoreMLExecutionProvider": 10.0},
    }
    result = confirm_coreml_execution(proof, {"c" * 64}, facts, [item])
    assert result[0]["state"] == "ready-mixed" and result[0]["reason"] is None
    assert item["state"] == "incompatible"
    with pytest.raises(ValueError):
        confirm_coreml_execution(proof, {"d" * 64}, facts, [item])
    for nodes in [
        {"CPUExecutionProvider": 2},
        {"CoreMLExecutionProvider": True},
        {"CoreMLExecutionProvider": 2, "CUDAExecutionProvider": 1},
    ]:
        with pytest.raises(ValueError):
            confirm_coreml_execution(proof, {"c" * 64}, facts, [{**item, "nodes": nodes}])


def test_binding_check_binds_only_verified_model_bytes(tmp_path, monkeypatch, synthetic_clip_cache):
    from frameleaf_ml import native_ort
    from frameleaf_ml.config import settings
    from frameleaf_ml.native_binding import NativeBinding
    from frameleaf_ml.native_hardware import snapshot
    from frameleaf_ml.native_qualification import QualificationSpec, preprocessing_identity

    name, cache, hashes = synthetic_clip_cache
    observer = Observer()
    monkeypatch.setattr(
        native_ort, "_policy", native_ort.NativeOrtPolicy("CoreMLExecutionProvider", None, observer=observer)
    )
    monkeypatch.setattr(settings, "cache_folder", tmp_path / "cache")
    spec = QualificationSpec.model_validate(
        {
            "protocolVersion": 1,
            "modelKey": "binding",
            "provider": "CoreMLExecutionProvider",
            "models": [{"name": name, "task": "clip", "type": "textual", "artifacts": hashes}],
            "entries": {"clip": {"textual": {"modelName": name}}},
            "preprocessingSha256": preprocessing_identity(),
            "fixtureFile": "fixture.txt",
            "fixtureKind": "text",
            "fixtureSha256": "c" * 64,
            "expectedOutput": {},
            "minMemoryBytes": 1,
        }
    )
    binding = NativeBinding(spec, tmp_path / "cache", snapshot()["fingerprint"])
    binding.check(spec.entries, "text")
    path = cache / "textual/model.onnx"
    assert observer.bindings == {path.resolve(): hashes["textual/model.onnx"]}
    observer.bindings.clear()
    path.write_bytes(b"tampered after qualification")
    with pytest.raises(ValueError):
        binding.check(spec.entries, "text")
    assert not observer.bindings
