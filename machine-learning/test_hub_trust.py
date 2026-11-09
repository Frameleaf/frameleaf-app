"""Which Hub repositories a request may make the worker download (image description, NSFW detection)."""

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException
from huggingface_hub.errors import RepositoryNotFoundError

from frameleaf_ml.config import Settings, settings
from frameleaf_ml.main import CustomClipModelRequest, custom_clip_model
from frameleaf_ml.models.base import ModelUnavailableError
from frameleaf_ml.models.clip import hugging_face
from frameleaf_ml.models.clip.textual import OpenClipTextualEncoder
from frameleaf_ml.models.clip.visual import OpenClipVisualEncoder
from frameleaf_ml.models.constants import get_model_source, is_custom_clip_model
from frameleaf_ml.models.hub_trust import check_repository_trust, repository_owner
from frameleaf_ml.models.image_description import MODEL_FILE_PATTERNS as DESCRIPTION_FILES
from frameleaf_ml.models.image_description import ImageDescriptionModel
from frameleaf_ml.models.nsfw_detection import MODEL_FILE_PATTERNS as NSFW_FILES
from frameleaf_ml.models.nsfw_detection import NsfwDetectionModel
from frameleaf_ml.schemas import ModelFormat, ModelSource


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


CUSTOM_REPOSITORY = "someone/my-search-model"
GOOD_SETTINGS: dict[str, Any] = {
    "config.json": {"embed_dim": 640, "text_cfg": {"context_length": 77}},
    "visual/preprocess_cfg.json": {"size": [224, 224], "interpolation": "bicubic", "mean": [0.5], "std": [0.5]},
    "textual/tokenizer_config.json": {"pad_token": "<pad>"},
}


def serve_repository(files: list[str], settings_files: dict[str, Any] | None = None) -> tuple[MagicMock, Any]:
    """A Hub whose repository lists `files` and whose snapshot writes the small settings files."""
    siblings = [SimpleNamespace(rfilename=name, size=100) for name in files]
    api = MagicMock()
    api.return_value.model_info.return_value = SimpleNamespace(siblings=siblings)

    def write(_repo: str, *, local_dir: Path, allow_patterns: list[str], **_: Any) -> str:
        for name, content in (settings_files if settings_files is not None else GOOD_SETTINGS).items():
            if name in allow_patterns:
                target = Path(local_dir) / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content if isinstance(content, str) else json.dumps(content))
        return str(local_dir)

    return api, write


def test_custom_clip_name_is_a_hugging_face_repository_and_published_names_are_not() -> None:
    assert is_custom_clip_model(CUSTOM_REPOSITORY)
    assert get_model_source(CUSTOM_REPOSITORY) == ModelSource.OPENCLIP
    assert not is_custom_clip_model("ViT-B-32__openai")
    assert not is_custom_clip_model("immich-app/ViT-B-32__openai")
    assert get_model_source("M-CLIP/XLM-Roberta-Large-Vit-L-14") == ModelSource.MCLIP
    assert get_model_source("no-owner-here") is None


@pytest.mark.parametrize(
    "name",
    [
        "../../etc",
        "org/..",
        "org/../x",
        "a--b/c",
        "a/b--c",
        "a/b/c",
        "org/na me",
        "org/name\n",
        "/name",
        "org/",
        "a\\b/c",
    ],
)
def test_malformed_repository_names_are_refused(name: str) -> None:
    assert not is_custom_clip_model(name)
    assert get_model_source(name) is None
    with pytest.raises(ValueError):
        hugging_face.custom_cache_folder(name)


def test_custom_cache_folder_stays_inside_the_cache_and_keeps_full_identity(tmp_path: Path) -> None:
    with patch.object(settings, "cache_folder", tmp_path):
        first = OpenClipVisualEncoder("a.b/c")
        second = OpenClipVisualEncoder("ab/c")
    assert first.cache_dir == tmp_path / "clip" / "custom" / "a.b--c"
    assert second.cache_dir == tmp_path / "clip" / "custom" / "ab--c"
    assert first.cache_dir.resolve().is_relative_to(tmp_path.resolve())
    assert first.model_format == ModelFormat.ONNX


def test_published_model_keeps_the_mirror_download_and_folder(tmp_path: Path) -> None:
    with patch.object(settings, "cache_folder", tmp_path):
        model = OpenClipVisualEncoder("ViT-B-32__openai")
    assert model.cache_dir == tmp_path / "clip" / "ViT-B-32__openai"
    assert model.custom_repository is None
    with patch("frameleaf_ml.models.base.snapshot_download") as download:
        model._download()
    assert download.call_args.args[0] == "frameleaf/ViT-B-32__openai"


def test_custom_download_fetches_only_the_files_the_encoders_load(tmp_path: Path) -> None:
    model = OpenClipTextualEncoder(CUSTOM_REPOSITORY, cache_dir=tmp_path)

    def write(_repo: str, *, local_dir: Path, allow_patterns: list[str], **_: Any) -> str:
        for name in allow_patterns:
            if name in hugging_face.REQUIRED_FILES:
                target = Path(local_dir) / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"{}")
        return str(local_dir)

    with patch.object(hugging_face, "snapshot_download", side_effect=write) as download:
        model.download()

    assert download.call_args.args == (CUSTOM_REPOSITORY,)
    arguments = download.call_args.kwargs
    assert arguments["endpoint"] == "https://huggingface.co"
    assert arguments["token"] is False
    assert arguments["allow_patterns"] == hugging_face.ALLOWED_FILES
    assert "trust_remote_code" not in arguments
    for pattern in hugging_face.ALLOWED_FILES:
        assert "*" not in pattern and not pattern.endswith((".py", ".bin", ".pkl", ".pt", ".pth", ".safetensors"))
    assert model.cached


