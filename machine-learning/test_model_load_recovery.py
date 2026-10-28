"""A cached model can recover without request-driven load/repair storms."""

import errno
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from frameleaf_ml.config import settings
from frameleaf_ml.main import load
from frameleaf_ml.models.base import InferenceModel, ModelUnavailableError
from frameleaf_ml.models.cache import ModelCache
from frameleaf_ml.schemas import ModelFormat, ModelTask, ModelType
from frameleaf_ml.staging import stage_model, verify_staged


class RecoveringModel(InferenceModel):
    identity = (ModelType.VISUAL, ModelTask.SEARCH)
    depends = []

    def __init__(self, cache_dir: Path, failures: list[Exception]) -> None:
        super().__init__("synthetic", cache_dir=cache_dir)
        self.failures = failures
        self.loads = 0
        self.downloads = 0

    def _download(self) -> None:
        self.downloads += 1
        self.model_path.parent.mkdir(parents=True, exist_ok=True)
        self.model_path.write_bytes(b"synthetic model")

    def _load(self) -> Any:
        self.loads += 1
        if self.failures:
            raise self.failures.pop(0)
        return self.model_path.read_bytes()

    def _predict(self, *inputs: Any, **kwargs: Any) -> Any:
        return self.session


@pytest.mark.asyncio
async def test_revalidated_cached_model_recovers_after_cooldown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "model_downloads", True)
    model = RecoveringModel(tmp_path, [OSError(errno.EAGAIN, "busy"), OSError(errno.ENOMEM, "memory")])
    cache = ModelCache(revalidate=True)
    with patch("frameleaf_ml.models.cache.from_model_type", return_value=model):
        with patch("frameleaf_ml.main.time.monotonic", return_value=100.0) as clock:
            with pytest.raises((OSError, HTTPException)):
                await load(await cache.get("synthetic", *model.identity, ttl=60))
            assert model.loads == 2
            for now in (101.0, 129.0):
                clock.return_value = now
                with pytest.raises(HTTPException):
                    await load(await cache.get("synthetic", *model.identity, ttl=60))
                assert model.loads == 2
                assert model.downloads == 2
            clock.return_value = 130.0
            assert await load(await cache.get("synthetic", *model.identity, ttl=60)) is model
    assert model.loaded
    assert model.loads == 3
    assert model.session == b"synthetic model"
    await cache.cache.clear()


@pytest.mark.asyncio
@pytest.mark.parametrize("tamper", [False, True])
async def test_offline_recovery_reverifies_staged_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tamper: bool
) -> None:
    monkeypatch.setattr(settings, "model_downloads", True)
    model = RecoveringModel(tmp_path / "model", [OSError(errno.ENOMEM, "memory")])
    stage_model(model)
    monkeypatch.setattr(settings, "model_downloads", False)
    with patch("frameleaf_ml.main.time.monotonic", return_value=100.0) as clock:
        with pytest.raises(HTTPException) as error:
            await load(model)
        assert error.value.status_code == 503
        assert "model-staging" in error.value.detail
        with pytest.raises(HTTPException):
            await load(model)
        assert model.loads == 1
        if tamper:
            model.model_path.write_bytes(b"tampered")
        clock.return_value = 130.0
        if tamper:
            with pytest.raises(HTTPException) as error:
                await load(model)
            assert error.value.status_code == 503
            assert model.loads == 1
        else:
            assert await load(model) is model
            assert model.loaded
            verify_staged(model.cache_dir)
        assert model.downloads == 1  # staging was the only acquisition


@pytest.mark.asyncio
async def test_permanent_model_source_error_never_clears_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "model_downloads", True)
    model = RecoveringModel(tmp_path, [ModelUnavailableError("Configure the model source")])
    with patch.object(model, "clear_cache") as clear:
        with pytest.raises(HTTPException) as error:
            await load(model)
        assert error.value.status_code == 503
        assert error.value.detail == "Configure the model source"
        clear.assert_not_called()


@pytest.mark.asyncio
async def test_accelerator_fallback_failure_recovers_after_cooldown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "model_downloads", True)
    model = RecoveringModel(tmp_path, [FileNotFoundError("accelerator absent"), OSError("transient ONNX failure")])
    model.model_format = ModelFormat.ARMNN
    with patch("frameleaf_ml.main.time.monotonic", return_value=100.0) as clock:
        with pytest.raises(HTTPException):
            await load(model)
        assert model.loads == 2
        assert model.model_format == ModelFormat.ONNX
        clock.return_value = 129.0
        with pytest.raises(HTTPException):
            await load(model)
        assert model.loads == 2
        clock.return_value = 130.0
        assert await load(model) is model
        assert model.loaded
        assert model.loads == 3


@pytest.mark.asyncio
async def test_successful_repair_can_be_unloaded_and_loaded_again(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "model_downloads", True)
    model = RecoveringModel(tmp_path, [OSError("repairable cache failure")])
    assert await load(model) is model
    assert model.loaded
    assert model.loads == 2
    model.unload()
    assert not model.loaded
    assert await load(model) is model
    assert model.loaded
    assert model.loads == 3
