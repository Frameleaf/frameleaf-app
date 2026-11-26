"""FL-843: eyes open and eye sharpness per face, from 106 landmarks (buffalo_l-landmarks)."""

import json
import os
import time
from pathlib import Path
from typing import Any
from unittest import mock

import numpy as np
import pytest
from pydantic import ValidationError
from pytest_mock import MockerFixture

from frameleaf_ml.models.base import ModelUnavailableError
from frameleaf_ml.models.facial_recognition.landmarks import (
    EYES,
    NOSE_TIP,
    FaceLandmarker,
    eye_scores,
    eyes_open,
    is_profile,
)
from frameleaf_ml.models.facial_recognition.recognition import FaceRecognizer
from frameleaf_ml.schemas import ModelTask, ModelType, validate_options

FIXTURE = Path(__file__).parent / "test-fixtures/eyes/landmarks.json"
# A frontal face's five SCRFD points (eyes, nose, mouth corners), for the recognizer's input.
FRONTAL = np.array([[170, 230], [255, 225], [210, 265], [180, 320], [245, 315]], dtype=np.float32)


def points_for(eyes: Any, nose: tuple[float, float] = (212, 265)) -> np.ndarray:
    points = np.zeros((106, 2), dtype=np.float32)
    for index, eye in zip(EYES, eyes):
        points[index] = eye
    points[NOSE_TIP] = nose
    return points


def test_closed_eyes_precision_and_recall_on_the_labelled_fixture() -> None:
    faces = json.loads(FIXTURE.read_text())["faces"]
    assert len(faces) == 300
    closed = np.array([face["label"] == "closed" for face in faces])
    predicted = np.array([eyes_open(points_for(face["eyes"])) < 0.5 for face in faces])
    hits = (predicted & closed).sum()
    assert hits / predicted.sum() >= 0.9
    assert hits / closed.sum() >= 0.8


def open_eye(cx: float, cy: float, height: float) -> np.ndarray:
    """A 10-point eye contour 40 px wide, `height` px open."""
    angles = np.linspace(0, 2 * np.pi, 9, endpoint=False)
    contour = np.stack([cx + 20 * np.cos(angles), cy + height / 2 * np.sin(angles)], axis=1)
    return np.vstack([contour, [[cx, cy]]]).astype(np.float32)


def face_image(eye_level: int) -> np.ndarray:
    rng = np.random.default_rng(0)
    image = np.full((512, 512, 3), 160, dtype=np.uint8)
    image[200:260, 140:290] = rng.integers(60, 220, (60, 150, 3), dtype=np.uint8)  # textured eye band
    image[200:260, 140:290] = np.minimum(image[200:260, 140:290], eye_level)
    return image


def test_open_and_closed_eyes_score_apart() -> None:
    image, box = face_image(255), np.array([130, 110, 320, 370], dtype=np.float32)
    wide = points_for([open_eye(170, 230, 16), open_eye(255, 225, 16)])
    shut = points_for([open_eye(170, 230, 2), open_eye(255, 225, 2)])
    blink = points_for([open_eye(170, 230, 16), open_eye(255, 225, 2)])
    assert eye_scores(image, box, wide)[0] > 0.9
    assert eye_scores(image, box, shut)[0] < 0.1
    assert eye_scores(image, box, blink)[0] < 0.1  # one closed eye is a blink
    sharpness = eye_scores(image, box, wide)[1]
    assert sharpness is not None and 0 < sharpness <= 1


def test_profile_faces_have_no_eyes_open_score() -> None:
    eyes = [open_eye(170, 230, 16), open_eye(255, 225, 16)]
    frontal, profile = points_for(eyes), points_for(eyes, nose=(320, 265))  # nose beyond the far eye
    assert is_profile(profile) and not is_profile(frontal)
    image, box = face_image(255), np.array([130, 110, 320, 370], dtype=np.float32)
    assert eye_scores(image, box, profile) == (None, eye_scores(image, box, frontal)[1])


def test_sunglasses_have_no_eye_scores() -> None:
    image, box = face_image(30), np.array([130, 110, 320, 370], dtype=np.float32)
    points = points_for([open_eye(170, 230, 16), open_eye(255, 225, 16)])
    assert eye_scores(image, box, points) == (None, None)


def test_options_accept_eye_scores_and_still_refuse_unknown_keys() -> None:
    task, kind = ModelTask.FACIAL_RECOGNITION, ModelType.RECOGNITION
    assert validate_options(task, kind, {"eyeScores": True}) == {"eyeScores": True}
    assert validate_options(task, kind, {}) == {}
    with pytest.raises(ValidationError):
        validate_options(task, kind, {"eyeScore": True})


