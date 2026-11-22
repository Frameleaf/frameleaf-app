"""Split a flatbed scan (FL-923): the `scan-split` task on synthetic scans with prints at known places."""

import io
import json
import math
from typing import Any

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from numpy.typing import NDArray
from PIL import Image

from frameleaf_ml.models import get_model_class
from frameleaf_ml.models.scan_split import MODEL_NAME, ScanSplitModel, detect_prints
from frameleaf_ml.schemas import ModelTask, ModelType

# (centre x, centre y, width, height, degrees)
Print = tuple[float, float, float, float, float]


def corners_of(item: Print) -> NDArray[np.float64]:
    """Top-left, top-right, bottom-right, bottom-left of a print turned about its centre."""
    cx, cy, width, height, degrees = item
    cos, sin = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
    local = [(-width / 2, -height / 2), (width / 2, -height / 2), (width / 2, height / 2), (-width / 2, height / 2)]
    return np.array([(cx + x * cos - y * sin, cy + x * sin + y * cos) for x, y in local])


def scan(size: tuple[int, int], prints: list[Print], seed: int = 7) -> Image.Image:
    """An off-white, noisy scanner background with textured prints and a soft shadow beside each."""
    width, height = size
    rng = np.random.default_rng(seed)
    canvas = np.full((height, width, 3), (244, 243, 239), dtype=np.float32)
    for index, item in enumerate(prints):
        cx, cy, print_width, print_height, degrees = item
        blocks = rng.integers(30, 200, (max(2, int(print_height) // 40), max(2, int(print_width) // 40), 3))
        texture = cv2.resize(
            blocks.astype(np.float32), (int(print_width), int(print_height)), interpolation=cv2.INTER_CUBIC
        )
        texture = np.clip(texture + (index * 5), 25, 215)
        cos, sin = math.cos(math.radians(degrees)), math.sin(math.radians(degrees))
        matrix = np.array(
            [
                [cos, -sin, cx - (print_width / 2) * cos + (print_height / 2) * sin],
                [sin, cos, cy - (print_width / 2) * sin - (print_height / 2) * cos],
            ]
        )
        cover = np.zeros((height, width), dtype=np.float32)
        cv2.fillConvexPoly(cover, np.round(corners_of(item) * 16).astype(np.int32), 1.0, cv2.LINE_AA, 4)
        # A soft shadow down and to the right of the print, as a scanner lamp leaves.
        shadow = cv2.GaussianBlur(np.roll(cover, (5, 5), axis=(0, 1)), (0, 0), 6) * 12
        canvas -= (shadow * (1 - cover))[..., None]
        warped = cv2.warpAffine(texture, matrix, (width, height), flags=cv2.INTER_LINEAR)
        canvas = canvas * (1 - cover[..., None]) + warped * cover[..., None]
    canvas += rng.normal(0, 2.0, canvas.shape)
    return Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8), mode="RGB")


def angle_of(quad: list[list[float]]) -> float:
    """Degrees the top edge (top-left to top-right) is turned from horizontal."""
    (x1, y1), (x2, y2) = quad[0], quad[1]
    return math.degrees(math.atan2(y2 - y1, x2 - x1))


def assert_matches(found: dict[str, Any], expected: Print, pixels: float = 6.0) -> None:
    assert abs(angle_of(found["quad"]) - expected[4]) <= 1.0
    distance = np.linalg.norm(np.array(found["quad"]) - corners_of(expected), axis=1)
    assert float(distance.max()) <= pixels, distance
    assert found["rotation"] == 0
    assert 0.9 <= found["confidence"] <= 1.0


FOUR: list[Print] = [
    (620, 480, 800, 560, -7),
    (1750, 470, 760, 540, 3),
    (640, 1300, 780, 520, 12),
    (1760, 1310, 560, 760, -2),
]


class TestDetectPrints:
    def test_four_prints_come_back_straight_within_a_degree(self) -> None:
        # 2,400 pixels wide: detection runs on a smaller copy and the quads are scaled back.
        found = detect_prints(scan((2400, 1800), FOUR))
        assert len(found) == 4
        # reading order: top row from the left, then the bottom row
        for item, expected in zip(found, FOUR):
            assert_matches(item, expected)

    def test_prints_close_together_stay_separate(self) -> None:
        prints: list[Print] = [(420, 400, 600, 440, 0), (1040, 400, 600, 440, 0), (730, 870, 620, 440, 1.5)]
        # 20 pixels of glass between the first two
        found = detect_prints(scan((1500, 1200), prints))
        assert len(found) == 3
        for item, expected in zip(found, prints):
            assert_matches(item, expected)

    def test_twelve_prints(self) -> None:
        angles = [-4, 2, 0, 5, -1, 3, -6, 1, 4, -2, 0, 6]
        prints: list[Print] = [
            (300 + 560 * (index % 4), 260 + 480 * (index // 4), 420, 300, angles[index]) for index in range(12)
        ]
        found = detect_prints(scan((2300, 1500), prints))
        assert len(found) == 12
        for item, expected in zip(found, prints):
            assert_matches(item, expected)

    def test_one_print_with_glass_around_it_is_one_quad(self) -> None:
        only: Print = (500, 400, 700, 500, -3)
        found = detect_prints(scan((1000, 800), [only]))
        assert len(found) == 1
        assert_matches(found[0], only)

    def test_one_print_filling_the_scan_is_nothing_to_split(self) -> None:
        assert detect_prints(scan((800, 600), [(400, 300, 900, 700, 0)])) == []

    def test_an_empty_scan_has_no_prints(self) -> None:
        assert detect_prints(scan((1200, 900), [])) == []

    def test_specks_are_ignored(self) -> None:
        only: Print = (600, 450, 500, 360, 4)
        image = scan((1200, 900), [only, (100, 100, 30, 24, 10), (1100, 820, 40, 16, -20)])
        found = detect_prints(image)
        assert len(found) == 1
        assert_matches(found[0], only)

    def test_a_print_touching_the_edge_of_the_glass_is_its_visible_part(self) -> None:
        # the left 60 pixels of the first print are off the glass
        prints: list[Print] = [(240, 400, 600, 400, 0), (1000, 420, 500, 380, 5)]
        found = detect_prints(scan((1400, 800), prints))
        assert len(found) == 2
        cut, whole = found
        assert_matches(whole, prints[1])
        expected = np.array([(0, 200), (540, 200), (540, 600), (0, 600)])
        assert float(np.linalg.norm(np.array(cut["quad"]) - expected, axis=1).max()) <= 6
        assert all(0 <= x <= 1400 and 0 <= y <= 800 for x, y in cut["quad"])
        assert cut["confidence"] < whole["confidence"]

    def test_a_tiny_image_is_not_a_scan(self) -> None:
        assert detect_prints(Image.new("RGB", (8, 8), (255, 255, 255))) == []


class TestScanSplitModel:
    def test_is_the_scan_split_task(self) -> None:
        assert get_model_class(MODEL_NAME, ModelType.VISUAL, ModelTask.SCAN_SPLIT) is ScanSplitModel

    def test_needs_no_model_file(self, tmp_path: Any) -> None:
        sut = ScanSplitModel(MODEL_NAME, cache_dir=tmp_path)
        assert sut.cached
        sut.download()
        assert len(sut.predict(scan((1000, 800), [(500, 400, 700, 500, -3)]))) == 1
        assert list(tmp_path.iterdir()) == []


def test_predict_answers_the_server_contract(deployed_app: TestClient) -> None:
    buffer = io.BytesIO()
    scan((1200, 900), [(330, 450, 460, 600, 2), (880, 450, 460, 600, -4)]).save(buffer, format="PNG")
    response = deployed_app.post(
        "/predict",
        data={"entries": json.dumps({"scan-split": {"visual": {"modelName": MODEL_NAME, "options": {}}}})},
        files={"image": ("blob", buffer.getvalue(), "application/octet-stream")},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["imageWidth"], body["imageHeight"]) == (1200, 900)
    prints = body["scan-split"]
    assert len(prints) == 2
    for item in prints:
        assert set(item) == {"quad", "rotation", "confidence"}
        assert len(item["quad"]) == 4 and all(len(point) == 2 for point in item["quad"])
    assert angle_of(prints[0]["quad"]) == pytest.approx(2, abs=1)
    assert angle_of(prints[1]["quad"]) == pytest.approx(-4, abs=1)
