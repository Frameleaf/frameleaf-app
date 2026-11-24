"""Produce CLIP output only from the exact requested artifacts and preprocessing."""

import hashlib
import json
import math
import re
import stat
import threading
from collections import OrderedDict
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import orjson
from PIL import Image as PillowImage
from PIL import UnidentifiedImageError
from PIL.Image import Image

from .config import log, settings
from .models.base import InferenceModel, ModelUnavailableError
from .models.transforms import decode_pil
from .native_qualification import ModelBindingSpec, preprocessing_identity, verify_models
from .schemas import ModelTask, ModelType
from .sessions import private_runtime_cache


def _same_sizes(sizes: dict[Path, int]) -> bool:
    """Every file a bound model was verified with is still a plain file of the size it had."""
    for path, size in sizes.items():
        try:
            info = path.lstat()
        except OSError:
            return False
        if not stat.S_ISREG(info.st_mode) or info.st_size != size:
            return False
    return True


def _bound_models(spec: ModelBindingSpec) -> list[InferenceModel]:
    """An unloaded model for each model the binding names, with the options its entries give it."""
    from .models import from_model_type
    from .native_runtime import library_entries

    groups = library_entries(orjson.dumps(spec.entries).decode())
    options = {(entry["name"], entry["task"], entry["type"]): entry["options"] for group in groups for entry in group}
    return [
        from_model_type(item.name, item.type, item.task, **options.get((item.name, item.task, item.type), {}))
        for item in spec.models
    ]


