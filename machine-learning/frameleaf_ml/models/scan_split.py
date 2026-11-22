"""Split a flatbed scan (FL-923): find the separate prints lying on a white scanner background.

Plain OpenCV, no weights and nothing to download. The scan is shrunk to at most `DETECT_EDGE` pixels a
side, everything that differs from the background colour (read from the rim of the scan) becomes a
region, and each region large enough to be a print is answered as its fitted rotated rectangle:

    [{"quad": [[x, y] * 4], "rotation": 0, "confidence": 0.97}, ...]

`quad` is in the pixels of the image that was sent, corners in the order top-left, top-right,
bottom-right, bottom-left of the print as it lies on the glass (the reading with the smallest turn, so a
print turned by more than 45 degrees is read as the neighbouring quarter turn). Prints come back in
reading order: rows from the top, each row from the left.

What it decides:
- A scan with no background on its rim (one print filling the whole scan, or a photo that is not a
  scan) answers `[]`: there is nothing to split. One print with background around it answers one quad.
- A print touching the edge of the glass is cut where the scan ends; its quad is the visible part,
  clamped to the image, with a lower confidence.
- Specks smaller than `MIN_AREA_FRACTION` of the scan are ignored, and at most `MAX_PRINTS` come back.

ponytail: `rotation` is always 0. Telling which way up a print is needs a model (faces, text, sky);
nothing cheap is reliable, so the person turns the print in the review sheet.
ponytail: prints that overlap or touch come back as one region, and a print whose own edge is as white
as the scanner lid loses that edge. The review sheet lets the person move the corners.
"""

from __future__ import annotations

from typing import Any, cast

import cv2
import numpy as np
from numpy.typing import NDArray
from PIL import Image

from frameleaf_ml.models.base import InferenceModel
from frameleaf_ml.schemas import ModelFormat, ModelSession, ModelTask, ModelType

MODEL_NAME = "frameleaf-scan-split"

# Detection runs on a copy at most this long; quads are scaled back to the image that was sent.
DETECT_EDGE = 1600
# A region smaller than this share of the scan is dust, not a print (a 12-print scan has prints of ~4%).
MIN_AREA_FRACTION = 0.004
# A region covering this much of the scan is the scan itself.
MAX_AREA_FRACTION = 0.95
MAX_PRINTS = 24
# How far (0..255, largest channel difference) a pixel must be from the background colour to count as a
# print. Above scanner noise and the soft shadow beside a print, below any printed tone.
MIN_DIFFERENCE = 22
MAX_DIFFERENCE = 60
# The rim that must be mostly background for the image to be a scan with prints on it.
RIM_FRACTION = 0.02
MIN_RIM_BACKGROUND = 0.5

Pixels = NDArray[np.uint8]


def order_corners(points: NDArray[np.float32]) -> NDArray[np.float32]:
    """Four corners as top-left, top-right, bottom-right, bottom-left (for a turn of less than 45 degrees)."""
    total = points.sum(axis=1)
    across = points[:, 0] - points[:, 1]
    return np.stack(
        [points[np.argmin(total)], points[np.argmax(across)], points[np.argmax(total)], points[np.argmin(across)]]
    )


