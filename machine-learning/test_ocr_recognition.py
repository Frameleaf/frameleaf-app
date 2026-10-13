from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest
from PIL import Image

from frameleaf_ml.models.ocr.recognition import TextRecognizer
from frameleaf_ml.models.ocr.schemas import TextDetectionOutput


@pytest.mark.parametrize("raw_input", [False, True])
@pytest.mark.parametrize("read_only", [False, True])
@pytest.mark.parametrize("min_score", [0.7, 0.9, 1.0, float("nan")])
def test_recognition_preserves_shared_pixel_geometry(raw_input: bool, read_only: bool, min_score: float) -> None:
    session = Mock()
    session.get_inputs.return_value = [
        SimpleNamespace(name="input", shape=(None, 48, None, 3) if raw_input else (None, 3, 48, None))
    ]
    session.run.side_effect = lambda _, inputs: [np.zeros((len(inputs["input"]), 2, 2), dtype=np.float32)]
    recognizer = TextRecognizer("PP-OCRv5_mobile", session=session)
    recognizer.batch_size = 2
    recognizer.decoder = Mock()
    boxes = np.array(
        [
            [[3, 4], [83, 4], [83, 24], [3, 24]],
            [[5, 6], [45, 6], [45, 26], [5, 26]],
            [[7, 8], [67, 8], [67, 28], [7, 28]],
            [[9, 10], [29, 10], [29, 30], [9, 30]],
        ],
        dtype=np.float32,
    )
    # A non-contiguous detector view must remain usable by another consumer.
    storage = np.repeat(boxes, 2, axis=0)
    shared_boxes = storage[::2]
    scores = np.array([0.99, 0.8, 0.9, np.nan], dtype=np.float32)
    texts: TextDetectionOutput = {"boxes": shared_boxes, "scores": np.array([0.5, 0.6, 0.7, 0.8], dtype=np.float32)}
    if read_only:
        shared_boxes.flags.writeable = False
    image = Image.new("RGB", (101, 53), color=(20, 100, 230))
    expected_boxes = boxes.copy()
    expected_boxes[:, :, 0] /= image.width
    expected_boxes[:, :, 1] /= image.height
    valid = scores > min_score
    batches = []

    for _ in range(2):
        recognizer.decoder.decode.side_effect = [(["three", "one"], scores[[3, 1]]), (["two", "zero"], scores[[2, 0]])]
        session.run.reset_mock()
        result = recognizer._predict(image, texts, minScore=min_score)

        assert set(result) == {"box", "text", "boxScore", "textScore"}
        np.testing.assert_array_equal(result["box"], expected_boxes[valid].reshape(-1))
        np.testing.assert_array_equal(result["boxScore"], texts["scores"][valid])
        np.testing.assert_array_equal(result["textScore"], scores[valid])
        assert result["text"] == [text for text, keep in zip(["zero", "one", "two", "three"], valid) if keep]
        assert all(array.dtype == np.float32 for array in (result["box"], result["boxScore"], result["textScore"]))
        assert not np.shares_memory(result["box"], shared_boxes)
        np.testing.assert_array_equal(shared_boxes, boxes)
        np.testing.assert_array_equal(storage[1::2], boxes)
        batches.append([call.args[1]["input"].copy() for call in session.run.call_args_list])

    for first, second in zip(*batches):
        np.testing.assert_array_equal(first, second)
        assert first.dtype == (np.uint8 if raw_input else np.float32)


def test_recognition_empty_detection_needs_no_session() -> None:
    recognizer = TextRecognizer("PP-OCRv5_mobile")
    texts: TextDetectionOutput = {"boxes": np.empty(0, dtype=np.float32), "scores": np.empty(0, dtype=np.float32)}

    result = recognizer._predict(Image.new("RGB", (101, 53)), texts)

    assert result["text"] == []
    for key in ("box", "boxScore", "textScore"):
        assert result[key].shape == (0,)
        assert result[key].dtype == np.float32
