from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from frameleaf_ml import native_ort
from frameleaf_ml.sessions.ort import OrtSession


@pytest.fixture
def coreml(tmp_path, monkeypatch):
    import frameleaf_ml.sessions.ort as sessions
    from test_native_device import Observer

    observer = Observer()
    policy = native_ort.NativeOrtPolicy("CoreMLExecutionProvider", None, observer=observer)
    monkeypatch.setattr(native_ort, "_policy", policy)
    monkeypatch.setattr(sessions, "runtime_cache_dir", lambda path: tmp_path / "cache")
    made = []

    class Options:
        def __init__(self):
            self.execution_mode = SimpleNamespace(name="ORT_SEQUENTIAL")
            self.inter_op_num_threads = self.intra_op_num_threads = 0
            self.overrides = {}

        def add_free_dimension_override_by_name(self, name, size):
            self.overrides[name] = size

        def add_session_config_entry(self, key, value):
            pass

    class Session:
        def __init__(self, model, *, providers, provider_options, sess_options, disabled_optimizers=()):
            assert not observer.active
            self.providers, self.options = providers, sess_options
            self.provider_options = provider_options
            self.disabled = False
            self.inputs = [
                SimpleNamespace(
                    name="input", shape=[sess_options.overrides.get(d, d) for d in ["batch", 3, "height", "width"]]
                )
            ]
            made.append(self)

        def get_inputs(self):
            return self.inputs

        def get_providers(self):
            return self.providers

        def disable_fallback(self):
            self.disabled = True

        def end_profiling(self):
            return str(tmp_path / "initial.json")

        def run(self, names, feed, options):
            assert observer.active and self.disabled
            return [feed["input"]]

    monkeypatch.setattr(sessions.ort, "SessionOptions", Options)
    monkeypatch.setattr(sessions.ort, "InferenceSession", Session)
    return SimpleNamespace(
        policy=policy, made=made, observer=observer, model=tmp_path / "model.onnx", options=Options, factory=Session
    )


def test_native_coreml_specializes_actual_shapes_and_bounds_cache(coreml):
    session = OrtSession(coreml.model)
    first = np.zeros((1, 3, 2, 4), dtype=np.float32)
    assert session.run(None, {"input": first})[0] is first
    assert len(coreml.made) == 2
    assert coreml.made[-1].options.overrides == {"batch": 1, "height": 2, "width": 4}
    cache = Path(coreml.made[-1].provider_options[0]["ModelCacheDirectory"])
    assert cache.is_dir()
    session.run(None, {"input": first})
    assert len(coreml.made) == 2
    second = np.zeros((1, 3, 4, 6), dtype=np.float32)
    assert session.run(None, {"input": second})[0] is second
    assert len(coreml.made) == 3 and not cache.exists()
    assert len(coreml.observer.calls) == 3


def test_qualification_rejects_shape_change_without_discarding_used_profile(coreml, tmp_path):
    coreml.policy.profile_dir = tmp_path
    session = OrtSession(coreml.model)
    session.run(None, {"input": np.zeros((1, 3, 2, 4), dtype=np.float32)})
    active = session.session
    with pytest.raises(ValueError, match="native_profile_input_shape_changed"):
        session.run(None, {"input": np.zeros((1, 3, 4, 6), dtype=np.float32)})
    assert session.session is active and len(coreml.made) == 2


def test_conflicting_symbolic_dimensions_fail_before_rebuild(coreml):
    session = OrtSession(coreml.model)
    coreml.made[0].inputs[0].shape = ["batch", 3, "size", "size"]
    with pytest.raises(ValueError, match="native_input_shape_conflict"):
        session.run(None, {"input": np.zeros((1, 3, 2, 4), dtype=np.float32)})
    assert len(coreml.made) == 1 and not coreml.observer.calls


@pytest.mark.parametrize("custom", ["sess_options", "provider_options"])
def test_custom_session_configuration_is_preserved(coreml, custom):
    value = coreml.options() if custom == "sess_options" else [{"ModelFormat": "MLProgram"}, {}]
    session = OrtSession(coreml.model, **{custom: value})
    session.run(None, {"input": np.zeros((1, 3, 2, 4), dtype=np.float32)})
    assert len(coreml.made) == 1


@pytest.mark.parametrize("failure", ["compile", "provider"])
def test_failed_specialization_retains_session_and_removes_temporary_cache(coreml, monkeypatch, failure):
    session = OrtSession(coreml.model)
    original = session.session

    def fail(*args, **kwargs):
        if failure == "compile":
            raise RuntimeError("compile_failed")
        replacement = coreml.factory(*args, **kwargs)
        replacement.get_providers = lambda: ["CPUExecutionProvider"]
        return replacement

    monkeypatch.setattr("onnxruntime.InferenceSession", fail)
    with pytest.raises(RuntimeError, match="compile_failed|native_provider_not_loaded"):
        session.run(None, {"input": np.zeros((1, 3, 2, 4), dtype=np.float32)})
    assert session.session is original and not coreml.observer.calls
    assert not list((coreml.model.parent / "cache/coreml").iterdir())
