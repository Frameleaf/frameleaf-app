"""FL-984: an Intel NPU through OpenVINO, with fixed shapes and a fallback that never fails a model."""

from pathlib import Path
from unittest import mock

import numpy as np
import onnx
import pytest
from onnx import TensorProto, helper
from pytest_mock import MockerFixture

from frameleaf_ml.config import settings
from frameleaf_ml.sessions import ort as ort_module
from frameleaf_ml.sessions.ort import OrtSession, _get_openvino_device_type, _npu_reshape


def _model(path: Path, dims: list[int | str]) -> Path:
    graph = helper.make_graph(
        [helper.make_node("Identity", ["image"], ["out"])],
        "g",
        [helper.make_tensor_value_info("image", TensorProto.FLOAT, dims)],
        [helper.make_tensor_value_info("out", TensorProto.FLOAT, dims)],
    )
    onnx.save(helper.make_model(graph), path.as_posix())
    return path


class TestDeviceChoice:
    def test_auto_prefers_npu(self) -> None:
        assert _get_openvino_device_type(["CPU", "GPU.0", "NPU"], "0") == "NPU"

    def test_without_npu_auto_is_unchanged(self) -> None:
        assert _get_openvino_device_type(["CPU", "GPU.0"], "0") == "GPU.0"
        assert _get_openvino_device_type(["CPU"], "0") == "CPU"

    def test_gpu_and_cpu_choices_skip_the_npu(self) -> None:
        assert _get_openvino_device_type(["CPU", "GPU.0", "NPU"], "0", "GPU") == "GPU.0"
        assert _get_openvino_device_type(["CPU", "GPU.0", "NPU"], "0", "cpu") == "CPU"

    def test_npu_choice_without_npu_falls_back(self) -> None:
        assert _get_openvino_device_type(["CPU", "GPU.0"], "0", "NPU") == "GPU.0"


class TestReshape:
    def test_fixes_a_symbolic_batch(self, tmp_path: Path) -> None:
        assert _npu_reshape(_model(tmp_path / "m.onnx", ["batch", 3, 224, 224]), None) == "image[1,3,224,224]"

    def test_fixes_image_height_and_width_when_known(self, tmp_path: Path) -> None:
        assert _npu_reshape(_model(tmp_path / "m.onnx", [1, 3, "h", "w"]), 640) == "image[1,3,640,640]"

    def test_refuses_shapes_it_cannot_fix(self, tmp_path: Path) -> None:
        assert _npu_reshape(_model(tmp_path / "m.onnx", [1, 3, "h", "w"]), None) is None
        assert _npu_reshape(_model(tmp_path / "m.onnx", ["batch", "tokens"]), None) is None
        assert _npu_reshape(tmp_path / "missing.onnx", None) is None


@pytest.mark.ov_device_ids(["CPU", "GPU.0", "NPU"])
class TestSession:
    def test_compiles_for_the_npu_with_fixed_shapes(
        self, ov_device_ids: mock.Mock, ort_session: mock.Mock, tmp_path: Path
    ) -> None:
        path = _model(tmp_path / "model.onnx", ["batch", 3, 224, 224])

        session = OrtSession(path, providers=["OpenVINOExecutionProvider", "CPUExecutionProvider"])

        options = session.provider_options[0]
        assert options["device_type"] == "NPU"
        assert options["reshape_input"] == "image[1,3,224,224]"
        assert ort_module.npu_placements[path.as_posix()] == "NPU"

    def test_unfixable_model_uses_the_gpu_with_a_reason(
        self, ov_device_ids: mock.Mock, ort_session: mock.Mock, tmp_path: Path
    ) -> None:
        path = _model(tmp_path / "model.onnx", ["batch", "tokens"])

        session = OrtSession(path, providers=["OpenVINOExecutionProvider"])

        assert session.provider_options[0]["device_type"] == "GPU.0"
        assert "reshape_input" not in session.provider_options[0]
        assert "can't fix" in ort_module.npu_placements[path.as_posix()]

    def test_npu_compile_failure_falls_back_instead_of_failing(
        self, ov_device_ids: mock.Mock, ort_session: mock.Mock, tmp_path: Path
    ) -> None:
        path = _model(tmp_path / "model.onnx", ["batch", 3, 224, 224])
        ort_session.side_effect = [RuntimeError("unsupported operator"), mock.Mock()]

        session = OrtSession(path, providers=["OpenVINOExecutionProvider"])

        assert ort_session.call_count == 2
        assert session.provider_options[0]["device_type"] == "GPU.0"
        assert "failed to compile for the NPU" in ort_module.npu_placements[path.as_posix()]

    def test_splits_a_batch_for_the_npu(self, ov_device_ids: mock.Mock, ort_session: mock.Mock, tmp_path: Path) -> None:
        path = _model(tmp_path / "model.onnx", ["batch", 3, 2, 2])
        session = OrtSession(path, providers=["OpenVINOExecutionProvider"])
        ort_session.return_value.run.side_effect = lambda names, feed, options: [feed["image"] * 2]

        batch = np.arange(3 * 3 * 2 * 2, dtype=np.float32).reshape(3, 3, 2, 2)
        outputs = session.run(None, {"image": batch})

        assert ort_session.return_value.run.call_count == 3
        np.testing.assert_array_equal(outputs[0], batch * 2)

    def test_gpu_setting_never_uses_the_npu(
        self, ov_device_ids: mock.Mock, ort_session: mock.Mock, tmp_path: Path, mocker: MockerFixture
    ) -> None:
        mocker.patch.object(settings, "openvino_device", "GPU")
        path = _model(tmp_path / "model.onnx", ["batch", 3, 224, 224])

        session = OrtSession(path, providers=["OpenVINOExecutionProvider"])

        assert session.provider_options[0]["device_type"] == "GPU.0"
