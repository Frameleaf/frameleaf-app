from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
import pytest
from PIL import Image

from frameleaf_ml.models.clip.textual import OpenClipTextualEncoder
from frameleaf_ml.models.clip.visual import OpenClipVisualEncoder
from frameleaf_ml.models.ocr.detection import TextDetector


@pytest.mark.parametrize(
    "encoder_type,property_name",
    [
        (OpenClipTextualEncoder, "model_cfg"),
        (OpenClipTextualEncoder, "tokenizer_file"),
        (OpenClipTextualEncoder, "tokenizer_cfg"),
        (OpenClipVisualEncoder, "model_cfg"),
        (OpenClipVisualEncoder, "preprocess_cfg"),
    ],
)
def test_clip_config_read_closes_stream(
    encoder_type: type[OpenClipTextualEncoder] | type[OpenClipVisualEncoder], property_name: str
) -> None:
    encoder = encoder_type("ViT-B-32__openai")
    stream = StringIO('{"label": "café"}')
    with patch.object(Path, "open", return_value=stream):
        assert getattr(encoder, property_name) == {"label": "café"}
        assert stream.closed


@pytest.mark.parametrize("resampling", [Image.Resampling.NEAREST, Image.Resampling.BILINEAR, Image.Resampling.BICUBIC])
def test_clip_transform_preserves_bicubic_embedding_calibration(resampling: Image.Resampling) -> None:
    encoder = OpenClipVisualEncoder("ViT-B-32__openai")
    encoder.size = 3
    encoder.resampling = resampling
    encoder.mean = np.array([0.1, 0.2, 0.3], dtype=np.float32)
    encoder.std = np.array([0.4, 0.5, 0.6], dtype=np.float32)
    pixels = np.arange(6 * 6 * 3, dtype=np.uint8).reshape(6, 6, 3)
    image = Image.fromarray(pixels)
    before = np.asarray(image).copy()
    expected = np.asarray(image.resize((3, 3), resample=Image.Resampling.BICUBIC), dtype=np.float32) / 255.0
    expected *= 1.0 / encoder.std
    expected -= encoder.mean / encoder.std

    result = encoder.transform(image)

    assert list(result) == ["image"]
    np.testing.assert_array_equal(result["image"], expected.transpose(2, 0, 1)[None])
    assert result["image"].dtype == np.float32
    np.testing.assert_array_equal(np.asarray(image), before)


@pytest.mark.parametrize("raw_input", [False, True])
@pytest.mark.parametrize("mode", ["RGB", "RGBA"])
def test_ocr_identity_size_skips_resize_without_changing_tensor(raw_input: bool, mode: str) -> None:
    session = Mock()
    session.get_inputs.return_value = [SimpleNamespace(shape=(None, 96, 64, 3) if raw_input else (None, 3, 96, 64))]
    detector = TextDetector("PP-OCRv5_mobile", session=session)
    image = Image.new(mode, (64, 96), color=(20, 100, 230))
    pixels = np.asarray(image.convert("RGB"))
    expected = pixels[None] if raw_input else np.empty((1, 3, 96, 64), dtype=np.float32)
    if not raw_input:
        for channel in range(3):
            np.multiply(pixels[:, :, channel], detector.scale, out=expected[0, 2 - channel])
            expected[0, 2 - channel] -= 1.0
    with patch.object(image, "resize", wraps=image.resize) as resize:
        result, content = detector._transform(image, 736)
        resize.assert_not_called()
    assert content == (96, 64)
    np.testing.assert_array_equal(result, expected)


def test_ocr_reading_order_keeps_lines_separate_for_wide_coordinates() -> None:
    detector = TextDetector("PP-OCRv5_mobile")
    boxes = np.zeros((4, 4, 2), dtype=np.float32)
    boxes[:, 0] = [[2_000_000, 0], [0, 20], [3, 0], [3, 0]]
    before = boxes.copy()
    np.testing.assert_array_equal(detector.reading_order(boxes), [2, 3, 0, 1])
    np.testing.assert_array_equal(boxes, before)