def recognizer(mocker: MockerFixture) -> FaceRecognizer:
    mocker.patch.object(FaceRecognizer, "load")
    mocker.patch(
        "frameleaf_ml.models.facial_recognition.recognition.ort.get_available_providers",
        return_value=["CPUExecutionProvider"],
    )
    model = FaceRecognizer("buffalo_l", cache_dir="test_cache/buffalo_l")
    session = mock.Mock()
    session.get_inputs.return_value = [mock.Mock(name="input.1", shape=("batch", 3, 112, 112))]
    session.run.return_value = [np.ones((1, 512), dtype=np.float32)]
    model.session = session
    return model


FACES = {
    "boxes": np.array([[130, 110, 320, 370]], dtype=np.float32),
    "landmarks": FRONTAL[None],
    "scores": np.array([0.9], dtype=np.float32),
}


def test_faces_are_unchanged_without_eye_scores(mocker: MockerFixture) -> None:
    landmarker = mocker.patch.object(FaceLandmarker, "predict")
    faces = recognizer(mocker).predict(face_image(255), FACES)
    assert set(faces[0]) == {"boundingBox", "embedding", "score"}
    landmarker.assert_not_called()


def test_eye_scores_are_added_when_asked(mocker: MockerFixture) -> None:
    points = points_for([open_eye(170, 230, 16), open_eye(255, 225, 16)])
    mocker.patch.object(FaceLandmarker, "predict", return_value=points[None])
    faces = recognizer(mocker).predict(face_image(255), FACES, eyeScores=True)
    assert set(faces[0]) == {"boundingBox", "embedding", "score", "eyesOpen", "eyeSharpness"}
    assert faces[0]["eyesOpen"] > 0.9


def test_missing_landmark_model_keeps_the_faces(mocker: MockerFixture) -> None:
    mocker.patch.object(FaceLandmarker, "predict", side_effect=ModelUnavailableError("gone"))
    faces = recognizer(mocker).predict(face_image(255), FACES, eyeScores=True)
    assert set(faces[0]) == {"boundingBox", "embedding", "score"}


MODEL = os.environ.get("FRAMELEAF_LANDMARK_MODEL")


@pytest.mark.skipif(not MODEL, reason="set FRAMELEAF_LANDMARK_MODEL to buffalo_l-landmarks/landmarks/model.onnx")
def test_landmarks_add_under_15_ms_per_face_on_cpu(tmp_path: Path) -> None:
    from frameleaf_ml.sessions.ort import OrtSession

    model = FaceLandmarker(cache_dir=tmp_path)
    model.session = OrtSession(Path(str(MODEL)), providers=["CPUExecutionProvider"])
    model.loaded = True
    image = face_image(255)
    boxes = np.repeat(FACES["boxes"], 20, axis=0)
    model.predict(image, boxes[:1])  # warm up
    started = time.perf_counter()
    points = model.predict(image, boxes)
    elapsed = (time.perf_counter() - started) / len(boxes)
    assert points.shape == (20, 106, 2)
    assert elapsed < 0.015


def png(image: np.ndarray) -> bytes:
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.fromarray(image).save(buffer, format="PNG")
    return buffer.getvalue()


def test_eye_scores_for_stored_boxes(deployed_app: Any, mocker: MockerFixture) -> None:
    points = points_for([open_eye(170, 230, 16), open_eye(255, 225, 16)])
    predict = mocker.patch.object(FaceLandmarker, "predict", return_value=points[None])
    response = deployed_app.post(
        "/face-eye-scores",
        files={"image": ("face.png", png(face_image(255)), "image/png")},
        data={"boxes": "[[130, 110, 320, 370]]"},
    )
    assert response.status_code == 200
    faces = response.json()["faces"]
    assert len(faces) == 1 and faces[0]["eyesOpen"] > 0.9 and faces[0]["eyeSharpness"] > 0
    assert predict.call_args.args[1].tolist() == [[130, 110, 320, 370]]


@pytest.mark.parametrize(
    "boxes",
    ["nope", "[]", "[[1, 2, 3]]", "[[5, 5, 1, 1]]", '[[0, 0, "a", 4]]', "[[0, 0, 1e300, 4]]", "[[1, 1, 1.0000001, 4]]"],
)
def test_eye_scores_refuse_bad_boxes(deployed_app: Any, boxes: str) -> None:
    response = deployed_app.post(
        "/face-eye-scores", files={"image": ("face.png", png(face_image(255)), "image/png")}, data={"boxes": boxes}
    )
    assert response.status_code == 422


def test_eye_scores_without_the_landmark_model_are_unavailable(deployed_app: Any, mocker: MockerFixture) -> None:
    mocker.patch.object(FaceLandmarker, "predict", side_effect=ModelUnavailableError("gone"))
    response = deployed_app.post(
        "/face-eye-scores",
        files={"image": ("face.png", png(face_image(255)), "image/png")},
        data={"boxes": "[[130, 110, 320, 370]]"},
    )
    assert response.status_code == 503
