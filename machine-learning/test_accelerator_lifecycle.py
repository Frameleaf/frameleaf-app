from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from unittest.mock import Mock, patch

import numpy as np
import pytest
from numpy.typing import NDArray

from frameleaf_ml.sessions.ann import AnnSession
from frameleaf_ml.sessions.ann.loader import Ann
from frameleaf_ml.sessions.rknn import rknnpool


@pytest.mark.parametrize("loaded", [False, True])
def test_ann_session_releases_runtime_once_even_after_partial_construction(loaded: bool) -> None:
    session = object.__new__(AnnSession)
    native = Mock()
    session.ann = native
    if loaded:
        session.model = 0
    try:
        session.__del__()
        session.__del__()
        native.destroy.assert_called_once()
        if loaded:
            native.unload.assert_called_once_with(0)
        else:
            native.unload.assert_not_called()
    finally:
        session.__dict__.pop("ann", None)


def test_ann_session_releases_runtime_when_unload_raises() -> None:
    session = object.__new__(AnnSession)
    session.ann = native = Mock()
    session.model = 1
    native.unload.side_effect = RuntimeError("unload failed")
    try:
        with pytest.raises(RuntimeError, match="unload failed"):
            session.__del__()
        native.destroy.assert_called_once()
    finally:
        session.__dict__.pop("ann", None)


def test_uninitialized_ann_objects_are_safe_to_finalize() -> None:
    object.__new__(AnnSession).__del__()
    object.__new__(Ann).__del__()


def test_rknn_uses_available_runtime_instead_of_reusing_busy_runtime() -> None:
    runtimes = [Mock(), Mock()]
    started, finish = Event(), Event()
    zero, one, two = [np.array([value], dtype=np.float32) for value in range(3)]

    def infer(runtime: Mock, inputs: list[NDArray[np.float32]]) -> list[NDArray[np.float32]]:
        if inputs[0] is zero:
            started.set()
            assert finish.wait(5)
        return [np.array([runtimes.index(runtime)], dtype=np.float32)]

    with patch.object(rknnpool, "init_rknn", side_effect=runtimes):
        pool = rknnpool.RknnPoolExecutor("model.rknn", 2, infer)
    try:
        with ThreadPoolExecutor(max_workers=2) as callers:
            first = callers.submit(pool.run, [zero])
            try:
                assert started.wait(5)
                np.testing.assert_array_equal(pool.run([one])[0], [1])
                np.testing.assert_array_equal(pool.run([two])[0], [1])
            finally:
                finish.set()
            np.testing.assert_array_equal(first.result(timeout=5)[0], [0])
    finally:
        pool.release()


def test_partial_rknn_pool_construction_releases_loaded_models() -> None:
    native = Mock()
    with patch.object(rknnpool, "init_rknn", side_effect=[native, RuntimeError("load failed")]):
        with pytest.raises(RuntimeError, match="load failed"):
            rknnpool.RknnPoolExecutor("model.rknn", 2, Mock())
    native.release.assert_called_once()


def test_rknn_returns_runtime_after_inference_failure_and_rejects_calls_after_release() -> None:
    infer = Mock(side_effect=[RuntimeError("inference failed"), []])
    with patch.object(rknnpool, "init_rknn", return_value=Mock()):
        pool = rknnpool.RknnPoolExecutor("model.rknn", 1, infer)
    try:
        with pytest.raises(RuntimeError, match="inference failed"):
            pool.run([])
        assert pool.run([]) == []
    finally:
        pool.release()
    with pytest.raises(RuntimeError, match="released"):
        pool.run([])


def test_rknn_release_is_idempotent_and_attempts_every_runtime() -> None:
    runtimes = [Mock(), Mock()]
    runtimes[0].release.side_effect = RuntimeError("release failed")
    with patch.object(rknnpool, "init_rknn", side_effect=runtimes):
        pool = rknnpool.RknnPoolExecutor("model.rknn", 2, Mock())
    with pytest.raises(RuntimeError, match="release failed"):
        pool.release()
    pool.release()
    for runtime in runtimes:
        runtime.release.assert_called_once()


@pytest.mark.parametrize("load_status,runtime_status", [(1, 0), (0, 1)])
def test_failed_rknn_initialization_releases_native_handle(load_status: int, runtime_status: int) -> None:
    native = Mock()
    native.load_rknn.return_value = load_status
    native.init_runtime.return_value = runtime_status
    with (
        patch.object(rknnpool, "is_available", True),
        patch.object(rknnpool, "RKNNLite", return_value=native, create=True),
    ):
        with pytest.raises(RuntimeError):
            rknnpool.init_rknn(Path("model.rknn").as_posix())
    native.release.assert_called_once()
