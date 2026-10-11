"""Artifact trust and native loading checks; model quality needs real runtime qualification."""

import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from immich_ml.config import Settings, settings
from immich_ml.models.base import ModelUnavailableError
from immich_ml.models.florence_manifest import FLORENCE_MODELS, florence_manifest, verify_florence_snapshot
from immich_ml.models.image_description import FLORENCE_MODEL_NAMES, ImageDescriptionModel

BUILTINS = tuple(FLORENCE_MODELS)


@pytest.fixture(params=BUILTINS)
def snapshot(request, tmp_path, monkeypatch):
    name = request.param
    contents = {
        "config.json": b'{"model_type":"florence2"}',
        "model.safetensors": b"synthetic weights",
        "tokenizer.json": b"synthetic tokenizer",
        "README.md": b"license: mit\nMicrosoft; florence-community",
    }
    manifest = {
        **FLORENCE_MODELS[name],
        "files": {file: {"sha256": hashlib.sha256(body).hexdigest()} for file, body in contents.items()},
    }
    monkeypatch.setitem(FLORENCE_MODELS, name, manifest)
    model = ImageDescriptionModel(name, acceleration="cuda", device="cpu", cache_dir=tmp_path)
    return model, manifest, contents


def populate(model, contents):
    model.model_path.mkdir(parents=True, exist_ok=True)
    for name, body in contents.items():
        (model.model_path / name).write_bytes(body)


@pytest.mark.parametrize("name", BUILTINS)
def test_manifest_covers_native_artifacts_and_attribution(name):
    assert set(FLORENCE_MODELS) == FLORENCE_MODEL_NAMES
    manifest = FLORENCE_MODELS[name]
    assert len(manifest["revision"]) == 40
    assert int(manifest["revision"], 16)
    assert manifest["license"] == "mit"
    assert "Microsoft" in manifest["attribution"]
    assert "florence-community" in manifest["attribution"]
    assert {"config.json", "tokenizer.json", "processor_config.json", "model.safetensors", "README.md"} <= set(
        manifest["files"]
    )
    assert all(set(digest) == {"sha256"} and len(digest["sha256"]) == 64 for digest in manifest["files"].values())
    assert not any(name.endswith((".py", ".bin", ".pkl")) for name in manifest["files"])
    assert florence_manifest(name.upper()) is manifest
    assert florence_manifest(manifest["repository"]) is manifest
    notice = Path(__file__).parent / "immich_ml/models" / manifest["noticeFile"]
    assert hashlib.sha256(notice.read_bytes()).hexdigest() == manifest["noticeSha256"]


@pytest.mark.parametrize("endpoint", ["https://models.example.test", "https://huggingface.co"])
def test_cold_download_pins_revision_files_and_public_credentials(snapshot, monkeypatch, endpoint):
    model, manifest, contents = snapshot
    monkeypatch.setattr(settings, "model_source_url", endpoint)
    calls = []

    def acquire(repo, **kwargs):
        calls.append((repo, kwargs))
        populate(model, contents)

    monkeypatch.setattr("immich_ml.models.image_description.snapshot_download", acquire)
    model.download()
    assert calls == [
        (
            manifest["repository"] if endpoint == "https://huggingface.co" else manifest["mirrorRepository"],
            {
                "revision": manifest["revision"],
                "allow_patterns": list(manifest["files"]),
                "cache_dir": model.cache_dir,
                "local_dir": model.model_path,
                "endpoint": endpoint,
                "token": False,
            },
        )
    ]
    assert model.model_path == model.cache_dir / manifest["revision"]
    verify_florence_snapshot(model.model_path, manifest)


def test_download_rejects_wrong_revision_bytes(snapshot, monkeypatch):
    model, _, contents = snapshot

    def acquire(*args, **kwargs):
        populate(model, {**contents, "config.json": b"another revision"})

    monkeypatch.setattr("immich_ml.models.image_description.snapshot_download", acquire)
    with pytest.raises(ModelUnavailableError, match="failed verification"):
        model.download()