class BoundPredictor:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._models: OrderedDict[tuple[str, str], tuple[InferenceModel, TemporaryDirectory[str]]] = OrderedDict()
        # The size of each file of a bound model when its files were hashed (`_verified_models`). Sizes only:
        # holding the models here would keep their sessions alive after `_clear`.
        self._verified: dict[tuple[str, str], dict[Path, int]] = {}

    def _verified_models(self, spec: ModelBindingSpec, cache: Path) -> list[InferenceModel]:
        """The bound model, its files hashed against the binding the first time and then checked by name and size.

        Hashing a large model's files at every request made each one read gigabytes (owner, 2026-11-23: hash once,
        then check presence and size). Files a binding needs and this cache lacks are staged from the model
        source first, when model downloads are allowed: a server whose computers do its search work has never
        downloaded the model it now needs for search text.
        """
        key = (spec.model_key, str(cache.resolve()))
        sizes = self._verified.get(key)
        if sizes is not None and _same_sizes(sizes):
            return _bound_models(spec)
        self._verified.pop(key, None)
        try:
            _, models = verify_models(spec, cache, require_staged=False)
        except (ValueError, ModelUnavailableError):
            if not (settings.model_downloads and self._stage_missing(spec)):
                raise
            _, models = verify_models(spec, cache, require_staged=False)
        self._verified[key] = {
            model.cache_dir / name: (model.cache_dir / name).lstat().st_size
            for model, item in zip(models, spec.models, strict=True)
            for name in item.artifacts
        }
        return models

    @staticmethod
    def _stage_missing(spec: ModelBindingSpec) -> bool:
        """Stage each bound model whose cache lacks a file it lists; whether any was staged."""
        from .staging import stage_model

        staged = False
        for model, item in zip(_bound_models(spec), spec.models, strict=True):
            if all((model.cache_dir / name).exists() for name in item.artifacts):
                continue
            # ponytail: staged under the predictor lock, so other bound requests wait (busy) for this download.
            log.info(f"Downloading {item.name} for bound {item.type.value} requests: its files are not in the cache")
            stage_model(model)
            staged = True
        return staged

    def _clear(self) -> None:
        directories = [directory for _, directory in self._models.values()]
        self._models.clear()  # Release sessions before removing their compiled runtime files.
        for directory in directories:
            directory.cleanup()

    def close(self) -> None:
        with self._lock:
            self._clear()

    def predict(self, raw: str, image: bytes | None, text: str | None) -> dict[str, Any]:
        # The bounded executor limits requests waiting for this model's native runtime.
        if not self._lock.acquire(timeout=300):
            from .inference_executor import InferenceBusy

            raise InferenceBusy("ml_worker_busy")
        try:
            result = None
            try:
                result = self._predict(raw, image, text)
            except UnidentifiedImageError:
                # Refused from its header, before any model was touched: one bad file keeps the warm models.
                raise ValueError("producer_input_invalid") from None
            except Exception as error:
                # Retained exception chains must release sessions before derived files are removed.
                pending: list[BaseException] = [error]
                seen: set[int] = set()
                while pending:
                    current = pending.pop()
                    if id(current) in seen:
                        continue
                    seen.add(id(current))
                    pending.extend(cause for cause in (current.__cause__, current.__context__) if cause is not None)
                    current.__traceback__ = current.__cause__ = current.__context__ = None
                self._clear()
            if result is None:
                raise ValueError("producer_identity_unavailable")
            return result
        finally:
            self._lock.release()

    def _predict(self, raw: str, image: bytes | None, text: str | None) -> dict[str, Any]:
        if len(raw.encode()) > 4 * 1024 * 1024:
            raise ValueError("producer_binding_too_large")
        spec = ModelBindingSpec.model_validate_json(raw, strict=True)
        if len(spec.models) != 1 or (image is None) == (text is None):
            raise ValueError("producer_binding_invalid")
        selected = spec.models[0]
        type_ = ModelType.VISUAL if image is not None else ModelType.TEXTUAL
        if (
            selected.task != ModelTask.SEARCH
            or selected.type != type_
            or set(spec.entries) != {"clip"}
            or not isinstance(spec.entries["clip"], dict)
            or set(spec.entries["clip"]) != {type_.value}
        ):
            raise ValueError("producer_binding_invalid")
        entry = spec.entries["clip"][type_.value]
        if (
            not isinstance(entry, dict)
            or set(entry) - {"modelName", "options"}
            or entry.get("modelName") != selected.name
        ):
            raise ValueError("producer_binding_invalid")
        options = entry.get("options", {})
        if not isinstance(options, dict) or set(options) - {"language"}:
            raise ValueError("producer_binding_invalid")
        if "language" in options and (
            type_ != ModelType.TEXTUAL
            or not isinstance(options["language"], str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,35}", options["language"])
        ):
            raise ValueError("producer_binding_invalid")
        if any(not name.isascii() or len(name) > 4096 or any(ord(c) < 32 for c in name) for name in selected.artifacts):
            raise ValueError("producer_binding_invalid")
        identity = spec.model_dump(by_alias=True, exclude={"model_key"}, mode="json")
        encoded = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        if spec.model_key != "clip:" + hashlib.sha256(encoded).hexdigest():
            raise ValueError("producer_key_invalid")
        if preprocessing_identity() != spec.preprocessing_sha256:
            raise ValueError("producer_preprocessing_changed")
        data = image if image is not None else (text or "").encode()
        if not data or len(data) > 16 * 1024 * 1024:
            raise ValueError("producer_input_invalid")
        if image is not None:
            with PillowImage.open(BytesIO(image)) as header:
                if not header.width or not header.height or header.width * header.height > 16 * 1024 * 1024:
                    raise ValueError("producer_input_invalid")
        cache = Path(settings.cache_folder)
        if cache.is_symlink():
            raise ValueError("producer_cache_invalid")
        verified = self._verified_models(spec, cache)
        key = (spec.model_key, str(cache.resolve()))
        if key not in self._models:
            # Keep the usual visual/textual pair warm, with a fixed memory bound.
            if len(self._models) >= 2:
                evicted, directory = self._models.popitem(last=False)[1]
                del evicted
                directory.cleanup()
            directory = TemporaryDirectory(prefix="frameleaf-bound-")
            self._models[key] = (verified[0], directory)
        self._models.move_to_end(key)
        model, directory = self._models[key]
        with private_runtime_cache(Path(directory.name)):
            model.load(allow_download=False)
            payload: Image | str = decode_pil(image) if image is not None else text or ""
            result: dict[str, Any] = {"clip": model.predict(payload, **options)}
        vector = orjson.loads(result["clip"])
        if (
            not isinstance(vector, list)
            or not 1 <= len(vector) <= 65_536
            or any(type(value) not in (float, int) or not math.isfinite(value) for value in vector)
        ):
            raise ValueError("producer_output_invalid")
        if isinstance(payload, Image):
            result.update(imageWidth=payload.width, imageHeight=payload.height)
        # Loaded models never borrow trust from the legacy cache or a client-supplied label: a file that changed
        # size during inference withholds the output, and the next request hashes the files again.
        sizes = self._verified.get(key)
        if sizes is None or not _same_sizes(sizes):
            self._verified.pop(key, None)
            raise ValueError("producer_artifacts_changed")
        if preprocessing_identity() != spec.preprocessing_sha256:
            raise ValueError("producer_preprocessing_changed")
        if len(orjson.dumps(result)) > 4 * 1024 * 1024:
            raise ValueError("producer_output_too_large")
        return {
            "protocolVersion": 1,
            "modelKey": spec.model_key,
            "preprocessingSha256": spec.preprocessing_sha256,
            "result": result,
        }
