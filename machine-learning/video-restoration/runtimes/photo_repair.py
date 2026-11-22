"""Photo repair for old prints (FL-933): scratches and dust, then faces.

One decoded RGB frame in, one RGB frame of exactly the same size out.

1. Faces are found with RetinaFace on a copy of at most ``DETECT_LONG_EDGE`` pixels.
2. Thin bright and dark defects outside the faces are masked and filled with LaMa in 512-pixel
   windows. Only masked pixels change. A mask over ``MASK_CAP`` of the photo skips the pass.
3. Each face is aligned to 512 x 512, restored with CodeFormer and blended back through its
   parsing mask. Pixels outside a face's mask are never touched by CodeFormer.

The network classes come from the pinned CodeFormer checkout (``--runtime-root``); the weights
are local files the worker has already hashed. Nothing here reaches the network.
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

# --- scratch and dust ---------------------------------------------------------------------
TILE = 512  # LaMa's fixed input
HALO = 64  # context kept around the part of a window that is written back
CORE = TILE - 2 * HALO
MASK_WORK_EDGE = 2048  # the detector runs on a copy this long at most
MASK_KERNEL = 9  # defects wider than this (at the working size) are not found
MASK_THRESHOLD = 48  # top-hat / black-hat response, of 255
SPECK_AREA = 40  # dust: a compact component up to this many working pixels
LINE_MIN_LENGTH = 20  # a scratch: at least this long ...
LINE_MAX_THICKNESS = 5.0  # ... and on average no thicker than this
TEXTURE_WINDOW = 65
TEXTURE_DENSITY = 0.12  # more candidates than this around a component: texture, not damage
MASK_CAP = 0.03  # never fill more than this fraction of a photo
FACE_MARGIN = 0.3  # the scratch mask stays this far (of the face box) outside every face

# --- faces --------------------------------------------------------------------------------
FACE_SIZE = 512
DETECT_LONG_EDGE = 1536
DETECT_CONFIDENCE = 0.97
MIN_EYE_DISTANCE = 10.0  # source pixels; smaller faces carry too little to restore
MAX_FACE_SCALE = 4.0  # source pixels per restored pixel; larger faces would come back softer
DEFAULT_FIDELITY = 0.7
# The five-point layout CodeFormer was trained on (eyes, nose, mouth corners), at 512 x 512.
FACE_TEMPLATE = np.array(
    [
        [192.98138, 239.94708],
        [318.90277, 240.1936],
        [256.63416, 314.01935],
        [201.26117, 371.41043],
        [313.08905, 371.15118],
    ],
    dtype=np.float32,
)
FACE_BORDER = (135, 133, 132)
# Parsing classes that belong to the face (skin, brows, eyes, nose, mouth, hair, ...), as upstream pastes them.
PARSE_FACE = np.array([0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0], dtype=np.float32)

Fill = Callable[[np.ndarray, np.ndarray], np.ndarray]
Restore = Callable[[np.ndarray], np.ndarray]
Parse = Callable[[np.ndarray], np.ndarray]
Detect = Callable[[np.ndarray], np.ndarray]


@dataclass
class Report:
    facesFound: int = 0
    facesRestored: int = 0
    facesSkippedSmall: int = 0
    facesSkippedLarge: int = 0
    scratchPass: str = "none"  # none | applied | skipped-over-cap
    scratchMaskFraction: float = 0.0
    scratchTiles: int = 0
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------------------
# Scratch and dust mask.
# ---------------------------------------------------------------------------------------

# ponytail: a classical detector — morphological top-hat and black-hat, a threshold and a
# thin-structure filter. Its ceiling: it finds only thin, high-contrast defects (hairline
# scratches, dust specks). It misses wide tears, creases, stains and low-contrast scratches,
# and it can take a thin real line on a plain background (a wire, a flagpole) for a scratch.
# The upgrade is the learned scratch-detection UNet from "Bringing Old Photos Back to Life"
# (MIT): same mask contract, so only this function changes.


def scratch_mask(rgb: np.ndarray, faces: list[tuple[int, int, int, int]]) -> np.ndarray:
    """A uint8 mask (255 where a defect is filled) at the photo's size."""
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

    count, labels, stats, _ = cv2.connectedComponentsWithStats(candidates, connectivity=8)
    keep = np.zeros(count, dtype=bool)
    if count > 1:
        area = stats[:, cv2.CC_STAT_AREA].astype(np.float32)
        length = np.hypot(stats[:, cv2.CC_STAT_WIDTH], stats[:, cv2.CC_STAT_HEIGHT]).astype(np.float32)
        speck = area <= SPECK_AREA
        line = (length >= LINE_MIN_LENGTH) & (area / np.maximum(length, 1.0) <= LINE_MAX_THICKNESS)
        # Grass, fabric, hair and print are full of thin bright and dark marks; real damage is sparse.
        density = cv2.blur(candidates.astype(np.float32), (TEXTURE_WINDOW, TEXTURE_WINDOW))
        mean_density = np.bincount(labels.ravel(), weights=density.ravel(), minlength=count) / np.maximum(area, 1.0)
        keep = (speck | line) & (mean_density <= TEXTURE_DENSITY)
        keep[0] = False
    mask = keep[labels].astype(np.uint8) * 255
    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8))
    if scale < 1.0:
        mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
        grow = int(np.ceil(1.0 / scale))
        mask = cv2.dilate(mask, np.ones((grow, grow), np.uint8))
    # Eyes, catchlights and teeth are thin bright marks too: nothing inside a face is ever filled.
    for left, top, right, bottom in faces:
        margin_x, margin_y = (right - left) * FACE_MARGIN, (bottom - top) * FACE_MARGIN
        mask[
            max(0, int(top - margin_y)) : min(height, int(bottom + margin_y) + 1),
            max(0, int(left - margin_x)) : min(width, int(right + margin_x) + 1),
        ] = 0
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
# Faces.
# ---------------------------------------------------------------------------------------


