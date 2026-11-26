"""Photo repair for old prints (FL-933): scratches and dust only. No pixel of a face is generated.

One decoded RGB frame in, one RGB frame of exactly the same size out.

1. Faces are found with RetinaFace on a copy of at most ``DETECT_LONG_EDGE`` pixels, at a low
   confidence on purpose: a false face only leaves a mark unrepaired.
2. Thin, isolated marks on flat areas are masked. The boxes around faces are then cleared from
   the mask, so those pixels are byte-identical to the scan.
3. LaMa fills the masked pixels in 512-pixel windows. Every other pixel is copied from the source,
   so the result cannot drift in tone or sharpness. A mask over ``MASK_CAP`` skips the pass.

The detector network comes from the pinned facexlib checkout (``--runtime-root``); the weights are
local files the worker has already hashed. Nothing here reaches the network.
"""

import argparse
import json
import os
import sys
import tempfile
import types
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image

FRAME = "00000001.png"
REPORT = "report.json"
MAX_INPUT_EDGE = 8192

# --- scratch and dust: a missed scratch is better than a removed detail -------------------
TILE = 512  # LaMa's fixed input
HALO = 64  # context kept around the part of a window that is written back
CORE = TILE - 2 * HALO
MASK_WORK_EDGE = 2048  # the detector runs on a copy this long at most
MASK_KERNEL = 9  # defects wider than this (at the working size) are not found
MASK_THRESHOLD = 48  # top-hat / black-hat response, of 255
SPECK_AREA = 40  # dust: a compact component up to this many working pixels
LINE_MIN_LENGTH = 30  # a scratch: at least this long ...
LINE_MAX_THICKNESS = 3.5  # ... no thicker than this on average ...
LINE_MIN_ELONGATION = 6.0  # ... much longer than wide ...
LINE_MIN_FILL = 0.4  # ... and filling its rotated box, which a curved pen stroke does not
AXIS_TOLERANCE_DEGREES = 2.0  # a line this close to level or plumb is a mount rule or a print edge
NEIGHBOUR_WINDOW = 65
MAX_NEIGHBOURS = 3  # more marks than this around one: lace, beads, hair, grass or writing
FLAT_WINDOW = 21
FLAT_MAX_DEVIATION = 7.0  # a mark is only damage when the picture around it is smooth
EDGE_WINDOW = 15
EDGE_MAX = 40.0  # Sobel magnitude of the smoothed picture near the mark
NOISE_WINDOW = 31
MIN_CONTRAST_TO_NOISE = 6.0  # the mark's peak against the grain around it
MASK_CAP = 0.03  # never fill more than this fraction of a photo
FACE_MARGIN = 0.3  # faces are protected this far (of the face box) beyond their detected box

# --- faces: found only to be left alone ----------------------------------------------------
DETECT_LONG_EDGE = 1536
DETECT_CONFIDENCE = 0.5

Fill = Callable[[np.ndarray, np.ndarray], np.ndarray]
Detect = Callable[[np.ndarray], np.ndarray]
Box = tuple[int, int, int, int]


@dataclass
class Report:
    facesProtected: int = 0
    scratchPass: str = "none"  # none | applied | skipped-over-cap
    scratchMaskFraction: float = 0.0
    scratchTiles: int = 0
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------------------
# Scratch and dust mask.
# ---------------------------------------------------------------------------------------

# ponytail: a classical detector — morphological top-hat and black-hat, a threshold, then rules
# that keep only isolated specks and straight hairlines on smooth areas. Its ceiling: it misses
# wide tears, creases, stains, low-contrast scratches and any mark over busy detail, by design.
# The upgrade is the learned scratch-detection UNet from "Bringing Old Photos Back to Life"
# (MIT): same mask contract, so only this function changes.


def protected_boxes(faces: list[Box], height: int, width: int) -> list[Box]:
    """The detected face boxes grown by ``FACE_MARGIN``, clipped to the photo."""
    boxes = []
    for left, top, right, bottom in faces:
        margin_x, margin_y = (right - left) * FACE_MARGIN, (bottom - top) * FACE_MARGIN
        boxes.append(
            (
                max(0, int(left - margin_x)),
                max(0, int(top - margin_y)),
                min(width, int(right + margin_x) + 1),
                min(height, int(bottom + margin_y) + 1),
            )
        )
    return boxes


