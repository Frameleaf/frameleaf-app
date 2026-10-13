from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from frameleaf_ml.config import settings
from frameleaf_ml.sessions import runtime_cache_dir
from frameleaf_ml.sessions.ann import AnnSession
from frameleaf_ml.sessions.ort import OrtSession


@pytest.fixture
def staged_model(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    model = tmp_path / "read-only-models" / "model.onnx"
    model.parent.mkdir()
    model.write_bytes(b"synthetic model")
    monkeypatch.setattr(settings, "model_downloads", False)
    monkeypatch.setattr("frameleaf_ml.sessions.gettempdir", lambda: str(tmp_path / "runtime"))
    return model


def test_compiled_cache_is_separate_and_changes_with_weights(staged_model: Path) -> None:
    first = runtime_cache_dir(staged_model)
    assert not first.is_relative_to(staged_model.parent)
    assert first.is_dir()
    assert runtime_cache_dir(staged_model) == first
    staged_model.write_bytes(b"new synthetic weights")
    assert runtime_cache_dir(staged_model) != first


def test_external_weights_and_distinct_models_invalidate_compiled_cache(staged_model: Path) -> None:
    receipt = staged_model.parent / ".frameleaf-staged.json"
    receipt.write_text('{"model.onnx.data": "old weight hash"}')
    first = runtime_cache_dir(staged_model)
    receipt.write_text('{"model.onnx.data": "new weight hash"}')
    assert runtime_cache_dir(staged_model) != first
    other = staged_model.with_name("other.onnx")
    other.write_bytes(staged_model.read_bytes())
    assert runtime_cache_dir(other) != runtime_cache_dir(staged_model)


@pytest.mark.parametrize(
    ("provider", "key"),
    [
        ("MIGraphXExecutionProvider", "migraphx_model_cache_dir"),
        ("CoreMLExecutionProvider", "ModelCacheDirectory"),
        ("OpenVINOExecutionProvider", "cache_dir"),
    ],
)
def test_accelerator_cache_does_not_write_to_staged_weights(
    staged_model: Path, provider: str, key: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "onnxruntime.capi._pybind_state.get_available_openvino_device_ids", lambda: ["CPU"], raising=False
    )
    session = OrtSession.__new__(OrtSession)
    session.model_path = staged_model
    session.providers = [provider]
    session.device_id = "CPU"
    cache = Path(session._provider_options_default[0][key])
    assert not cache.is_relative_to(staged_model.parent)
    assert list(staged_model.parent.iterdir()) == [staged_model]


def test_armnn_tuning_and_compiled_cache_are_writable_outside_staged_models(staged_model: Path) -> None:
    with patch("frameleaf_ml.sessions.ann.Ann", return_value=Mock()) as ann:
        ann.return_value.load.return_value = 1
        session = AnnSession(staged_model)
        assert not Path(ann.call_args.kwargs["tuning_file"]).is_relative_to(staged_model.parent)
        assert not Path(ann.return_value.load.call_args.kwargs["cached_network_path"]).is_relative_to(
            staged_model.parent
        )
        del session
