import hashlib
from contextlib import contextmanager

import numpy as np
import onnx
import pytest

from test_native_qualification import graph


class Observer:
    provider = "CoreMLExecutionProvider"

    def __init__(self):
        self.active = False
        self.calls = []
        self.loaded = []
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
    def observe(self, path, loaded_sha256=None):
        assert not self.active
        self.active = True
        try:
            yield
            self.calls.append(path)
            self.loaded.append(loaded_sha256)
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
    def refuse(path, loaded_sha256=None):
        yield
        raise ValueError("device_proof_missing")

    monkeypatch.setattr(observer, "observe", refuse)
    with pytest.raises(ValueError, match="device_proof_missing"):
        session.run(None, {"input": np.ones((1, 2), dtype=np.float32)})


def observed_session(tmp_path, monkeypatch, **options):
    from frameleaf_ml import native_ort
    from frameleaf_ml.sessions.ort import OrtSession

    observer = Observer()
    monkeypatch.setattr(
        native_ort, "_policy", native_ort.NativeOrtPolicy("CPUExecutionProvider", None, observer=observer)
    )
    return observer, OrtSession(tmp_path / "model.onnx", **options)


def test_observed_session_runs_the_bytes_it_hashed_whatever_the_file_becomes(tmp_path, monkeypatch):
    path = tmp_path / "model.onnx"
    graph(path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    observer, session = observed_session(tmp_path, monkeypatch)
    assert session.model_sha256 == digest
    assert session.session._model_path is None and session.session._model_bytes is None
    # The file is replaced after the session exists: the session still runs, and still names, what it loaded.
    graph(path, batch=True)
    assert hashlib.sha256(path.read_bytes()).hexdigest() != digest
    assert session.run(None, {"input": np.ones((1, 2), dtype=np.float32)})[0].shape == (1, 4)
    assert observer.calls == [path] and observer.loaded == [digest]


def test_unobserved_native_session_still_loads_from_its_file(tmp_path, monkeypatch):
    from frameleaf_ml import native_ort
    from frameleaf_ml.sessions.ort import OrtSession

    path = tmp_path / "model.onnx"
    graph(path)
    monkeypatch.setattr(native_ort, "_policy", native_ort.NativeOrtPolicy("CPUExecutionProvider", None))
    session = OrtSession(path)
    assert session.model_sha256 is None and session.session._model_path == path.as_posix()


def test_model_with_external_weights_is_never_loaded_from_memory(tmp_path, monkeypatch):
    path = tmp_path / "model.onnx"
    graph(path)
    onnx.save(onnx.load(path), path, save_as_external_data=True, location="weights.bin", size_threshold=0)
    assert (tmp_path / "weights.bin").is_file()
    # ONNX Runtime would read an in-memory model's external weights from the working directory.
    monkeypatch.chdir(tmp_path)
    observer, session = observed_session(tmp_path, monkeypatch)
    assert session.model_sha256 is None and session.session._model_path == path.as_posix()
    session.run(None, {"input": np.ones((1, 2), dtype=np.float32)})
    assert observer.loaded == [None]


def test_a_derived_model_stands_for_its_source_only_when_the_bytes_show_it(tmp_path, monkeypatch):
    from onnx.tools.update_model_dims import update_inputs_outputs_dims

    from frameleaf_ml import native_ort
    from frameleaf_ml.sessions.ort import OrtSession

    source = tmp_path / "approved/model.onnx"
    graph(source)
    approved = hashlib.sha256(source.read_bytes()).hexdigest()
    observer = Observer()
    monkeypatch.setattr(
        native_ort, "_policy", native_ort.NativeOrtPolicy("CPUExecutionProvider", None, observer=observer)
    )

    def derive(change=None):
        proto = update_inputs_outputs_dims(onnx.load(source), {"input": ["batch", 2]}, {"output": ["batch", 4]})
        if change:
            change(proto)
        path = tmp_path / "runtime/model.onnx"
        path.parent.mkdir(exist_ok=True)
        onnx.save(proto, path)
        return path

    # A batch axis is the only difference: the session names the approved bytes.
    session = OrtSession(derive())
    loaded = session.model_sha256
    assert loaded == hashlib.sha256(session.model_path.read_bytes()).hexdigest() != approved
    session.source_model_path = source
    assert session.model_sha256 == approved and session.source_model_path == source
    assert session.run(None, {"input": np.ones((3, 2), dtype=np.float32)})[0].shape == (3, 4)
    assert observer.calls == [source] and observer.loaded == [approved]

    def weights(proto):
        proto.graph.initializer[0].raw_data = bytes(len(proto.graph.initializer[0].raw_data))

    def node(proto):
        proto.graph.node[0].op_type = "Identity"

    def rename(proto):
        proto.graph.output[0].name = "other"
        proto.graph.node[-1].output[0] = "other"

    def element_type(proto):
        proto.graph.input[0].type.tensor_type.elem_type = onnx.TensorProto.DOUBLE

    # Anything else changed: not proven, so the approved file is hashed around every run instead.
    for change in (weights, node, rename, element_type):
        try:
            session = OrtSession(derive(change))
        except Exception:
            continue  # not a loadable model at all
        assert session.model_sha256 is not None
        session.source_model_path = source
        assert session.model_sha256 is None, change.__name__

    # The derived file replaced after the session loaded it proves nothing about the session.
    session = OrtSession(derive())
    derive(weights)
    session.source_model_path = source
    assert session.model_sha256 is None
    # Nor does a source that cannot be read.
    session = OrtSession(derive())
    session.source_model_path = tmp_path / "missing.onnx"
    assert session.model_sha256 is None
    # Naming itself as the source changes nothing.
    session = OrtSession(source)
    session.source_model_path = source
    assert session.model_sha256 == approved


def test_custom_session_options_keep_the_file_and_its_per_run_hash(tmp_path, monkeypatch):
    import onnxruntime as ort

    graph(tmp_path / "model.onnx")
    _, session = observed_session(tmp_path, monkeypatch, sess_options=ort.SessionOptions())
    assert session.model_sha256 is None


def test_unreadable_or_empty_model_is_not_loaded_from_memory(tmp_path):
    from frameleaf_ml.sessions.ort import _read_model

    assert _read_model(tmp_path / "missing.onnx") is None
    (tmp_path / "empty.onnx").write_bytes(b"")
    assert _read_model(tmp_path / "empty.onnx") is None
    (tmp_path / "model.onnx").write_bytes(b"abc")
    assert _read_model(tmp_path / "model.onnx") == (b"abc", hashlib.sha256(b"abc").hexdigest())


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
