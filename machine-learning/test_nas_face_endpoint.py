import json
from unittest.mock import Mock

from fastapi.testclient import TestClient


def test_nas_face_endpoint_preserves_existing_app_and_never_echoes_unverified_identity(monkeypatch):
    from frameleaf_ml import main, nas_app
    from frameleaf_ml.native_runtime import native_path_allowed

    assert nas_app.app is main.app
    assert not native_path_allowed("/predict-face-bound")
    predict = Mock(side_effect=ValueError("private-model-path"))
    monkeypatch.setattr(nas_app.producer, "predict", predict)
    with TestClient(nas_app.app) as client:
        response = client.post(
            "/predict-face-bound",
            data={"binding": json.dumps({"modelKey": "unverified"})},
            files={"image": b"synthetic"},
        )
    assert response.status_code == 409
    assert response.json() == {"detail": "face_model_identity_unavailable"}
    assert "private-model-path" not in response.text


def test_nas_face_endpoint_keeps_bearer_auth_before_inference(monkeypatch):
    from frameleaf_ml import main, nas_app

    predict = Mock(side_effect=AssertionError("inference without authorization"))
    monkeypatch.setattr(nas_app.producer, "predict", predict)
    secured = main.BearerAuthMiddleware(nas_app.app, expected_token="x" * 64)
    with TestClient(secured) as client:
        response = client.post("/predict-face-bound", data={"binding": "{}"}, files={"image": b"synthetic"})
    assert response.status_code == 401
    predict.assert_not_called()
