"""A person's own CLIP model from Hugging Face.

Owner decision: besides the published models, an administrator can enter an ``org/name`` search model,
which is the one deliberate exception to models coming from the Frameleaf mirror. Only the files the
encoders load are ever fetched, without credentials: no Python, no pickled weights, no remote code.
"""

from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from huggingface_hub import HfApi, snapshot_download

from frameleaf_ml.config import log, settings
from frameleaf_ml.models.base import InferenceModel, ModelUnavailableError, _is_missing_model
from frameleaf_ml.models.constants import is_custom_clip_model
from frameleaf_ml.schemas import ModelFormat

HUGGING_FACE_URL = "https://huggingface.co"

# Same bounds as the server: pgvector cannot build an HNSW index above 2000 dimensions.
MIN_EMBEDDING_SIZE = 32
MAX_EMBEDDING_SIZE = 2000

_CONFIG_FILE = "config.json"
_PREPROCESS_FILE = "visual/preprocess_cfg.json"
_TOKENIZER_CONFIG_FILE = "textual/tokenizer_config.json"
_SETTINGS_FILES = [_CONFIG_FILE, _PREPROCESS_FILE, _TOKENIZER_CONFIG_FILE]
_MAX_SETTINGS_FILE_BYTES = 1024 * 1024

REQUIRED_FILES = [*_SETTINGS_FILES, "visual/model.onnx", "textual/model.onnx", "textual/tokenizer.json"]
# Exact paths rather than globs, so nothing else in the repository can be fetched. Large exports
# keep their tensors beside the model as raw ONNX external data.
ALLOWED_FILES = [*REQUIRED_FILES, "visual/model.onnx_data", "textual/model.onnx_data"]


def custom_cache_folder(repository: str) -> str:
    """The cache folder of a repository `is_custom_clip_model` accepted.

    That check allows only letters, digits, dots, dashes and underscores, and refuses ``..`` and ``--``,
    so the folder cannot leave its parent and two repositories cannot share one.
    """
    if not is_custom_clip_model(repository):
        raise ValueError("Not a Hugging Face model name")
    owner, name = repository.split("/")
    return f"{owner}--{name}"


def _cannot_use(repository: str, reason: str) -> ModelUnavailableError:
    message = f"The Hugging Face model '{repository}' can't be used for search: {reason}"
    log.error(message)
    return ModelUnavailableError(message)


def _hub_failure(repository: str, error: Exception) -> ModelUnavailableError:
    if _is_missing_model(error):
        message = f"We couldn't find '{repository}' on Hugging Face. Check the spelling and that the model is public."
    else:
        message = (
            f"Frameleaf couldn't reach Hugging Face to get '{repository}'. "
            "Check this server's internet connection and try again."
        )
    log.error(message, exc_info=error)
    return ModelUnavailableError(message)


def _require_files(repository: str, present: set[str]) -> None:
    missing = [name for name in REQUIRED_FILES if name not in present]
    if missing:
        raise _cannot_use(
            repository,
            f"it's missing {', '.join(missing)}. Frameleaf needs a CLIP model exported to ONNX with these files.",
        )


def _fetch(repository: str, folder: Path, files: list[str]) -> None:
    try:
        snapshot_download(
            repository,
            cache_dir=folder,
            local_dir=folder,
            endpoint=HUGGING_FACE_URL,
            # Public models only: neither a saved login nor the model source token ever goes here.
            token=False,
            allow_patterns=files,
        )
    except Exception as error:
        raise _hub_failure(repository, error) from error


def _read_settings(repository: str, path: Path, name: str) -> dict[str, Any]:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError) as error:
        raise _cannot_use(repository, f"its {name} can't be read.") from error
    if not isinstance(parsed, dict):
        raise _cannot_use(repository, f"its {name} isn't in the expected format.")
    return parsed


def _embedding_size(repository: str, folder: Path) -> int:
    """Check the settings the encoders read, and return the embedding size from the model's config."""
    config = _read_settings(repository, folder / _CONFIG_FILE, _CONFIG_FILE)
    size = config.get("embed_dim")
    if type(size) is not int or not MIN_EMBEDDING_SIZE <= size <= MAX_EMBEDDING_SIZE:
        raise _cannot_use(
            repository,
            f"its {_CONFIG_FILE} needs an embed_dim between {MIN_EMBEDDING_SIZE} and {MAX_EMBEDDING_SIZE}.",
        )
    if not isinstance(config.get("text_cfg"), dict):
        raise _cannot_use(repository, f"its {_CONFIG_FILE} is missing text_cfg.")

    preprocess = _read_settings(repository, folder / _PREPROCESS_FILE, _PREPROCESS_FILE)
    absent = [key for key in ("size", "interpolation", "mean", "std") if key not in preprocess]
    if absent:
        raise _cannot_use(repository, f"its {_PREPROCESS_FILE} is missing {', '.join(absent)}.")

    tokenizer = _read_settings(repository, folder / _TOKENIZER_CONFIG_FILE, _TOKENIZER_CONFIG_FILE)
    if "pad_token" not in tokenizer:
        raise _cannot_use(repository, f"its {_TOKENIZER_CONFIG_FILE} is missing pad_token.")
    return size


def inspect_custom_clip_model(repository: str) -> int:
    """Refuse a repository the encoders can't load and return its embedding size, without fetching its weights."""
    if not settings.model_downloads:
        raise ModelUnavailableError(
            f"This server only uses models prepared in advance, so it can't get '{repository}' from Hugging Face."
        )
    try:
        info = HfApi(endpoint=HUGGING_FACE_URL, token=False).model_info(repository, files_metadata=True, timeout=30)
    except Exception as error:
        raise _hub_failure(repository, error) from error
    sizes = {sibling.rfilename: sibling.size for sibling in info.siblings or []}
    _require_files(repository, set(sizes))
    for name in _SETTINGS_FILES:
        if (sizes[name] or 0) > _MAX_SETTINGS_FILE_BYTES:
            raise _cannot_use(repository, f"its {name} is too large to be a settings file.")
    with TemporaryDirectory() as folder:
        _fetch(repository, Path(folder), _SETTINGS_FILES)
        return _embedding_size(repository, Path(folder))


class HubClipModel(InferenceModel):
    """A CLIP encoder that may come from a person's own Hugging Face repository instead of the mirror."""

    def __init__(self, model_name: str, **model_kwargs: Any) -> None:
        self.custom_repository = model_name if is_custom_clip_model(model_name) else None
        super().__init__(model_name, **model_kwargs)

    def _download(self) -> None:
        if self.custom_repository is None:
            super()._download()
            return
        _fetch(self.custom_repository, self.cache_dir, ALLOWED_FILES)
        present = {name for name in REQUIRED_FILES if (self.cache_dir / name).is_file()}
        _require_files(self.custom_repository, present)

    @property
    def cached(self) -> bool:
        if self.custom_repository is None:
            return super().cached
        return all((self.cache_dir / name).is_file() for name in REQUIRED_FILES)

    @property
    def _cache_dir_default(self) -> Path:
        if self.custom_repository is None:
            return super()._cache_dir_default
        return settings.cache_folder / self.model_task.value / "custom" / custom_cache_folder(self.custom_repository)

    @property
    def _model_format_default(self) -> ModelFormat:
        # A person's own repository has ONNX only; never look for an accelerator-specific export.
        return ModelFormat.ONNX if self.custom_repository is not None else super()._model_format_default