def detect_faces(rgb: np.ndarray, detect: Detect) -> np.ndarray:
    """Rows of box (4), score, and five landmarks (10) in the photo's own pixels."""
    height, width = rgb.shape[:2]
    scale = min(1.0, DETECT_LONG_EDGE / max(height, width))
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    if scale < 1.0:
        bgr = cv2.resize(bgr, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
    found = np.asarray(detect(bgr), dtype=np.float32).reshape(-1, 15)
    found[:, :4] /= scale
    found[:, 5:] /= scale
    return found


def restore_faces(rgb: np.ndarray, faces: np.ndarray, restore: Restore, parse: Parse, report: Report) -> np.ndarray:
    """Restore every usable face and blend it back through its parsing mask, in place."""
    height, width = rgb.shape[:2]
    square = np.array([[0, 0], [FACE_SIZE, 0], [FACE_SIZE, FACE_SIZE], [0, FACE_SIZE]], dtype=np.float32)
    for face in faces:
        landmarks = face[5:15].reshape(5, 2)
        if float(np.linalg.norm(landmarks[0] - landmarks[1])) < MIN_EYE_DISTANCE:
            report.facesSkippedSmall += 1
            continue
        affine = cv2.estimateAffinePartial2D(landmarks, FACE_TEMPLATE, method=cv2.LMEDS)[0]
        if affine is None:
            report.facesSkippedSmall += 1
            continue
        inverse = cv2.invertAffineTransform(affine)
        if float(np.hypot(inverse[0, 0], inverse[0, 1])) > MAX_FACE_SCALE:
            report.facesSkippedLarge += 1
            continue
        aligned = cv2.warpAffine(
            rgb, affine, (FACE_SIZE, FACE_SIZE), borderMode=cv2.BORDER_CONSTANT, borderValue=FACE_BORDER[::-1]
        )
        restored = restore(aligned)
        blend = parse(restored)
        if restored.shape != (FACE_SIZE, FACE_SIZE, 3) or blend.shape != (FACE_SIZE, FACE_SIZE):
            raise ValueError("the face models returned invalid dimensions")

        # Warp only into the face's own box: a full-size warp per face does not scale to large scans.
        corners = cv2.transform(square[None], inverse)[0]
        x0, y0 = np.floor(corners.min(axis=0)).astype(int)
        x1, y1 = np.ceil(corners.max(axis=0)).astype(int)
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, width), min(y1, height)
        if x1 <= x0 or y1 <= y0:
            continue
        local = inverse.copy()
        local[:, 2] -= (x0, y0)
        size = (x1 - x0, y1 - y0)
        face_pixels = cv2.warpAffine(restored, local, size, flags=cv2.INTER_CUBIC).astype(np.float32)
        weight = cv2.warpAffine(blend.astype(np.float32), local, size, flags=cv2.INTER_LINEAR)[..., None]
        region = rgb[y0:y1, x0:x1]
        region[:] = np.clip(weight * face_pixels + (1.0 - weight) * region, 0, 255).round().astype(np.uint8)
        report.facesRestored += 1
    return rgb


def face_blend_mask(classes: np.ndarray) -> np.ndarray:
    """Soft 0..1 mask over the restored face from its parsing classes, zero at the crop's edge."""
    mask = PARSE_FACE[classes] * 255.0
    mask = cv2.GaussianBlur(mask, (101, 101), 11)
    mask = cv2.GaussianBlur(mask, (101, 101), 11)
    edge = 10
    mask[:edge, :] = mask[-edge:, :] = 0
    mask[:, :edge] = mask[:, -edge:] = 0
    return mask / 255.0


@dataclass(frozen=True)
class Models:
    detect: Detect
    restore: Restore
    parse: Parse
    fill: Fill


