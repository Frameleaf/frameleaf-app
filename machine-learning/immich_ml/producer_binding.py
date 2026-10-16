"""Produce CLIP output only from the exact requested artifacts and preprocessing."""

import hashlib
import json
import math
import re
import threading
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

import orjson
from PIL import Image as PillowImage
from PIL.Image import Image

from .config import settings
from .models.transforms import decode_pil
from .native_qualification import ModelBindingSpec, preprocessing_identity, verify_models
from .schemas import ModelTask, ModelType
from .sessions import private_runtime_cache


class BoundPredictor:
    def __init__(self) -> None:
        self._lock = threading.Lock()

    def predict(self, raw: str, image: bytes | None, text: str | None) -> dict[str, Any]:
        if not self._lock.acquire(blocking=False):
            raise ValueError("producer_busy")
        try:
            result = None
            with TemporaryDirectory(prefix="frameleaf-bound-") as temporary:
                with private_runtime_cache(Path(temporary)):
                    try:
                        result = self._predict(raw, image, text)
                    except Exception as error:
                        # Retained exception chains must release sessions before derived files are removed.
                        pending: list[BaseException] = [error]
                        seen: set[int] = set()
                        while pending:
                            current = pending.pop()
                            if id(current) in seen:
                                continue
                            seen.add(id(current))
                            pending.extend(
                                cause for cause in (current.__cause__, current.__context__) if cause is not None
                            )
                            current.__traceback__ = current.__cause__ = current.__context__ = None
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
        _, verified = verify_models(spec, cache, require_staged=False)
        # shortcut: reload verified sessions per request; cache immutable sessions after NAS measurements.
        model = verified[0]
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
        # Loaded models never borrow trust from the legacy cache or a client-supplied label.
        verify_models(spec, cache, require_staged=False)
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