@pytest.mark.parametrize("explicit_source", [None, "https://models.example.test"])
def test_unconfigured_source_keeps_pinned_hub_and_hf_endpoint_is_authoritative(snapshot, monkeypatch, explicit_source):
    model, manifest, contents = snapshot
    monkeypatch.setattr(settings, "model_source_url", None)
    monkeypatch.delenv("HF_ENDPOINT", raising=False)
    if explicit_source:
        monkeypatch.setenv("HF_ENDPOINT", explicit_source)
    acquire = Mock(side_effect=lambda *args, **kwargs: populate(model, contents))
    monkeypatch.setattr("immich_ml.models.image_description.snapshot_download", acquire)
    model.download()
    assert acquire.call_args.args == (manifest["mirrorRepository"] if explicit_source else manifest["repository"],)
    assert acquire.call_args.kwargs["endpoint"] == (explicit_source or "https://huggingface.co")
    assert acquire.call_args.kwargs["revision"] == manifest["revision"]
    assert acquire.call_args.kwargs["token"] is False


def test_explicit_source_failure_never_falls_back(snapshot, monkeypatch):
    model, _, _ = snapshot
    monkeypatch.setattr(settings, "model_source_url", "https://models.example.test")
    acquire = Mock(side_effect=RuntimeError("source unavailable"))
    monkeypatch.setattr("immich_ml.models.image_description.snapshot_download", acquire)
    with pytest.raises(RuntimeError, match="source unavailable"):
        model.download()
    acquire.assert_called_once()
    assert acquire.call_args.kwargs["endpoint"] == "https://models.example.test"


@pytest.mark.parametrize(
    "file", ["config.json", "tokenizer.json", "model.safetensors", "README.md", "modeling_florence.py"]
)
def test_corrupt_cache_fails_before_native_loader_or_download(snapshot, monkeypatch, file):
    model, _, contents = snapshot
    populate(model, contents)
    (model.model_path / file).write_bytes(b"modified\nsecret.example.invalid/token")
    download = Mock(side_effect=AssertionError("Cached corruption must not trigger online repair"))
    monkeypatch.setattr("immich_ml.models.image_description.snapshot_download", download)
    with pytest.raises(ModelUnavailableError, match="failed verification") as error:
        model.load()
    assert "secret.example.invalid" not in str(error.value)
    assert not model.loaded
    download.assert_not_called()


def test_partial_revision_and_symlink_are_rejected(snapshot, tmp_path):
    model, manifest, contents = snapshot
    populate(model, contents)
    (model.model_path / "tokenizer.json").unlink()
    with pytest.raises(ModelUnavailableError):
        verify_florence_snapshot(model.model_path, manifest)
    target = tmp_path / "outside-tokenizer.json"
    target.write_bytes(contents["tokenizer.json"])
    (model.model_path / "tokenizer.json").symlink_to(target)
    with pytest.raises(ModelUnavailableError):
        verify_florence_snapshot(model.model_path, manifest)


@pytest.mark.parametrize("acceleration", ["cuda", "openvino"])
def test_offline_load_uses_only_native_classes(snapshot, monkeypatch, acceleration):
    model, _, contents = snapshot
    model.acceleration = acceleration
    populate(model, contents)
    native_model, native_processor = Mock(), Mock()
    auto = Mock(side_effect=AssertionError("Built-ins must not use dynamic model factories"))
    monkeypatch.setitem(
        sys.modules,
        "transformers",
        SimpleNamespace(
            Florence2ForConditionalGeneration=SimpleNamespace(from_pretrained=native_model),
            Florence2Processor=SimpleNamespace(from_pretrained=native_processor),
            AutoModelForCausalLM=SimpleNamespace(from_pretrained=auto),
            AutoModelForImageTextToText=SimpleNamespace(from_pretrained=auto),
            AutoProcessor=SimpleNamespace(from_pretrained=auto),
        ),
    )
    monkeypatch.setattr(
        "immich_ml.models.image_description.snapshot_download",
        Mock(side_effect=AssertionError("Warm loads must remain offline")),
    )
    model.load()
    native_processor.assert_called_once_with(str(model.model_path), trust_remote_code=False, local_files_only=True)
    import torch

    native_model.assert_called_once_with(
        str(model.model_path), dtype=torch.float32, use_safetensors=True, trust_remote_code=False, local_files_only=True
    )
    assert model.loaded


def test_cached_download_verifies_without_loading(snapshot, monkeypatch):
    model, _, contents = snapshot
    populate(model, contents)
    monkeypatch.setattr(model, "_load", Mock(side_effect=AssertionError("Staging must not load")))
    model.download()
    assert not model.loaded
    (model.model_path / "tokenizer.json").write_bytes(b"corrupt")
    with pytest.raises(ModelUnavailableError, match="verification"):
        model.download()