def test_custom_download_refuses_a_repository_without_the_expected_layout(tmp_path: Path) -> None:
    model = OpenClipVisualEncoder(CUSTOM_REPOSITORY, cache_dir=tmp_path)
    with patch.object(hugging_face, "snapshot_download"):
        with pytest.raises(ModelUnavailableError, match="missing config.json.*visual/model.onnx"):
            model.download()
    assert not model.cached


def test_inspect_reads_the_embedding_size_from_the_config_without_fetching_weights() -> None:
    api, write = serve_repository(hugging_face.REQUIRED_FILES)
    with (
        patch.object(hugging_face, "HfApi", api),
        patch.object(hugging_face, "snapshot_download", side_effect=write) as download,
    ):
        assert hugging_face.inspect_custom_clip_model(CUSTOM_REPOSITORY) == 640
    api.assert_called_once_with(endpoint="https://huggingface.co", token=False)
    fetched = download.call_args.kwargs["allow_patterns"]
    assert not [name for name in fetched if name.endswith(".onnx")]


def test_inspect_names_what_a_refused_repository_is_missing() -> None:
    api, _ = serve_repository(["config.json", "visual/model.onnx"])
    with patch.object(hugging_face, "HfApi", api), patch.object(hugging_face, "snapshot_download") as download:
        with pytest.raises(ModelUnavailableError) as refused:
            hugging_face.inspect_custom_clip_model(CUSTOM_REPOSITORY)
    assert "someone/my-search-model" in str(refused.value)
    assert "visual/preprocess_cfg.json" in str(refused.value)
    assert "textual/model.onnx" in str(refused.value)
    assert "visual/model.onnx," not in str(refused.value)
    download.assert_not_called()


@pytest.mark.parametrize(
    "bad",
    [
        {"config.json": {"text_cfg": {}}},
        {"config.json": {"embed_dim": "640", "text_cfg": {}}},
        {"config.json": {"embed_dim": True, "text_cfg": {}}},
        {"config.json": {"embed_dim": 0, "text_cfg": {}}},
        {"config.json": {"embed_dim": 4096, "text_cfg": {}}},
        {"config.json": {"embed_dim": 640}},
        {"visual/preprocess_cfg.json": {"size": 224}},
        {"textual/tokenizer_config.json": {}},
    ],
)
def test_inspect_refuses_settings_the_encoders_cannot_use(bad: dict[str, Any]) -> None:
    api, write = serve_repository(hugging_face.REQUIRED_FILES, {**GOOD_SETTINGS, **bad})
    with patch.object(hugging_face, "HfApi", api), patch.object(hugging_face, "snapshot_download", side_effect=write):
        with pytest.raises(ModelUnavailableError, match="can't be used for search"):
            hugging_face.inspect_custom_clip_model(CUSTOM_REPOSITORY)


def test_inspect_explains_a_missing_repository_and_an_unreachable_hub() -> None:
    api = MagicMock()
    response = MagicMock(status_code=404, headers={})
    api.return_value.model_info.side_effect = RepositoryNotFoundError("nope", response=response)
    with patch.object(hugging_face, "HfApi", api):
        with pytest.raises(ModelUnavailableError, match="couldn't find 'someone/my-search-model'"):
            hugging_face.inspect_custom_clip_model(CUSTOM_REPOSITORY)

    api.return_value.model_info.side_effect = ConnectionError("no route")
    with patch.object(hugging_face, "HfApi", api):
        with pytest.raises(ModelUnavailableError, match="couldn't reach Hugging Face"):
            hugging_face.inspect_custom_clip_model(CUSTOM_REPOSITORY)


def test_staged_only_worker_refuses_a_custom_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "model_downloads", False)
    with patch.object(hugging_face, "HfApi") as api:
        with pytest.raises(ModelUnavailableError, match="prepared in advance"):
            hugging_face.inspect_custom_clip_model(CUSTOM_REPOSITORY)
    api.assert_not_called()


def test_custom_model_route_reports_the_size_and_turns_refusals_into_422() -> None:
    with patch("frameleaf_ml.main.inspect_custom_clip_model", return_value=640):
        response = custom_clip_model(CustomClipModelRequest(modelName=CUSTOM_REPOSITORY))
    assert json.loads(response.body) == {"dimSize": 640}

    with pytest.raises(HTTPException) as malformed:
        custom_clip_model(CustomClipModelRequest(modelName="../../etc"))
    assert malformed.value.status_code == 422

    refusal = ModelUnavailableError("The Hugging Face model can't be used for search: it's missing x.")
    with patch("frameleaf_ml.main.inspect_custom_clip_model", side_effect=refusal):
        with pytest.raises(HTTPException) as refused:
            custom_clip_model(CustomClipModelRequest(modelName=CUSTOM_REPOSITORY))
    assert refused.value.status_code == 422
    assert refused.value.detail == str(refusal)
