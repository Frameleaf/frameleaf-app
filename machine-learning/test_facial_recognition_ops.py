from fractions import Fraction

import numpy as np
import pytest

from frameleaf_ml.models.facial_recognition._ops import ARCFACE_DST, align_face, umeyama


def test_face_crop_preserves_fractional_interpolation_values() -> None:
    pattern = ((np.indices((112, 112)).sum(axis=0) % 2) * 255).astype(np.uint8)
    image = np.repeat(pattern[:, :, None], 3, axis=2)
    landmarks = ARCFACE_DST + np.array([0.125, 0], dtype=np.float32)

    crop = align_face(image, landmarks)

    assert crop.dtype == np.float32
    np.testing.assert_allclose(crop[40, 40], [31.875] * 3, atol=1e-3, rtol=0)


@pytest.mark.parametrize("offset", [(0, 0), (8000, 5000)])
def test_face_alignment_matches_exact_similarity_fit(offset: tuple[int, int]) -> None:
    landmarks = np.array(
        [
            [204.32549, 100.87936],
            [247.2439, 102.92387],
            [224.07031, 128.71658],
            [202.70697, 139.07573],
            [244.81396, 141.07901],
        ],
        dtype=np.float32,
    ) + np.array(offset, dtype=np.float32)
    source = [[Fraction(float(value)) for value in point] for point in landmarks]
    target = [[Fraction(float(value)) for value in point] for point in ARCFACE_DST]
    source_mean = [sum(point[i] for point in source) / len(source) for i in range(2)]
    target_mean = [sum(point[i] for point in target) / len(target) for i in range(2)]
    centered_source = [[point[i] - source_mean[i] for i in range(2)] for point in source]
    centered_target = [[point[i] - target_mean[i] for i in range(2)] for point in target]
    denominator = sum(x * x + y * y for x, y in centered_source)
    pairs = list(zip(centered_source, centered_target, strict=True))
    a = sum(x * u + y * v for (x, y), (u, v) in pairs) / denominator
    b = sum(x * v - y * u for (x, y), (u, v) in pairs) / denominator
    expected = np.array(
        [
            [float(a), float(-b), float(target_mean[0] - a * source_mean[0] + b * source_mean[1])],
            [float(b), float(a), float(target_mean[1] - b * source_mean[0] - a * source_mean[1])],
        ],
        dtype=np.float32,
    )

    actual = umeyama(landmarks, ARCFACE_DST)

    assert actual.dtype == np.float32
    np.testing.assert_array_equal(actual, expected)