def straight_lines(labels: np.ndarray, stats: np.ndarray, candidates: np.ndarray) -> np.ndarray:
    """Which of the candidate components are straight, thin and not a level or plumb rule."""
    keep = np.zeros(len(stats), dtype=bool)
    for index in np.flatnonzero(candidates):
        left, top, width, height = stats[index, :4]
        points = np.argwhere(labels[top : top + height, left : left + width] == index)[:, ::-1]
        (_, (side_a, side_b), angle) = cv2.minAreaRect(points.astype(np.float32))
        long_side, short_side = max(side_a, side_b) + 1.0, min(side_a, side_b) + 1.0
        if long_side / short_side < LINE_MIN_ELONGATION or len(points) / (long_side * short_side) < LINE_MIN_FILL:
            continue
        off_axis = min(angle % 90.0, 90.0 - angle % 90.0)
        if off_axis <= AXIS_TOLERANCE_DEGREES:
            continue
        keep[index] = True
    return keep


def scratch_mask(rgb: np.ndarray, faces: list[Box]) -> np.ndarray:
    """A uint8 mask (255 where a defect is filled) at the photo's size. Never set inside a face."""
    height, width = rgb.shape[:2]
    scale = min(1.0, MASK_WORK_EDGE / max(height, width))
    small = rgb
    if scale < 1.0:
        small = cv2.resize(rgb, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (MASK_KERNEL, MASK_KERNEL))
    response = np.maximum(
        cv2.morphologyEx(gray, cv2.MORPH_TOPHAT, kernel), cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, kernel)
    )
    candidates = (response >= MASK_THRESHOLD).astype(np.uint8)

    count, labels, stats, centroids = cv2.connectedComponentsWithStats(candidates, connectivity=8)
    keep = np.zeros(count, dtype=bool)
    if count > 1:
        area = stats[:, cv2.CC_STAT_AREA].astype(np.float32)
        length = np.hypot(stats[:, cv2.CC_STAT_WIDTH], stats[:, cv2.CC_STAT_HEIGHT]).astype(np.float32)

        def component_mean(values: np.ndarray) -> np.ndarray:
            return np.bincount(labels.ravel(), weights=values.ravel(), minlength=count) / np.maximum(area, 1.0)

        # Lace, hair, grass, writing and jewellery are many marks close together. Counted by
        # component, so one long scratch is not its own crowd.
        centres = np.nan_to_num(centroids).round().astype(int)
        rows, columns = centres[:, 1], centres[:, 0]
        seeds = np.zeros(gray.shape, np.float32)
        np.add.at(seeds, (rows[1:], columns[1:]), 1.0)
        window = (NEIGHBOUR_WINDOW, NEIGHBOUR_WINDOW)
        crowded = cv2.boxFilter(seeds, -1, window, normalize=False)[rows, columns] - 1.0 > MAX_NEIGHBOURS
        crowded[0] = False
        # The ends of a row of beads have few neighbours of their own but sit beside a crowd.
        crowd_seeds = np.zeros(gray.shape, np.float32)
        crowd_seeds[rows[crowded], columns[crowded]] = 1.0
        beside_crowd = cv2.boxFilter(crowd_seeds, -1, window, normalize=False)[rows, columns] > 0
        # The median removes thin marks, so what still varies around one is the picture itself.
        base = cv2.medianBlur(gray, MASK_KERNEL + 2).astype(np.float32)
        mean = cv2.blur(base, (FLAT_WINDOW, FLAT_WINDOW))
        deviation = np.sqrt(np.maximum(cv2.blur(base * base, (FLAT_WINDOW, FLAT_WINDOW)) - mean * mean, 0))
        # A card edge, a fold in cloth or a watch chain has a real edge beside it; dust does not.
        smooth = cv2.GaussianBlur(base, (0, 0), 1.5)
        edges = cv2.magnitude(cv2.Sobel(smooth, cv2.CV_32F, 1, 0), cv2.Sobel(smooth, cv2.CV_32F, 0, 1))
        near_edge = cv2.dilate(edges, np.ones((EDGE_WINDOW, EDGE_WINDOW), np.uint8))
        # Paper grain is many weak marks: a real one stands well clear of the noise around it.
        residual = (gray.astype(np.float32) - base) * (candidates == 0)  # the marks themselves are not noise
        noise = np.sqrt(cv2.blur(residual * residual, (NOISE_WINDOW, NOISE_WINDOW)))
        peak = np.zeros(count, np.float32)
        np.maximum.at(peak, labels.ravel(), response.ravel().astype(np.float32))
        plausible = (
            ~beside_crowd
            & (component_mean(deviation) <= FLAT_MAX_DEVIATION)
            & (component_mean(near_edge) <= EDGE_MAX)
            & (peak / (component_mean(noise) + 1.0) >= MIN_CONTRAST_TO_NOISE)
        )
        plausible[0] = False

        speck = plausible & (area <= SPECK_AREA)
        thin = plausible & (length >= LINE_MIN_LENGTH) & (area / np.maximum(length, 1.0) <= LINE_MAX_THICKNESS)
        keep = speck | straight_lines(labels, stats, thin & ~speck)
    mask = keep[labels].astype(np.uint8) * 255
    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8))
    if scale < 1.0:
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
        grow = int(np.ceil(1.0 / scale))
        mask = cv2.dilate(mask, np.ones((grow, grow), np.uint8))
    # Last, after every dilation: nothing inside a protected box is ever filled.
    for left, top, right, bottom in protected_boxes(faces, height, width):
        mask[top:bottom, left:right] = 0
    return mask


