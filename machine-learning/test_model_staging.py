import hashlib
import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

import httpx
import pytest
from fastapi import HTTPException
from filelock import FileLock, Timeout
from huggingface_hub import set_client_factory
from huggingface_hub.errors import LocalEntryNotFoundError

from immich_ml.config import settings
from immich_ml.main import load
from immich_ml.models.base import InferenceModel, ModelUnavailableError
from immich_ml.models.florence_manifest import FLORENCE_MODELS
from immich_ml.models.image_description import ImageDescriptionModel
from immich_ml.privacy import _download_client
from immich_ml.schemas import ModelTask, ModelType
from immich_ml.staging import RECEIPT, cache_hashes, stage_model, verify_staged


class SyntheticModel(InferenceModel):
    identity = (ModelType.VISUAL, ModelTask.IMAGE_DESCRIPTION)
    depends = []
    content = b"synthetic model v1"

    def _download(self) -> None:
        self.model_path.parent.mkdir(parents=True, exist_ok=True)
        self.model_path.write_bytes(self.content)

    def _load(self) -> Any:
        return self.model_path.read_bytes()

    def _predict(self, *inputs: Any, **kwargs: Any) -> Any:
        return self.session


@pytest.fixture
def model(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SyntheticModel:
    monkeypatch.setattr(settings, "model_downloads", True)
    return SyntheticModel("synthetic", cache_dir=tmp_path / "cache")


def test_cold_staging_never_executes_inference_and_offline_reload_works(
    model: SyntheticModel, monkeypatch: pytest.MonkeyPatch
) -> None:
    with patch.object(model, "_load") as load, patch.object(model, "_predict") as predict:
        stage_model(model)
        load.assert_not_called()
        predict.assert_not_called()
    assert (model.cache_dir / RECEIPT).is_file()
    monkeypatch.setattr(settings, "model_downloads", False)
    with patch.object(model, "_download") as download:
        assert model.predict(b"synthetic image") == model.content
        download.assert_not_called()


def test_pinned_florence_staging_preserves_repository_cache_and_offline_verification(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "cache_folder", tmp_path)
    monkeypatch.setattr(settings, "model_downloads", True)
    monkeypatch.setattr(settings, "model_source_url", None)
    monkeypatch.delenv("HF_ENDPOINT", raising=False)
    name = "microsoft/Florence-2-base-ft"
    files = {"config.json": b"{}", "model.safetensors": b"synthetic weights", "tokenizer.json": b"{}"}
    manifest = {
        **FLORENCE_MODELS[name],
        "files": {name: {"sha256": hashlib.sha256(body).hexdigest()} for name, body in files.items()},
    }
    monkeypatch.setitem(FLORENCE_MODELS, name, manifest)
    model = ImageDescriptionModel(name, acceleration="cuda", device="cpu")
    active = model.cache_dir
    assert active.parent.name == hashlib.sha256(model.hf_model_name.encode()).hexdigest()

    def acquire(repo: str, **kwargs: Any) -> None:
        assert repo == manifest["repository"]
        assert kwargs["revision"] == manifest["revision"]
        assert kwargs["token"] is False
        destination = Path(kwargs["local_dir"])
        destination.mkdir(parents=True)
        for name, body in files.items():
            (destination / name).write_bytes(body)

    with patch("immich_ml.models.image_description.snapshot_download", side_effect=acquire) as download:
        with patch.object(model, "_load") as load_model:
            stage_model(model)
            monkeypatch.setattr(settings, "model_downloads", False)
            model.download()
            assert download.call_count == 1
            load_model.assert_not_called()
    assert model.cache_dir == active
    assert model.model_path == active / manifest["revision"]
    verify_staged(active)


def test_warm_staging_reuses_verified_files_without_downloads(model: SyntheticModel) -> None:
    stage_model(model)
    with patch.object(model, "_download") as download:
        stage_model(model)
        download.assert_not_called()


def test_legacy_adoption_acquires_and_preserves_unverified_bytes(model: SyntheticModel) -> None:
    model.model_path.parent.mkdir(parents=True)
    model.model_path.write_bytes(b"unverified legacy weights")
    stage_model(model)
    assert model.model_path.read_bytes() == model.content
    legacy = model.cache_dir.with_name(f".{model.cache_dir.name}.unverified")
    assert (legacy / "visual/model.onnx").read_bytes() == b"unverified legacy weights"
    model.content = b"synthetic v2"
    stage_model(model, refresh=True)
    assert (legacy / "visual/model.onnx").read_bytes() == b"unverified legacy weights"


@pytest.mark.parametrize("status", [401, 404, 503])
def test_hub_source_failure_cannot_certify_legacy_files(
    model: SyntheticModel, monkeypatch: pytest.MonkeyPatch, status: int
) -> None:
    model.model_path.parent.mkdir(parents=True)
    model.model_path.write_bytes(b"unverified legacy weights")
    monkeypatch.setattr(settings, "model_source_url", "https://unavailable-source.example")
    monkeypatch.setattr(model, "_download", lambda: InferenceModel._download(model))
    requests = []

    def unavailable(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status, json={"error": "repository unavailable"})

    set_client_factory(lambda: httpx.Client(transport=httpx.MockTransport(unavailable)))
    try:
        with pytest.raises((ModelUnavailableError, LocalEntryNotFoundError)):
            stage_model(model)
    finally:
        set_client_factory(_download_client)
    assert len(requests) == 1
    assert requests[0].url.host == "unavailable-source.example"
    assert model.model_path.read_bytes() == b"unverified legacy weights"
    assert not (model.cache_dir / RECEIPT).exists()


def test_empty_cache_can_be_staged(model: SyntheticModel) -> None:
    model.cache_dir.mkdir()
    stage_model(model)
    verify_staged(model.cache_dir)


def test_refresh_preserves_unknown_previous_directory(model: SyntheticModel) -> None:
    stage_model(model)
    previous = model.cache_dir.with_name(f".{model.cache_dir.name}.previous")
    previous.mkdir()
    (previous / "keep.txt").write_text("operator files")
    with pytest.raises(ModelUnavailableError):
        stage_model(model, refresh=True)
    assert (previous / "keep.txt").read_text() == "operator files"
    verify_staged(model.cache_dir)


def test_failed_refresh_preserves_previous_warm_cache(model: SyntheticModel) -> None:
    stage_model(model)
    with patch.object(model, "_download", side_effect=ValueError("bad upstream hash")):
        with pytest.raises(ValueError, match="bad upstream hash"):
            stage_model(model, refresh=True)
    verify_staged(model.cache_dir)
    assert model.model_path.read_bytes() == model.content
    assert not list(model.cache_dir.parent.glob("*.staging-*/"))


def test_refresh_rollback_and_shared_cache_files_survive(
    model: SyntheticModel, monkeypatch: pytest.MonkeyPatch
) -> None:
    stage_model(model)
    other = SyntheticModel("synthetic", cache_dir=model.cache_dir)
    monkeypatch.setattr(other, "identity", (ModelType.TEXTUAL, ModelTask.IMAGE_DESCRIPTION))
    other.content = b"shared textual weights"
    stage_model(other)
    model.content = b"synthetic v2"
    stage_model(model, refresh=True)
    assert model.model_path.read_bytes() == model.content
    assert other.model_path.read_bytes() == other.content
    stage_model(model, rollback=True)
    assert model.model_path.read_bytes() == b"synthetic model v1"
    verify_staged(model.cache_dir)
    stage_model(model, rollback=True)
    assert model.model_path.read_bytes() == b"synthetic v2"


def test_failed_publish_restores_active_cache(model: SyntheticModel) -> None:
    stage_model(model)
    model.content = b"v2"
    with patch("immich_ml.staging.os.replace", side_effect=OSError("synthetic publish failure")):
        with pytest.raises(OSError, match="synthetic publish failure"):
            stage_model(model, refresh=True)
    assert model.model_path.read_bytes() == b"synthetic model v1"
    verify_staged(model.cache_dir)


@pytest.mark.parametrize("change", ["weight", "extra", "receipt", "symlink"])
def test_offline_load_rejects_modified_staged_files(
    model: SyntheticModel, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
    stage_model(model)
    if change == "weight":
        model.model_path.write_bytes(b"changed")
    elif change == "extra":
        (model.cache_dir / "extra.py").write_text("raise RuntimeError('must not execute')")
    elif change == "receipt":
        (model.cache_dir / RECEIPT).write_text("[]")
    else:
        model.model_path.unlink()
        model.model_path.symlink_to(model.cache_dir / "missing")
    monkeypatch.setattr(settings, "model_downloads", False)
    with patch.object(model, "_load") as load, patch.object(model, "_download") as download:
        with pytest.raises(ModelUnavailableError):
            model.load()
        load.assert_not_called()
        download.assert_not_called()


def test_concurrent_staging_does_not_replace_files(model: SyntheticModel) -> None:
    model.cache_dir.parent.mkdir(exist_ok=True)
    with FileLock(str(model.cache_dir.with_name(f".{model.cache_dir.name}.staging.lock"))):
        with pytest.raises(Timeout):
            stage_model(model)
    assert not model.cache_dir.exists()


def test_missing_model_offline_gives_staging_guidance(model: SyntheticModel, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "model_downloads", False)
    with patch.object(model, "_download") as download:
        with pytest.raises(ModelUnavailableError, match="model-staging"):
            model.download()
        download.assert_not_called()


@pytest.mark.asyncio
async def test_offline_load_failure_preserves_staged_cache(
    model: SyntheticModel, monkeypatch: pytest.MonkeyPatch
) -> None:
    stage_model(model)
    monkeypatch.setattr(settings, "model_downloads", False)
    with patch.object(model, "_load", side_effect=OSError("synthetic runtime failure")):
        with patch.object(model, "clear_cache") as clear:
            with pytest.raises(HTTPException) as error:
                await load(model)
            assert error.value.status_code == 503
            assert "model-staging" in error.value.detail
            clear.assert_not_called()
    verify_staged(model.cache_dir)


def test_receipt_records_exact_model_bytes_without_download_metadata(model: SyntheticModel) -> None:
    stage_model(model)
    metadata = model.cache_dir / ".cache" / "huggingface"
    metadata.mkdir(parents=True)
    (metadata / "download.lock").touch()
    assert json.loads((model.cache_dir / RECEIPT).read_text()) == cache_hashes(model.cache_dir)
    verify_staged(model.cache_dir)
