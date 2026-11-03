"""Which Hub repositories a request may make the worker download (image description, NSFW detection)."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from frameleaf_ml.config import Settings, settings
from frameleaf_ml.models.base import ModelUnavailableError
from frameleaf_ml.models.hub_trust import check_repository_trust, repository_owner
from frameleaf_ml.models.image_description import MODEL_FILE_PATTERNS as DESCRIPTION_FILES
from frameleaf_ml.models.image_description import ImageDescriptionModel
from frameleaf_ml.models.nsfw_detection import MODEL_FILE_PATTERNS as NSFW_FILES
from frameleaf_ml.models.nsfw_detection import NsfwDetectionModel


@pytest.fixture(autouse=True)
def public_source(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "model_source_url", None)
    monkeypatch.setattr(settings, "model_source_token", None)
    monkeypatch.delenv("HF_ENDPOINT", raising=False)
    monkeypatch.setattr(settings.image_description, "trusted_custom_models", [])
    monkeypatch.setattr(settings.nsfw_detection, "trusted_custom_models", [])


def test_repository_owner_requires_a_well_formed_identifier() -> None:
    assert repository_owner("Qwen/Qwen2.5-VL-3B-Instruct") == "Qwen"
    for malformed in ("Qwen", "/name", "owner/", "a/b/c", "../etc", "a b/c", "", "owner/name?x"):
        assert repository_owner(malformed) is None, malformed


def test_curated_owners_and_explicit_consent_pass_and_nothing_else() -> None:
    check_repository_trust("qwen/anything", owners={"Qwen"}, trusted=[], setting="SETTING")
    check_repository_trust("evil/repo", owners={"Qwen"}, trusted=["evil/repo"], setting="SETTING")
    with pytest.raises(ModelUnavailableError, match="SETTING"):
        check_repository_trust("evil/repo", owners={"Qwen"}, trusted=["evil/other"], setting="SETTING")
    with pytest.raises(ModelUnavailableError):
        check_repository_trust("Qwen", owners={"Qwen"}, trusted=[], setting="SETTING")


@pytest.mark.parametrize("name", ["evil/fifty-gigabytes", "Qwen-lookalike/model", "../../etc"])
def test_image_description_refuses_an_arbitrary_repository_before_any_download(name: str, tmp_path: Path) -> None:
    model = ImageDescriptionModel(name, acceleration="cuda", cache_dir=tmp_path)
    with patch("frameleaf_ml.models.image_description.snapshot_download") as download:
        with pytest.raises(ModelUnavailableError, match="IMAGE_DESCRIPTION__TRUSTED_CUSTOM_MODELS"):
            model._download()
    download.assert_not_called()


@pytest.mark.parametrize(
    ("name", "acceleration"),
    [
        ("Qwen/Qwen2.5-VL-3B-Instruct", "cuda"),
        ("Qwen/Qwen2.5-VL-7B-Instruct", "openvino"),
        ("OpenVINO/x-ov", "openvino"),
    ],
)
def test_image_description_downloads_only_the_files_it_loads(
    name: str, acceleration: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("frameleaf_ml.models.image_description.openvino_genai_importable", lambda: True)
    monkeypatch.setattr("frameleaf_ml.models.image_description.find_spec", lambda _: object())
    model = ImageDescriptionModel(name, acceleration=acceleration, cache_dir=tmp_path)
    with patch("frameleaf_ml.models.image_description.snapshot_download") as download:
        model._download()
    patterns = download.call_args.kwargs["allow_patterns"]
    assert patterns == DESCRIPTION_FILES
    # No repository Python and no pickled weights, whatever the repository ships.
    assert "*.py" not in patterns and "*.bin" not in patterns and "*" not in patterns


def test_explicitly_trusted_custom_florence_also_fetches_its_python(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    name = "example/Florence-2-custom"
    model = ImageDescriptionModel(name, acceleration="cuda", cache_dir=tmp_path)
    with patch("frameleaf_ml.models.image_description.snapshot_download") as download:
        with pytest.raises(ModelUnavailableError):
            model._download()
        monkeypatch.setattr(settings.image_description, "trusted_custom_models", [name])
        model._download()
    assert download.call_count == 1
    assert download.call_args.kwargs["allow_patterns"] == DESCRIPTION_FILES + ["*.py"]


def test_nsfw_detection_refuses_an_arbitrary_repository_and_limits_the_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with patch("frameleaf_ml.models.nsfw_detection.snapshot_download") as download:
        with pytest.raises(ModelUnavailableError, match="NSFW_DETECTION__TRUSTED_CUSTOM_MODELS"):
            NsfwDetectionModel("evil/fifty-gigabytes", cache_dir=tmp_path)._download()
        download.assert_not_called()
        NsfwDetectionModel("onnx-community/nsfw_image_detection-ONNX", cache_dir=tmp_path)._download()
        assert download.call_args.kwargs["allow_patterns"] == NSFW_FILES
        monkeypatch.setattr(settings.nsfw_detection, "trusted_custom_models", ["evil/fifty-gigabytes"])
        NsfwDetectionModel("evil/fifty-gigabytes", cache_dir=tmp_path)._download()
    assert download.call_count == 2


def test_consent_and_cache_bound_are_worker_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MACHINE_LEARNING_NSFW_DETECTION__TRUSTED_CUSTOM_MODELS", json.dumps(["example/classifier"]))
    monkeypatch.setenv("MACHINE_LEARNING_MODEL_CACHE_MAX_ENTRIES", "4")
    loaded = Settings()
    assert loaded.nsfw_detection.trusted_custom_models == ["example/classifier"]
    assert loaded.model_cache_max_entries == 4
