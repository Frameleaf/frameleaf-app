from typing import Any, Callable
from unittest import mock

import numpy as np
import orjson
import pytest
from PIL import Image
from pytest_mock import MockerFixture

from frameleaf_ml import main
from frameleaf_ml.models.facial_recognition import detection, recognition
from frameleaf_ml.models.facial_recognition._ops import decode_scrfd, nms
from frameleaf_ml.models.transforms import letterbox
from frameleaf_ml.schemas import ModelTask, ModelType
from test_main import make_scrfd_heads


@pytest.mark.parametrize("size", [(640, 640), (320, 640), (1280, 720)])
@pytest.mark.parametrize("min_score", [0.0, 0.5, 0.9, 1.0])
def test_detection_preserves_geometry_and_model_outputs(
    size: tuple[int, int], min_score: float, stub_session: Callable[..., mock.Mock]
) -> None:
    heads = make_scrfd_heads([(10, 10, 0.9), (10, 11, 0.8), (50, 50, 0.5)])
    rng = np.random.default_rng(20261013)
    for head in heads[6:]:
        head[:] = rng.normal(size=head.shape)
        head.setflags(write=False)
    image = Image.new("RGB", size)
    _, scale = letterbox(image, 640)
    scores, boxes, landmarks = decode_scrfd(heads)
    candidates = scores >= min_score
    expected_scores = scores[candidates]
    expected_boxes = boxes[candidates] / scale
    expected_landmarks = landmarks[candidates] / scale
    keep = nms(expected_boxes, expected_scores)
    detector = detection.FaceDetector("buffalo_s", session=stub_session((1, 3, 640, 640), outputs=heads))

    actual = detector.predict(image, minScore=min_score)

    for name, expected in {
        "boxes": expected_boxes[keep].round(),
        "scores": expected_scores[keep],
        "landmarks": expected_landmarks[keep].reshape(-1, 5, 2),
    }.items():
        np.testing.assert_array_equal(actual[name], expected, strict=True)
        assert not any(np.shares_memory(actual[name], head) for head in heads)


def test_detection_only_copies_retained_landmarks(
    stub_session: Callable[..., mock.Mock], mocker: MockerFixture
) -> None:
    copied_bytes: list[int] = []

    class Landmarks(np.ndarray[Any, np.dtype[np.float32]]):
        def __getitem__(self, key: Any) -> Any:
            result = super().__getitem__(key)
            if isinstance(result, np.ndarray) and not np.shares_memory(self, result):
                copied_bytes.append(result.nbytes)
            return result

    scores = np.array([[0.8, 0.1, 0.9, 0.5]], dtype=np.float32)
    boxes = np.array([[[0, 0, 20, 20], [30, 30, 40, 40], [1, 1, 21, 21], [50, 50, 70, 70]]], dtype=np.float32)
    landmarks = np.arange(40, dtype=np.float32).reshape(1, 4, 10).view(Landmarks)
    mocker.patch.object(detection, "decode_scrfd", return_value=(scores, boxes, landmarks))
    detector = detection.FaceDetector("buffalo_s", session=stub_session((1, 3, 640, 640), outputs=[]))

    actual = detector.predict(Image.new("RGB", (320, 320)), minScore=0.5)

    np.testing.assert_array_equal(actual["landmarks"], landmarks.reshape(4, 5, 2)[[2, 3]] / 2)
    # The suppressed face's landmarks must not consume a copied/scaled buffer.
    assert copied_bytes[0] == actual["landmarks"].nbytes


@pytest.mark.asyncio
async def test_inference_passes_retained_faces_to_recognition(
    stub_session: Callable[..., mock.Mock], mocker: MockerFixture
) -> None:
    detector = detection.FaceDetector(
        "buffalo_s", session=stub_session((1, 3, 640, 640), outputs=make_scrfd_heads([(10, 10, 0.9), (10, 11, 0.8)]))
    )
    embeddings = np.arange(512, dtype=np.float32)[None]
    recognizer = recognition.FaceRecognizer(
        "buffalo_s", session=stub_session(("batch", 3, 112, 112), outputs=[embeddings])
    )
    mocker.patch.object(main.model_cache, "get", side_effect=[detector, recognizer])
    mocker.patch.object(main, "thread_pool", None)

    actual = await main.run_inference(
        Image.new("RGB", (320, 320)),
        (
            [
                {
                    "name": "buffalo_s",
                    "task": ModelTask.FACIAL_RECOGNITION,
                    "type": ModelType.DETECTION,
                    "options": {"minScore": 0.5},
                }
            ],
            [{"name": "buffalo_s", "task": ModelTask.FACIAL_RECOGNITION, "type": ModelType.RECOGNITION, "options": {}}],
        ),
    )

    assert actual["imageHeight"] == actual["imageWidth"] == 320
    faces = actual[ModelTask.FACIAL_RECOGNITION]
    assert len(faces) == 1
    assert faces[0]["boundingBox"] == {"x1": 36, "y1": 32, "x2": 52, "y2": 56}
    assert faces[0]["score"] == np.float32(0.9)
    assert orjson.loads(faces[0]["embedding"]) == embeddings[0].tolist()