def detect_prints(image: Image.Image) -> list[dict[str, Any]]:
    width, height = image.size
    if width < 16 or height < 16:
        return []
    scale = min(1.0, DETECT_EDGE / max(width, height))
    small_size = (max(1, round(width * scale)), max(1, round(height * scale)))
    small = image if scale == 1.0 else image.resize(small_size, Image.Resampling.BILINEAR)
    pixels: Pixels = np.asarray(small.convert("RGB"), dtype=np.uint8)
    small_height, small_width = pixels.shape[:2]
    blurred = cv2.GaussianBlur(pixels, (5, 5), 0)

    rim = max(2, round(min(small_width, small_height) * RIM_FRACTION))
    border = np.concatenate(
        [
            blurred[:rim].reshape(-1, 3),
            blurred[-rim:].reshape(-1, 3),
            blurred[rim:-rim, :rim].reshape(-1, 3),
            blurred[rim:-rim, -rim:].reshape(-1, 3),
        ]
    )
    background = np.median(border, axis=0)
    rim_difference = np.abs(border.astype(np.int16) - background).max(axis=1)
    if float((rim_difference < MIN_DIFFERENCE).mean()) < MIN_RIM_BACKGROUND:
        # No background around the picture: one print fills the scan, or this is not a scan.
        return []

    difference = np.abs(blurred.astype(np.int16) - background).max(axis=2).astype(np.uint8)
    otsu, _ = cv2.threshold(difference, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Otsu sits between background and print tones; half of it keeps pale prints, the bounds keep noise
    # and shadows out when the scan is empty or very dark.
    threshold = float(np.clip(otsu / 2, MIN_DIFFERENCE, MAX_DIFFERENCE))
    mask = (difference > threshold).astype(np.uint8) * 255
    # Fill each region (pale areas inside a print), then drop hairs and thin bridges between prints.
    outlines, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(mask)
    cv2.drawContours(filled, outlines, -1, 255, thickness=cv2.FILLED)
    filled = cv2.morphologyEx(filled, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)))
    contours, _ = cv2.findContours(filled, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)

    scan_area = float(small_width * small_height)
    prints: list[tuple[float, dict[str, Any]]] = []
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area < scan_area * MIN_AREA_FRACTION or area > scan_area * MAX_AREA_FRACTION:
            continue
        (_, (rect_width, rect_height), _) = rect = cv2.minAreaRect(cv2.convexHull(contour))
        if rect_width < 8 or rect_height < 8:
            continue
        # A contour runs through pixel centres; the print's edge is half a pixel further out.
        rect = (rect[0], (rect_width + 1, rect_height + 1), rect[2])
        corners = order_corners(cv2.boxPoints(rect).astype(np.float32))
        x, y, box_width, box_height = cv2.boundingRect(contour)
        at_edge = x <= 1 or y <= 1 or x + box_width >= small_width - 1 or y + box_height >= small_height - 1
        # How much of its rectangle the region fills: 1 for a clean print, less for a torn or merged one.
        confidence = min(1.0, area / max(1.0, rect_width * rect_height)) * (0.8 if at_edge else 1.0)
        # +0.5 turns pixel-centre coordinates into the continuous ones the scale applies to.
        quad = (corners + 0.5) / scale
        quad[:, 0] = np.clip(quad[:, 0], 0, width)
        quad[:, 1] = np.clip(quad[:, 1], 0, height)
        prints.append(
            (
                area,
                {
                    "quad": [[round(float(px), 1), round(float(py), 1)] for px, py in quad],
                    "rotation": 0,
                    "confidence": round(float(confidence), 3),
                },
            )
        )

    kept = [item for _, item in sorted(prints, key=lambda entry: entry[0], reverse=True)[:MAX_PRINTS]]
    return reading_order(kept)


def reading_order(prints: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rows from the top, each from the left; a print belongs to a row when its centre is inside the row's height."""

    def centre(item: dict[str, Any]) -> tuple[float, float]:
        quad = item["quad"]
        return sum(point[0] for point in quad) / 4, sum(point[1] for point in quad) / 4

    def extent(item: dict[str, Any]) -> tuple[float, float]:
        ys = [point[1] for point in item["quad"]]
        return min(ys), max(ys)

    rows: list[list[dict[str, Any]]] = []
    for item in sorted(prints, key=lambda entry: centre(entry)[1]):
        top, bottom = extent(rows[-1][0]) if rows else (0.0, -1.0)
        if rows and top <= centre(item)[1] <= bottom:
            rows[-1].append(item)
        else:
            rows.append([item])
    return [item for row in rows for item in sorted(row, key=lambda entry: centre(entry)[0])]


class ScanSplitModel(InferenceModel):
    """The `scan-split` task. There is no model file: it is always "cached" and loading does nothing."""

    depends = []
    identity = (ModelType.VISUAL, ModelTask.SCAN_SPLIT)

    def __init__(self, model_name: str, **model_kwargs: Any) -> None:
        super().__init__(model_name, **model_kwargs, model_format=ModelFormat.ONNX)

    def download(self) -> None:
        pass

    @property
    def cached(self) -> bool:
        return True

    def _load(self) -> ModelSession:
        return cast(ModelSession, object())

    def _predict(self, image: Image.Image, **kwargs: Any) -> list[dict[str, Any]]:
        return detect_prints(image)
