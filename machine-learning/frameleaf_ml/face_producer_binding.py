"""Produce faces from exact approved weights without borrowing the legacy warm cache."""

import hashlib
import json
import math
from collections import OrderedDict
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, cast

import orjson
from PIL import Image as PillowImage

from .config import settings
from .models.base import InferenceModel
from .models.facial_recognition.recognition import FaceRecognizer
from .models.transforms import decode_pil
from .native_qualification import ModelBindingSpec, preprocessing_identity, verify_models
from .producer_binding import BoundPredictor
from .schemas import ModelTask, ModelType, ORJSONResponse
from .sessions import private_runtime_cache


class FaceBoundPredictor(BoundPredictor):
    def __init__(self) -> None:
        super().__init__()
        self._faces: OrderedDict[tuple[str, str], tuple[InferenceModel, FaceRecognizer, TemporaryDirectory[str]]] = (
            OrderedDict()
        )

    def _clear(self) -> None:
        directories = [directory for _, _, directory in self._faces.values()]
        self._faces.clear()  # Release sessions before removing their compiled runtime files.
        for directory in directories:
            directory.cleanup()
        super()._clear()

    def _predict(self, raw: str, image: bytes | None, text: str | None) -> dict[str, Any]:
        if len(raw.encode()) > 4 * 1024 * 1024 or text is not None or not image or len(image) > 16 * 1024 * 1024:
            raise ValueError("face_binding_input_invalid")
        spec = ModelBindingSpec.model_validate_json(raw, strict=True)
        if (
            len(spec.models) != 2
            or {item.type for item in spec.models} != {ModelType.DETECTION, ModelType.RECOGNITION}
            or any(
                item.task != ModelTask.FACIAL_RECOGNITION or item.name != spec.models[0].name for item in spec.models
            )
        ):
            raise ValueError("face_binding_invalid")
        name = spec.models[0].name
        group = spec.entries.get("facial-recognition")
        if (
            not isinstance(group, dict)
            or set(spec.entries) != {"facial-recognition"}
            or set(group) != {"detection", "recognition"}
        ):
            raise ValueError("face_binding_invalid")
        detection, recognition = group["detection"], group["recognition"]
        if (
            not isinstance(detection, dict)
            or set(detection) != {"modelName", "options"}
            or detection["modelName"] != name
            or not isinstance(recognition, dict)
            or recognition != {"modelName": name}
        ):
            raise ValueError("face_binding_invalid")
        options = detection["options"]
        score = options.get("minScore") if isinstance(options, dict) else None
        if (
            not isinstance(options, dict)
            or set(options) != {"minScore"}
            or not isinstance(score, (float, int))
            or isinstance(score, bool)
            or not math.isfinite(score)
            or not 0.1 <= score <= 1
        ):
            raise ValueError("face_binding_invalid")
        identity = spec.model_dump(by_alias=True, exclude={"model_key"}, mode="json")
        expected = (
            "face:"
            + hashlib.sha256(
                json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
        )
        if spec.model_key != expected or preprocessing_identity() != spec.preprocessing_sha256:
            raise ValueError("face_binding_identity_changed")
        with PillowImage.open(BytesIO(image)) as header:
            if not header.width or not header.height or header.width * header.height > 16 * 1024 * 1024:
                raise ValueError("face_binding_input_invalid")
        cache = Path(settings.cache_folder)
        if cache.is_symlink():
            raise ValueError("face_binding_cache_invalid")
        _, models = verify_models(spec, cache, require_staged=False)
        key = (spec.model_key, str(cache.resolve()))
        if key not in self._faces:
            # Keep one verified detector/recognizer pair warm, with a fixed memory bound.
            if self._faces:
                evicted = self._faces.popitem(last=False)[1][2]
                evicted.cleanup()
            selected = {model.model_type: model for model in models}
            recognizer = cast(FaceRecognizer, selected[ModelType.RECOGNITION])
            # A single-item batch avoids the legacy loader rewriting the approved ONNX batch axis.
            recognizer.batch_size = 1
            directory = TemporaryDirectory(prefix="frameleaf-bound-face-")
            self._faces[key] = (selected[ModelType.DETECTION], recognizer, directory)
        self._faces.move_to_end(key)
        detector, recognizer, directory = self._faces[key]
        with private_runtime_cache(Path(directory.name)):
            detector.load(allow_download=False)
            recognizer.load(allow_download=False)
            payload = decode_pil(image)
            faces = recognizer.predict(payload, detector.predict(payload, minScore=score))
        result = {"facial-recognition": faces, "imageWidth": payload.width, "imageHeight": payload.height}
        encoded = ORJSONResponse(result).body
        if len(encoded) > 4 * 1024 * 1024:
            raise ValueError("face_binding_output_too_large")
        value = orjson.loads(encoded)
        validate_face_output(value)
        verify_models(spec, cache, require_staged=False)
        if preprocessing_identity() != spec.preprocessing_sha256:
            raise ValueError("face_binding_identity_changed")
        return {
            "protocolVersion": 1,
            "modelKey": spec.model_key,
            "preprocessingSha256": spec.preprocessing_sha256,
            "result": value,
        }


def validate_face_output(value: Any) -> None:
    if not isinstance(value, dict) or set(value) != {"facial-recognition", "imageWidth", "imageHeight"}:
        raise ValueError("face_binding_output_invalid")
    width, height = value["imageWidth"], value["imageHeight"]
    if (
        type(width) is not int
        or type(height) is not int
        or not 0 < width <= 65536
        or not 0 < height <= 65536
        or width * height > 16 * 1024 * 1024
    ):
        raise ValueError("face_binding_output_invalid")
    faces = value["facial-recognition"]
    if not isinstance(faces, list) or len(faces) > 4096:
        raise ValueError("face_binding_output_invalid")
    for face in faces:
        if not isinstance(face, dict) or set(face) != {"boundingBox", "embedding", "score"}:
            raise ValueError("face_binding_output_invalid")
        box, score = face["boundingBox"], face["score"]
        if (
            not isinstance(box, dict)
            or set(box) != {"x1", "x2", "y1", "y2"}
            or any(type(n) not in (float, int) or not math.isfinite(n) for n in box.values())
            or not -width <= box["x1"] < box["x2"] <= width * 2
            or not -height <= box["y1"] < box["y2"] <= height * 2
            or type(score) not in (float, int)
            or not math.isfinite(score)
            or not 0 <= score <= 1
            or not isinstance(face["embedding"], str)
            or len(face["embedding"]) > 65536
        ):
            raise ValueError("face_binding_output_invalid")
        vector = orjson.loads(face["embedding"])
        if (
            not isinstance(vector, list)
            or len(vector) != 512
            or any(type(n) not in (float, int) or not math.isfinite(n) for n in vector)
        ):
            raise ValueError("face_binding_output_invalid")
