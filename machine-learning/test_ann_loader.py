from collections.abc import Iterator
from ctypes import POINTER, Array, c_float, c_void_p, cast
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest

from frameleaf_ml.sessions.ann import loader


@pytest.fixture
def ann(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[loader.Ann, SimpleNamespace]]:
    native = SimpleNamespace(unload=Mock(), execute=Mock())
    monkeypatch.setattr(loader, "libann", native, raising=False)
    instance = object.__new__(loader.Ann)
    instance.ann = 123
    instance.input_shapes = {7: ((2,),)}
    instance.output_shapes = {7: ((2,),)}
    yield instance, native
    instance.ann = None


def test_unload_releases_both_shape_caches(ann: tuple[loader.Ann, SimpleNamespace]) -> None:
    instance, native = ann
    instance.unload(7)
    native.unload.assert_called_once_with(123, 7)
    assert instance.input_shapes == instance.output_shapes == {}


def test_unload_preserves_metadata_if_native_unload_fails(ann: tuple[loader.Ann, SimpleNamespace]) -> None:
    instance, native = ann
    native.unload.side_effect = RuntimeError("unload failed")
    with pytest.raises(RuntimeError, match="unload failed"):
        instance.unload(7)
    assert instance.input_shapes == instance.output_shapes == {7: ((2,),)}


def test_execute_keeps_tensor_buffers_live_and_returns_native_output(ann: tuple[loader.Ann, SimpleNamespace]) -> None:
    instance, native = ann
    inputs = [np.array([2, 3], dtype=np.float32)]

    def execute(handle: int, network_id: int, input_pointers: Array[c_void_p], output_pointers: Array[c_void_p]) -> int:
        assert (handle, network_id) == (123, 7)
        assert input_pointers[0] == inputs[0].ctypes.data
        source = cast(input_pointers[0], POINTER(c_float))
        target = cast(output_pointers[0], POINTER(c_float))
        target[0], target[1] = source[0] * 2, source[1] * 2
        return 0

    native.execute.side_effect = execute
    outputs = instance.execute(7, inputs)
    np.testing.assert_array_equal(outputs[0], [4, 6])
    np.testing.assert_array_equal(inputs[0], [2, 3])


def test_execute_raises_when_native_execution_fails(ann: tuple[loader.Ann, SimpleNamespace]) -> None:
    instance, native = ann
    native.execute.return_value = -1
    with pytest.raises(RuntimeError, match="ANN execution failed"):
        instance.execute(7, [np.array([2, 3], dtype=np.float32)])


@pytest.mark.parametrize("inputs", [(), [], [np.zeros(3, dtype=np.float32)], [np.zeros(4, dtype=np.float32)[::2]]])
def test_execute_rejects_invalid_inputs_before_native_call(
    ann: tuple[loader.Ann, SimpleNamespace], inputs: object
) -> None:
    instance, native = ann
    with pytest.raises(ValueError):
        instance.execute(7, inputs)  # type: ignore[arg-type]  # Exercise invalid runtime inputs.
    native.execute.assert_not_called()


@pytest.mark.parametrize("failure_at,cleanup_fails", [(1, False), (2, False), (2, True)])
def test_load_releases_network_if_shape_discovery_fails(
    ann: tuple[loader.Ann, SimpleNamespace],
    monkeypatch: pytest.MonkeyPatch,
    failure_at: int,
    cleanup_fails: bool,
) -> None:
    instance, native = ann
    native.load = Mock(return_value=8)
    if cleanup_fails:
        native.unload.side_effect = RuntimeError("cleanup failed")
    monkeypatch.setattr(loader, "exists", lambda _: True)
    monkeypatch.setattr(instance, "tensors", Mock(return_value=1))
    shapes = Mock(side_effect=[ValueError("shape failed")] if failure_at == 1 else [(2,), ValueError("shape failed")])
    monkeypatch.setattr(instance, "shape", shapes)

    with pytest.raises(ValueError, match="shape failed"):
        instance.load("model.armnn")

    native.unload.assert_called_once_with(123, 8)
    assert instance.input_shapes == instance.output_shapes == {7: ((2,),)}


def test_load_publishes_both_shape_caches_after_discovery(
    ann: tuple[loader.Ann, SimpleNamespace], monkeypatch: pytest.MonkeyPatch
) -> None:
    instance, native = ann
    native.load = Mock(return_value=8)
    monkeypatch.setattr(loader, "exists", lambda _: True)
    monkeypatch.setattr(instance, "tensors", Mock(return_value=1))
    monkeypatch.setattr(instance, "shape", Mock(side_effect=[(2,), (3,)]))

    assert instance.load("model.armnn", fast_math=False, fp16=True) == 8

    native.load.assert_called_once_with(123, b"model.armnn", False, True, False, None)
    native.unload.assert_not_called()
    assert instance.input_shapes == {7: ((2,),), 8: ((2,),)}
    assert instance.output_shapes == {7: ((2,),), 8: ((3,),)}
