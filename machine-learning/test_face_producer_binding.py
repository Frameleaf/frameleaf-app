import hashlib
import json
from io import BytesIO
from unittest.mock import Mock

import numpy as np
import pytest
from PIL import Image


def seal(value):
    identity = {key: item for key, item in value.items() if key != "modelKey"}
    return {
        **identity,
        "modelKey": "face:"
        + hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
    }


def specification():
    return seal(
        {
            "protocolVersion": 1,
            "models": [
                {"name": "buffalo_l", "task": "facial-recognition", "type": role, "artifacts": {"model.onnx": "a" * 64}}
                for role in ["detection", "recognition"]
            ],
            "entries": {
                "facial-recognition": {
                    "detection": {"modelName": "buffalo_l", "options": {"minScore": 0.7}},
                    "recognition": {"modelName": "buffalo_l"},
                }
            },
            "preprocessingSha256": "b" * 64,
        }
    )


def test_face_binding_uses_fresh_verified_models_without_mutating_batch_axes(monkeypatch, pil_image, tmp_path):
    from frameleaf_ml import face_producer_binding as module
    from frameleaf_ml.schemas import ModelType

    detector = Mock(model_type=ModelType.DETECTION)
    recognizer = Mock(model_type=ModelType.RECOGNITION)
    detector.predict.return_value = {"boxes": np.array([[1, 2, 50, 60]], dtype=np.float32)}
    faces = [
        {"boundingBox": {"x1": 1, "y1": 2, "x2": 50, "y2": 60}, "embedding": json.dumps([0.25] * 512), "score": 0.9}
    ]
    recognizer.predict.return_value = faces
    verify = Mock(return_value=(None, [detector, recognizer]))
    monkeypatch.setattr(module, "verify_models", verify)
    monkeypatch.setattr(module, "preprocessing_identity", lambda: "b" * 64)
    monkeypatch.setattr(module.settings, "cache_folder", tmp_path)
    image = BytesIO()
    pil_image.save(image, format="PNG")
    spec = specification()
    result = module.FaceBoundPredictor().predict(json.dumps(spec), image.getvalue(), None)
    assert result == {
        "protocolVersion": 1,
        "modelKey": spec["modelKey"],
        "preprocessingSha256": "b" * 64,
        "result": {"facial-recognition": faces, "imageWidth": 600, "imageHeight": 800},
    }
    assert recognizer.batch_size == 1
    detector.load.assert_called_once_with(allow_download=False)
    recognizer.load.assert_called_once_with(allow_download=False)
    assert verify.call_count == 2
    assert all(call.kwargs == {"require_staged": False} for call in verify.call_args_list)


@pytest.mark.parametrize("change", ["key", "engine", "option", "workload", "empty-image", "preprocessing"])
def test_face_binding_rejects_unapproved_requests_before_loading_models(change, monkeypatch, tmp_path):
    from frameleaf_ml import face_producer_binding as module

    value = specification()
    image = BytesIO()
    Image.new("RGB", (10, 10)).save(image, format="PNG")
    data = image.getvalue()
    if change == "key":
        value["modelKey"] = "face:" + "f" * 64
    if change == "engine":
        value["models"].pop()
    if change == "option":
        value["entries"]["facial-recognition"]["detection"]["options"]["path"] = "/untrusted"
    if change == "workload":
        value["models"][0]["task"] = "clip"
    if change == "empty-image":
        data = b""
    if change != "key":
        value = seal(value)
    monkeypatch.setattr(module, "preprocessing_identity", lambda: "c" * 64 if change == "preprocessing" else "b" * 64)
    monkeypatch.setattr(module.settings, "cache_folder", tmp_path)
    verified = Mock(side_effect=AssertionError("must not read model cache"))
    monkeypatch.setattr(module, "verify_models", verified)
    with pytest.raises(ValueError):
        module.FaceBoundPredictor().predict(json.dumps(value), data, None)
    verified.assert_not_called()


@pytest.mark.parametrize("change", ["dimension", "empty-box", "score", "vector", "extra-field"])
def test_face_output_validation_rejects_malformed_results(change):
    from frameleaf_ml.face_producer_binding import validate_face_output

    value = {
        "imageWidth": 100,
        "imageHeight": 100,
        "facial-recognition": [
            {"boundingBox": {"x1": 1, "y1": 2, "x2": 50, "y2": 60}, "embedding": json.dumps([0.25] * 512), "score": 0.9}
        ],
    }
    if change == "dimension":
        value["imageWidth"] = 0
    if change == "empty-box":
        value["facial-recognition"][0]["boundingBox"]["x2"] = 1
    if change == "score":
        value["facial-recognition"][0]["score"] = float("nan")
    if change == "vector":
        value["facial-recognition"][0]["embedding"] = json.dumps([0.25] * 511)
    if change == "extra-field":
        value["facial-recognition"][0]["path"] = "/untrusted"
    with pytest.raises(ValueError):
        validate_face_output(value)
    validate_face_output({"imageWidth": 100, "imageHeight": 100, "facial-recognition": []})


def test_batch_derivative_preserves_approved_source_model_identity(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from frameleaf_ml.models.facial_recognition import recognition as module

    class Session:
        def __init__(self, path):
            self.source_model_path = path

        def get_inputs(self):
            return [SimpleNamespace(shape=[1])]

    monkeypatch.setattr(module, "OrtSession", Session)
    original = tmp_path / "original.onnx"
    derived = tmp_path / "derived.onnx"
    recognizer = SimpleNamespace(
        model_path=original,
        batch_size=2,
        _make_session=Session,
        _add_batch_axis=lambda path: derived,
    )
    result = module.FaceRecognizer._load(recognizer)
    assert result.source_model_path == original