def inpaint_tiled(rgb: np.ndarray, mask: np.ndarray, fill: Fill) -> tuple[np.ndarray, int]:
    """Fill the masked pixels window by window. Every window is read from the source photo and
    only the masked pixels of its core are written, so unmasked pixels come back unchanged."""
    height, width = mask.shape
    output = rgb.copy()
    tiles = 0
    for top in range(0, height, CORE):
        for left in range(0, width, CORE):
            core = mask[top : top + CORE, left : left + CORE] > 0
            if not core.any():
                continue
            y0 = min(max(top - HALO, 0), max(height - TILE, 0))
            x0 = min(max(left - HALO, 0), max(width - TILE, 0))
            window = rgb[y0 : y0 + TILE, x0 : x0 + TILE]
            window_mask = mask[y0 : y0 + TILE, x0 : x0 + TILE]
            pad_y, pad_x = TILE - window.shape[0], TILE - window.shape[1]
            if pad_y or pad_x:  # a photo smaller than one window
                window = cv2.copyMakeBorder(window, 0, pad_y, 0, pad_x, cv2.BORDER_REFLECT_101)
                window_mask = cv2.copyMakeBorder(window_mask, 0, pad_y, 0, pad_x, cv2.BORDER_CONSTANT, value=0)
            filled = fill(np.ascontiguousarray(window), np.ascontiguousarray(window_mask))
            if filled.shape != (TILE, TILE, 3) or filled.dtype != np.uint8:
                raise ValueError("the inpainting model returned an invalid window")
            patch = filled[top - y0 : top - y0 + core.shape[0], left - x0 : left - x0 + core.shape[1]]
            output[top : top + core.shape[0], left : left + core.shape[1]][core] = patch[core]
            tiles += 1
    return output, tiles


# ---------------------------------------------------------------------------------------
# Faces, found only to be protected.
# ---------------------------------------------------------------------------------------


