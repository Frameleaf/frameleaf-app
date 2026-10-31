import asyncio
from threading import Event

import pytest

from frameleaf_ml import main


@pytest.mark.asyncio
async def test_cancelled_native_work_keeps_capacity_until_it_finishes(monkeypatch):
    from frameleaf_ml.inference_executor import InferenceBusy, InferenceExecutor

    started, finish = Event(), Event()

    def blocking():
        started.set()
        assert finish.wait(5)

    with InferenceExecutor(1) as pool:
        monkeypatch.setattr(main, "thread_pool", pool)
        task = asyncio.create_task(main.run(blocking))
        while not started.is_set():
            await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        try:
            assert pool.busy
            with pytest.raises(InferenceBusy):
                await main.run(lambda: None)
        finally:
            finish.set()
    assert not pool.busy


def test_executor_refuses_overload_before_queueing_native_work():
    from frameleaf_ml.inference_executor import InferenceBusy, InferenceExecutor

    started, finish, queued_ran = Event(), Event(), Event()

    def blocking():
        started.set()
        assert finish.wait(5)

    with InferenceExecutor(1) as pool:
        running = pool.submit(blocking)
        assert started.wait(2)
        try:
            with pytest.raises(InferenceBusy):
                pool.submit(queued_ran.set)
            assert pool.busy
        finally:
            finish.set()
        running.result(2)
    assert not queued_ran.is_set()
    assert not pool.busy


@pytest.mark.asyncio
@pytest.mark.parametrize("loaded", [False, True])
async def test_one_worker_can_finish_a_request_with_independent_entries(monkeypatch, loaded):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from frameleaf_ml.inference_executor import InferenceExecutor
    from frameleaf_ml.schemas import ModelTask, ModelType

    entered, finish = Event(), Event()

    def predict(*args, **kwargs):
        entered.set()
        assert finish.wait(5)
        return "result"

    async def get(name, type_, task, **kwargs):
        model = SimpleNamespace(identity=(type_, task), depends=[], loaded=loaded, load_attempts=0, predict=predict)
        model.load = lambda: setattr(model, "loaded", True)
        return model

    monkeypatch.setattr(main.settings, "request_threads", 1)
    monkeypatch.setattr(main.model_cache, "get", AsyncMock(side_effect=get))
    entries = (
        [
            {"name": "one", "type": ModelType.TEXTUAL, "task": ModelTask.SEARCH, "options": {}},
            {"name": "two", "type": ModelType.CLASSIFICATION, "task": ModelTask.NSFW_DETECTION, "options": {}},
        ],
        [],
    )
    with InferenceExecutor(1) as pool:
        monkeypatch.setattr(main, "thread_pool", pool)
        task = asyncio.create_task(main.run_inference("fixture", entries))
        while not entered.is_set():
            await asyncio.sleep(0)
        try:
            await asyncio.sleep(0)
        finally:
            finish.set()
        assert await task == {ModelTask.SEARCH: "result", ModelTask.NSFW_DETECTION: "result"}
