"""Eye scores per detected face (FL-843): eyes open and eye sharpness from 106 face landmarks.

The landmark model is InsightFace's `2d106det.onnx` from the buffalo_l pack, served by the model mirror as
`frameleaf/buffalo_l-landmarks` (`landmarks/model.onnx`, pinned by SHA-256). Each face box is cropped at 1.5x
its longer side to 192 x 192, and the model's 106 points are mapped back to the image.

`eyesOpen` is a logistic of the narrower eye's aspect ratio (lid opening over eye width), so one closed eye
reads as a blink. Its constants were fitted on 1,371 labelled faces and checked on 300 more, kept as landmark
JSON in `test-fixtures/eyes/`. `eyeSharpness` is the variance of the Laplacian of the grey eye crops, resized
to a fixed width so it does not depend on how large the face is, squashed to [0, 1].

A face turned to profile (the nose beyond an eye) gets `eyesOpen: None`; one with eye regions far darker than
the face (sunglasses) gets both scores `None`. Its landmarks there are guesses.
"""

import hashlib
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from numpy.typing import NDArray

from frameleaf_ml.config import model_source_url
from frameleaf_ml.models.base import MODEL_SOURCE_ORG, InferenceModel
from frameleaf_ml.schemas import ModelFormat, ModelTask, ModelType

LANDMARK_REPO = "buffalo_l-landmarks"
LANDMARK_SHA256 = "f001b856447c413801ef5c42091ed0cd516fcd21f2d6b79635b1e733a7109dbf"
LANDMARK_SIZE = 192
CROP_SCALE = 1.5

# The two eyes' contour and pupil points in 2d106det's markup (image left, image right), and the nose tip.
EYES = (np.arange(33, 43), np.arange(87, 97))
NOSE_TIP = 86

# eyesOpen = sigmoid(EAR_SLOPE * (aspect - EAR_MIDPOINT)), a logistic fit on the 1,371 training faces.
EAR_MIDPOINT = 0.3216
EAR_SLOPE = 70.3
# The nose this share of the eye distance or more outside the eyes' midpoint (beyond an eye): a profile face.
PROFILE_LIMIT = 0.75
# Eye regions this dark relative to the whole face: sunglasses (open eyes measure 0.59 or more at the 5th percentile).
OCCLUDED_BRIGHTNESS = 0.45
# Eye crops are resized to this width before measuring sharpness. A sharp portrait's eyes have a Laplacian
# variance near 290 (0.76) and the same face blurred by 3 px near 17 (0.08).
EYE_WIDTH = 48
SHARPNESS_SCALE = 200.0


class FaceLandmarker(InferenceModel):
    depends = []
    identity = (ModelType.DETECTION, ModelTask.FACIAL_RECOGNITION)

    def __init__(self, **model_kwargs: Any) -> None:
        super().__init__(LANDMARK_REPO, **model_kwargs, model_format=ModelFormat.ONNX)

    @property
    def model_dir(self) -> Path:
        return self.cache_dir / "landmarks"

    def _download(self) -> None:
        repo_id = f"{MODEL_SOURCE_ORG}/{LANDMARK_REPO}"
        self._download_from_source(LANDMARK_REPO, allow_patterns=["landmarks/*"])
        if not self.model_path.is_file():
            raise self._unavailable(repo_id, model_source_url(), reason="has no landmarks/model.onnx")
        if hashlib.sha256(self.model_path.read_bytes()).hexdigest() != LANDMARK_SHA256:
            self.model_path.unlink()
            raise self._unavailable(repo_id, model_source_url(), reason="failed its checksum")

    def _predict(self, image: NDArray[np.uint8], boxes: NDArray[np.float32]) -> NDArray[np.float32]:
        """106 (x, y) image points per face box."""
        crops, inverses = [], []
        for x1, y1, x2, y2 in boxes:
            scale = LANDMARK_SIZE / (max(x2 - x1, y2 - y1) * CROP_SCALE)
            half = LANDMARK_SIZE / 2
            m = np.array(
                [[scale, 0, half - scale * (x1 + x2) / 2], [0, scale, half - scale * (y1 + y2) / 2]], dtype=np.float32
            )
            crops.append(cv2.warpAffine(image, m, (LANDMARK_SIZE, LANDMARK_SIZE), borderValue=0.0))
            inverses.append(cv2.invertAffineTransform(m))
        name = self.session.get_inputs()[0].name
        # The model normalises its own input (its graph starts with Sub and Mul), so it takes raw RGB.
        points = [
            self.session.run(None, {name: crop.astype(np.float32).transpose(2, 0, 1)[None]})[0].reshape(-1, 2)
            for crop in crops
        ]
        return np.stack(
            [((p + 1) * (LANDMARK_SIZE / 2)) @ inv[:, :2].T + inv[:, 2] for p, inv in zip(points, inverses)]
        ).astype(np.float32)