def detect_faces(rgb: np.ndarray, detect: Detect) -> list[Box]:
    """Face boxes in the photo's own pixels, rounded outwards."""
    height, width = rgb.shape[:2]
    scale = min(1.0, DETECT_LONG_EDGE / max(height, width))
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    if scale < 1.0:
        bgr = cv2.resize(bgr, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
    found = np.asarray(detect(bgr), dtype=np.float32).reshape(-1, 15)
    return [
        (
            int(np.floor(left / scale)),
            int(np.floor(top / scale)),
            int(np.ceil(right / scale)),
            int(np.ceil(bottom / scale)),
        )
        for left, top, right, bottom in found[:, :4]
    ]


@dataclass(frozen=True)
class Models:
    detect: Detect
    fill: Fill


def find_marks(rgb: np.ndarray, models: Models) -> tuple[list[Box], np.ndarray]:
    """The faces to protect and the mask of marks to fill."""
    faces = detect_faces(rgb, models.detect)
    return faces, scratch_mask(rgb, faces)


def fill_marks(rgb: np.ndarray, faces: list[Box], mask: np.ndarray, models: Models) -> tuple[np.ndarray, Report]:
    report = Report(facesProtected=len(faces))
    fraction = float(np.count_nonzero(mask)) / mask.size
    report.scratchMaskFraction = round(fraction, 6)
    if fraction > MASK_CAP:
        report.scratchPass = "skipped-over-cap"
        report.warnings.append(
            f"scratch and dust removal was skipped: the marks cover {fraction:.1%} of the photo, over the "
            f"{MASK_CAP:.0%} limit"
        )
        return rgb.copy(), report
    if fraction == 0:
        return rgb.copy(), report
    output, report.scratchTiles = inpaint_tiled(rgb, mask, models.fill)
    report.scratchPass = "applied"
    return output, report


def repair(rgb: np.ndarray, models: Models) -> tuple[np.ndarray, Report]:
    faces, mask = find_marks(rgb, models)
    return fill_marks(rgb, faces, mask, models)


# ---------------------------------------------------------------------------------------
# The real models.
# ---------------------------------------------------------------------------------------


def stub_package(name: str, path: Path) -> None:
    """Make ``name`` importable from the checkout without running its ``__init__``, which pulls in
    tracking, recognition and download code this runtime never uses."""
    module = types.ModuleType(name)
    module.__path__ = [str(path)]
    sys.modules[name] = module


def load_models(args: argparse.Namespace, *, vram_bytes_for_fill: int = 2 << 30) -> Models:
    import torch

    cuda = torch.cuda.is_available()
    if not cuda and not args.allow_cpu:
        raise RuntimeError("photo repair needs an NVIDIA GPU; no CUDA device is available to this runtime")
    device = torch.device("cuda" if cuda else "cpu")

    root = args.runtime_root.resolve()
    sys.path.insert(0, str(root))
    stub_package("facexlib", root / "facexlib")
    stub_package("facexlib.detection", root / "facexlib" / "detection")
    from facexlib.detection.retinaface import RetinaFace

    detector = RetinaFace(network_name="resnet50", half=False, device=device)
    state = torch.load(args.detection, map_location="cpu", weights_only=True)
    detector.load_state_dict({key.removeprefix("module."): value for key, value in state.items()}, strict=True)
    detector.eval().to(device)

    import onnxruntime

    providers: list[Any] = ["CPUExecutionProvider"]
    if cuda:
        if hasattr(onnxruntime, "preload_dlls"):
            onnxruntime.preload_dlls()
        providers = [
            (
                "CUDAExecutionProvider",
                {"gpu_mem_limit": vram_bytes_for_fill, "arena_extend_strategy": "kSameAsRequested"},
            )
        ]
    session = onnxruntime.InferenceSession(str(args.lama), providers=providers)
    if cuda and "CUDAExecutionProvider" not in session.get_providers():
        raise RuntimeError("the inpainting model could not use the GPU")
    names = [node.name for node in session.get_inputs()]
    mask_name = next((name for name in names if "mask" in name.lower()), names[-1])
    image_name = next(name for name in names if name != mask_name)

    @torch.inference_mode()
    def detect(bgr: np.ndarray) -> np.ndarray:
        return np.asarray(detector.detect_faces(bgr, DETECT_CONFIDENCE))

    def fill(window: np.ndarray, window_mask: np.ndarray) -> np.ndarray:
        feed = {
            image_name: np.ascontiguousarray(window.transpose(2, 0, 1)[None].astype(np.float32) / 255.0),
            mask_name: (window_mask > 0).astype(np.float32)[None, None],
        }
        output = np.asarray(session.run(None, feed)[0], dtype=np.float32)[0]
        if not np.isfinite(output).all():
            raise ValueError("the inpainting model returned nonfinite pixels")
        if float(output.max(initial=0.0)) <= 1.0:  # an export that answers in 0..1
            output = output * 255.0
        return np.clip(output.transpose(1, 2, 0), 0, 255).round().astype(np.uint8)

    return Models(detect=detect, fill=fill)


def read_frame(path: Path) -> np.ndarray:
    if path.is_symlink() or not path.is_file():
        raise ValueError("a regular decoded PNG frame is required")
    with Image.open(path, formats=["PNG"]) as source:
        if max(source.size) > MAX_INPUT_EDGE:
            raise ValueError(f"the decoded frame is longer than {MAX_INPUT_EDGE} pixels")
        if source.mode != "RGB" or getattr(source, "n_frames", 1) != 1 or "transparency" in source.info:
            raise ValueError("a single opaque 8-bit RGB frame is required")
        return np.array(source)


def write_outputs(output_dir: Path, rgb: np.ndarray, report: dict[str, Any]) -> None:
    with tempfile.TemporaryDirectory(dir=output_dir) as stage:
        pending = Path(stage) / FRAME
        Image.fromarray(rgb).save(pending, compress_level=1)
        (Path(stage) / REPORT).write_text(json.dumps(report))
        os.link(Path(stage) / REPORT, output_dir / REPORT)
        os.link(pending, output_dir / FRAME)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--runtime-root", required=True, type=Path)
    parser.add_argument("--detection", required=True, type=Path)
    parser.add_argument("--lama", required=True, type=Path)
    # For adapter checks on a machine without a GPU. The worker's manifest can never pass it.
    parser.add_argument("--allow-cpu", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.input_dir.is_symlink() or [path.name for path in args.input_dir.iterdir()] != [FRAME]:
            raise ValueError("the input directory must contain exactly one decoded frame")
        if args.output_dir.is_symlink() or any(args.output_dir.iterdir()):
            raise ValueError("the output directory must be empty")
        source = read_frame(args.input_dir / FRAME)
        result, report = repair(source, load_models(args))
        if result.shape != source.shape:
            raise ValueError("the repaired frame changed size")
        write_outputs(args.output_dir, result, vars(report))
    except (OSError, ValueError, RuntimeError, Image.DecompressionBombError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