def repair(rgb: np.ndarray, models: Models) -> tuple[np.ndarray, Report]:
    report = Report()
    faces = detect_faces(rgb, models.detect)
    report.facesFound = len(faces)
    boxes = [(int(face[0]), int(face[1]), int(face[2]), int(face[3])) for face in faces]

    mask = scratch_mask(rgb, boxes)
    fraction = float(np.count_nonzero(mask)) / mask.size
    report.scratchMaskFraction = round(fraction, 6)
    output = rgb
    if fraction > MASK_CAP:
        report.scratchPass = "skipped-over-cap"
        report.warnings.append(
            f"scratch and dust removal was skipped: the marks cover {fraction:.1%} of the photo, over the "
            f"{MASK_CAP:.0%} limit"
        )
    elif fraction > 0:
        output, report.scratchTiles = inpaint_tiled(rgb, mask, models.fill)
        report.scratchPass = "applied"
    if output is rgb:
        output = rgb.copy()

    restore_faces(output, faces, models.restore, models.parse, report)
    if report.facesSkippedLarge:
        report.warnings.append(
            f"{report.facesSkippedLarge} face(s) larger than {int(FACE_SIZE * MAX_FACE_SCALE)} px were left as they are"
        )
    if report.facesSkippedSmall:
        report.warnings.append(f"{report.facesSkippedSmall} face(s) were too small to restore")
    return output, report


# ---------------------------------------------------------------------------------------
# The real models.
# ---------------------------------------------------------------------------------------


def stub_package(name: str, path: Path) -> None:
    """Make ``name`` importable from the checkout without running its ``__init__``, which pulls in
    training code and download helpers this runtime never uses."""
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
    stub_package("basicsr", root / "basicsr")
    stub_package("basicsr.archs", root / "basicsr" / "archs")
    stub_package("facelib", root / "facelib")
    stub_package("facelib.detection", root / "facelib" / "detection")
    stub_package("facelib.parsing", root / "facelib" / "parsing")
    from basicsr.archs.codeformer_arch import CodeFormer
    from facelib.detection.retinaface import retinaface as retinaface_module
    from facelib.parsing.parsenet import ParseNet

    def state(path: Path) -> Any:
        return torch.load(path, map_location="cpu", weights_only=True)

    # Upstream picks its own device at import time; this runtime decides.
    retinaface_module.device = device
    detector = retinaface_module.RetinaFace(network_name="resnet50", half=False)
    detector.load_state_dict(
        {key.removeprefix("module."): value for key, value in state(args.detection).items()}, strict=True
    )
    detector.eval().to(device)

    parser = ParseNet(in_size=512, out_size=512, parsing_ch=19)
    parser.load_state_dict(state(args.parsing), strict=True)
    parser.eval().to(device)

    codeformer = CodeFormer(
        dim_embd=512, codebook_size=1024, n_head=8, n_layers=9, connect_list=["32", "64", "128", "256"]
    )
    codeformer.load_state_dict(state(args.codeformer)["params_ema"], strict=True)
    codeformer.eval().to(device)

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

    def to_tensor(face: np.ndarray) -> Any:
        tensor = torch.from_numpy(face).permute(2, 0, 1).float().div(255.0).sub(0.5).div(0.5)
        return tensor.unsqueeze(0).to(device)

    @torch.inference_mode()
    def detect(bgr: np.ndarray) -> np.ndarray:
        return np.asarray(detector.detect_faces(bgr, DETECT_CONFIDENCE))

    @torch.inference_mode()
    def restore(face: np.ndarray) -> np.ndarray:
        output = codeformer(to_tensor(face), w=args.fidelity, adain=True)[0]
        if not torch.isfinite(output).all():
            raise ValueError("the face model returned nonfinite pixels")
        pixels = output[0].clamp(-1, 1).add(1).mul(127.5).round().to(torch.uint8)
        return np.ascontiguousarray(pixels.permute(1, 2, 0).cpu().numpy())

    @torch.inference_mode()
    def parse(face: np.ndarray) -> np.ndarray:
        classes = parser(to_tensor(face))[0].argmax(dim=1)[0].cpu().numpy()
        return face_blend_mask(classes)

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

    return Models(detect=detect, restore=restore, parse=parse, fill=fill)


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
    parser.add_argument("--codeformer", required=True, type=Path)
    parser.add_argument("--detection", required=True, type=Path)
    parser.add_argument("--parsing", required=True, type=Path)
    parser.add_argument("--lama", required=True, type=Path)
    parser.add_argument("--fidelity", type=float, default=DEFAULT_FIDELITY)
    # For adapter checks on a machine without a GPU. The worker's manifest can never pass it.
    parser.add_argument("--allow-cpu", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if not 0.0 <= args.fidelity <= 1.0:
            raise ValueError("fidelity must be between 0 and 1")
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