def eye_aspect(eye: NDArray[np.float32]) -> float:
    """Lid opening over eye width: the contour's spread across the line through its two farthest points."""
    distances = np.linalg.norm(eye[:, None] - eye[None], axis=2)
    i, j = np.unravel_index(distances.argmax(), distances.shape)
    width = distances[i, j]
    if width <= 0:
        return 0.0
    axis = (eye[j] - eye[i]) / width
    across = (eye - eye[i]) @ np.array([-axis[1], axis[0]])
    return float((across.max() - across.min()) / width)


def eyes_open(points: NDArray[np.float32]) -> float:
    aspect = min(eye_aspect(points[eye]) for eye in EYES)
    return float(1 / (1 + np.exp(-EAR_SLOPE * (aspect - EAR_MIDPOINT))))


def is_profile(points: NDArray[np.float32]) -> bool:
    """A nose tip far outside the eyes' midpoint, along the line between them, is a turned face."""
    left, right = (points[eye].mean(0) for eye in EYES)
    span = float(np.linalg.norm(right - left))
    if span <= 0:
        return True
    axis = (right - left) / span
    return abs(float((points[NOSE_TIP] - (left + right) / 2) @ axis)) / span > PROFILE_LIMIT


def _eye_crop(grey: NDArray[Any], eye: NDArray[np.float32]) -> NDArray[Any] | None:
    x1, y1 = eye.min(0)
    x2, y2 = eye.max(0)
    pad = (x2 - x1) * 0.25
    x1, x2 = int(max(x1 - pad, 0)), int(min(x2 + pad, grey.shape[1]))
    y1, y2 = int(max(y1 - pad, 0)), int(min(y2 + pad, grey.shape[0]))
    if x2 - x1 < 2 or y2 - y1 < 2:
        return None
    crop = grey[y1:y2, x1:x2]
    height = max(1, round(crop.shape[0] * EYE_WIDTH / crop.shape[1]))
    return cv2.resize(crop, (EYE_WIDTH, height), interpolation=cv2.INTER_AREA)


def grey_image(image: NDArray[np.uint8]) -> NDArray[np.uint8]:
    return cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)  # type: ignore[return-value]


def eye_scores(
    image: NDArray[np.uint8], box: NDArray[np.float32], points: NDArray[np.float32]
) -> tuple[float | None, float | None]:
    """(eyesOpen, eyeSharpness) for one face; None where the eyes can't be seen.

    `image` is RGB or, for several faces of one photo, its `grey_image` so it is converted only once.
    """
    grey = image if image.ndim == 2 else grey_image(image)
    crops = [_eye_crop(grey, points[eye]) for eye in EYES]
    if any(crop is None for crop in crops):
        return None, None
    eyes = [crop for crop in crops if crop is not None]
    sharpness = float(np.mean([cv2.Laplacian(crop, cv2.CV_64F).var() for crop in eyes]))
    sharpness = round(1 - float(np.exp(-sharpness / SHARPNESS_SCALE)), 4)

    x1, y1, x2, y2 = (int(v) for v in box)
    face = grey[max(y1, 0) : max(y2, 0), max(x1, 0) : max(x2, 0)]
    face_brightness = float(face.mean()) if face.size else 0.0
    eye_brightness = float(np.mean([crop.mean() for crop in eyes]))
    if face_brightness > 0 and eye_brightness / face_brightness < OCCLUDED_BRIGHTNESS:
        return None, None
    if is_profile(points):
        return None, sharpness
    return round(eyes_open(points), 4), sharpness