def test_builtin_openvino_selection_keeps_all_native_tasks(snapshot, monkeypatch):
    model, _, _ = snapshot
    model.acceleration = "openvino"
    predict = Mock(return_value={"description": "caption", "visible_text": ["ocr"], "objects": ["car"]})
    monkeypatch.setattr(model, "_predict_cuda", predict)
    image = Mock()
    assert model._predict(image) == predict.return_value
    predict.assert_called_once_with(image, None, None)


def test_custom_florence_requires_worker_consent_before_download_or_load(tmp_path, monkeypatch):
    model = ImageDescriptionModel("example/Florence-2-custom", acceleration="cuda", cache_dir=tmp_path)
    monkeypatch.setattr(settings.image_description, "trusted_custom_models", [])
    with pytest.raises(ModelUnavailableError, match="TRUSTED_CUSTOM_MODELS"):
        model._download()
    with pytest.raises(ModelUnavailableError, match="TRUSTED_CUSTOM_MODELS"):
        model._load_cuda()


def test_explicitly_trusted_custom_florence_keeps_dynamic_loader(tmp_path, monkeypatch):
    name = "example/Florence-2-custom"
    model = ImageDescriptionModel(name, acceleration="cuda", device="cpu", cache_dir=tmp_path)
    monkeypatch.setattr(settings.image_description, "trusted_custom_models", [name])
    import transformers

    processor = Mock()
    causal_model = Mock()
    monkeypatch.setattr(transformers.AutoProcessor, "from_pretrained", processor)
    monkeypatch.setattr(transformers.AutoModelForCausalLM, "from_pretrained", causal_model)
    model._load_cuda()
    processor.assert_called_once_with(str(tmp_path), trust_remote_code=True, local_files_only=True)
    assert causal_model.call_args.kwargs["trust_remote_code"] is True
    assert causal_model.call_args.kwargs["local_files_only"] is True


def test_custom_consent_is_worker_setting(monkeypatch):
    name = "example/Florence-2-custom"
    monkeypatch.setenv("MACHINE_LEARNING_IMAGE_DESCRIPTION__TRUSTED_CUSTOM_MODELS", json.dumps([name]))
    assert Settings().image_description.trusted_custom_models == [name]


def test_custom_consent_never_loads_another_repositorys_cached_python(tmp_path, monkeypatch):
    import transformers
    from huggingface_hub.utils import validate_repo_id

    trusted = "reviewed/Florence-2-custom"
    attacker = "attacker/Florence.-2-custom"
    for name in [trusted, attacker]:
        validate_repo_id(name)
    monkeypatch.setattr(settings, "cache_folder", tmp_path)
    monkeypatch.setattr(settings.image_description, "trusted_custom_models", [trusted])
    legacy = tmp_path / "image-description-tagging/Florence-2-custom/cuda"
    legacy.mkdir(parents=True)
    (legacy / "config.json").write_text(json.dumps({"repository": attacker}))
    untrusted_model = ImageDescriptionModel(attacker, acceleration="cuda", device="cpu")
    trusted_model = ImageDescriptionModel(trusted, acceleration="cuda", device="cpu")
    other_owner = ImageDescriptionModel("another/Florence-2-custom", acceleration="cuda", device="cpu")
    assert len({untrusted_model.cache_dir, trusted_model.cache_dir, other_owner.cache_dir, legacy}) == 4
    assert not untrusted_model.cached
    assert not trusted_model.cached
    acquired = []

    def acquire(repo, **kwargs):
        acquired.append(repo)
        destination = kwargs["local_dir"]
        destination.mkdir(parents=True)
        (destination / "config.json").write_text(json.dumps({"repository": repo}))

    processor, causal_model = Mock(), Mock()
    monkeypatch.setattr("immich_ml.models.image_description.snapshot_download", acquire)
    monkeypatch.setattr(transformers.AutoProcessor, "from_pretrained", processor)
    monkeypatch.setattr(transformers.AutoModelForCausalLM, "from_pretrained", causal_model)
    untrusted_model.download()
    assert not trusted_model.cached
    trusted_model.load()
    assert acquired == [attacker, trusted]
    processor.assert_called_once_with(str(trusted_model.model_path), trust_remote_code=True, local_files_only=True)
    assert causal_model.call_args.args == (str(trusted_model.model_path),)
    assert json.loads((trusted_model.model_path / "config.json").read_text())["repository"] == trusted
