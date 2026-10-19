from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, PropertyMock, patch

import numpy as np
import onnx
import onnxruntime as ort
import pytest
from onnx import helper, numpy_helper

from frameleaf_ml.config import settings
from frameleaf_ml.models.facial_recognition.recognition import FaceRecognizer
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


@pytest.mark.parametrize("native", [False, True])
def test_native_coreml_keeps_float32_accumulation_and_bounded_specialization(
    staged_model: Path, monkeypatch: pytest.MonkeyPatch, native: bool
) -> None:
    monkeypatch.setattr("frameleaf_ml.sessions.ort.current_policy", lambda: object() if native else None)
    session = OrtSession.__new__(OrtSession)
    session.model_path = staged_model
    session.providers = ["CoreMLExecutionProvider", "CPUExecutionProvider"]
    options, cpu = session._provider_options_default
    assert options["ModelFormat"] == "MLProgram"
    assert options["MLComputeUnits"] == ("CPUAndGPU" if native else "ALL")
    assert options["SpecializationStrategy"] == ("Default" if native else "FastPrediction")
    assert options["AllowLowPrecisionAccumulationOnGPU"] == ("0" if native else "1")
    assert not Path(options["ModelCacheDirectory"]).is_relative_to(staged_model.parent)
    assert cpu == {"arena_extend_strategy": "kSameAsRequested"}


def test_armnn_tuning_and_compiled_cache_are_writable_outside_staged_models(staged_model: Path) -> None:
    with patch("frameleaf_ml.sessions.ann.Ann", return_value=Mock()) as ann:
        ann.return_value.load.return_value = 1
        session = AnnSession(staged_model)
        assert not Path(ann.call_args.kwargs["tuning_file"]).is_relative_to(staged_model.parent)
        assert not Path(ann.return_value.load.call_args.kwargs["cached_network_path"]).is_relative_to(
            staged_model.parent
        )
        del session


@pytest.mark.parametrize("external_weights", [False, True])
def test_face_batch_conversion_keeps_staged_model_and_weights_unchanged(
    staged_model: Path, external_weights: bool
) -> None:
    weights = np.array([1, 2, 3], dtype=np.float32)
    graph = helper.make_graph(
        [helper.make_node("Add", ["input", "bias"], ["output"])],
        "synthetic-face-model",
        [helper.make_tensor_value_info("input", onnx.TensorProto.FLOAT, [1, 3])],
        [helper.make_tensor_value_info("output", onnx.TensorProto.FLOAT, [1, 3])],
        [numpy_helper.from_array(weights, "bias")],
    )
    proto = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], ir_version=10)
    onnx.save_model(
        proto, staged_model, save_as_external_data=external_weights, location="model.weights", size_threshold=0
    )
    before = {path: path.read_bytes() for path in staged_model.parent.iterdir()}
    recognizer = FaceRecognizer("buffalo_l")
    recognizer.batch_size = 2
    session = Mock()
    session.get_inputs.return_value = [SimpleNamespace(shape=(1, 3))]
    with (
        patch.object(FaceRecognizer, "model_path", new_callable=PropertyMock, return_value=staged_model),
        patch.object(recognizer, "_make_session", return_value=session) as make_session,
    ):
        recognizer._load()

    converted_path = make_session.call_args.args[0]
    assert not converted_path.is_relative_to(staged_model.parent)
    assert {path: path.read_bytes() for path in staged_model.parent.iterdir()} == before
    converted = onnx.load(converted_path)
    assert converted.graph.input[0].type.tensor_type.shape.dim[0].dim_param == "batch"
    np.testing.assert_array_equal(numpy_helper.to_array(converted.graph.initializer[0]), weights)
    runtime = ort.InferenceSession(str(converted_path), providers=["CPUExecutionProvider"])
    inputs = np.array([[10, 20, 30], [40, 50, 60]], dtype=np.float32)
    np.testing.assert_array_equal(runtime.run(None, {"input": inputs})[0], inputs + weights)
