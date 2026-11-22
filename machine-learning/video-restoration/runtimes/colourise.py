"""Suggest colours for a black-and-white photo with DDColor (FL-933).

True and toned monochrome (sepia, albumen, selenium) are accepted. A hand-tinted print or a colour
photo is refused, because its real colour would be replaced. The report marks every result as
suggested colours.

One decoded RGB frame in, one RGB frame of exactly the same size out. The model only ever
sees a 512 x 512 copy and answers with two colour channels (Lab a and b). Those are enlarged
and joined to the photo's own full-size lightness, so the detail of a large scan is kept and
the GPU memory used does not grow with the scan.

The network class comes from the pinned DDColor checkout (``--runtime-root``); the weights are
a local file the worker has already hashed. Nothing here reaches the network.
"""

import argparse
import json
import os
import sys
import tempfile
import types
from collections.abc import Callable
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image

FRAME = "00000001.png"
REPORT = "report.json"
MAX_INPUT_EDGE = 8192
MODEL_SIZE = 512
STRIP_ROWS = 1024  # the Lab merge runs in strips so a large scan never needs several float copies
UNUSED_CLASSIFIER_KEYS = frozenset({"encoder.arch.head_cls.weight", "encoder.arch.head_cls.bias"})

# The worker reads this exit status as "this input is not supported" and passes the message on.
REFUSED_EXIT = 65
HAND_TINTED_MESSAGE = "this photo already has colour (hand-tinted or a colour print), so it was not colourised"
# The worker passes this on as a warning: the output is a suggestion, never a recovered original.
SUGGESTED_COLOURS = "suggested-colours: these colours are a model's suggestion, not the photo's original colours"

# Measured on the 200-scan set against the museum's "applied color" wording (FL-933): see README.
TINT_WORK_EDGE = 384
TINT_LEVELS = 24  # brightness bands
TINT_DISTANCE = 6.0  # Lab a/b distance from the band's usual colour
TINT_OUTER_INSET = 0.15
TINT_OUTER_SHARE = 0.05
TINT_INNER_INSET = 0.25
TINT_INNER_SHARE = 0.001

Predict = Callable[[np.ndarray], np.ndarray]


def model_input(rgb: np.ndarray) -> np.ndarray:
    """The grey RGB picture the model was trained on: lightness only, at the model's size, CHW in 0..1."""
    small = cv2.resize(rgb, (MODEL_SIZE, MODEL_SIZE), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    lightness = cv2.cvtColor(small, cv2.COLOR_RGB2Lab)[:, :, :1]
    grey = cv2.cvtColor(
        np.concatenate((lightness, np.zeros_like(lightness), np.zeros_like(lightness)), axis=-1), cv2.COLOR_Lab2RGB
    )
    return np.ascontiguousarray(grey.transpose(2, 0, 1))


def merge_colour(rgb: np.ndarray, colour: np.ndarray) -> np.ndarray:
    """Join the model's colour (``MODEL_SIZE`` square, 2 channels, Lab a and b) to the lightness of
    the full-size photo."""
    height, width = rgb.shape[:2]
    if colour.shape != (MODEL_SIZE, MODEL_SIZE, 2) or not np.isfinite(colour).all():
        raise ValueError("the colour model returned invalid output")
    enlarged = cv2.resize(colour.astype(np.float32), (width, height), interpolation=cv2.INTER_LINEAR)
    output = np.empty_like(rgb)
    for top in range(0, height, STRIP_ROWS):
        strip = rgb[top : top + STRIP_ROWS].astype(np.float32) / 255.0
        lightness = cv2.cvtColor(strip, cv2.COLOR_RGB2Lab)[:, :, :1]
        merged = cv2.cvtColor(np.concatenate((lightness, enlarged[top : top + STRIP_ROWS]), axis=-1), cv2.COLOR_Lab2RGB)
        output[top : top + STRIP_ROWS] = np.clip(merged * 255.0, 0, 255).round().astype(np.uint8)
    return output


def colourise(rgb: np.ndarray, predict: Predict) -> np.ndarray:
    return merge_colour(rgb, predict(model_input(rgb)))


def off_tone_share(rgb: np.ndarray, inset: float) -> float:
    """Of the picture inside ``inset``, the share of pixels whose colour differs from the usual colour
    of pixels equally bright. A toned print (sepia, albumen, selenium) has one colour per brightness,
    however strong; paint adds a second."""
    height, width = rgb.shape[:2]
    top, left = int(height * inset), int(width * inset)
    crop = rgb[top : height - top, left : width - left]
    scale = TINT_WORK_EDGE / max(crop.shape[:2])
    size = (max(1, round(crop.shape[1] * scale)), max(1, round(crop.shape[0] * scale)))
    small = cv2.GaussianBlur(cv2.resize(crop, size, interpolation=cv2.INTER_AREA), (0, 0), 1.0)
    lab = cv2.cvtColor(small.astype(np.float32) / 255.0, cv2.COLOR_RGB2Lab).reshape(-1, 3)
    levels = np.clip((lab[:, 0] / 100.0 * TINT_LEVELS).astype(np.int32), 0, TINT_LEVELS - 1)
    distance = np.zeros(len(lab), np.float32)
    for level in np.unique(levels):
        chosen = levels == level
        usual = np.median(lab[chosen, 1:], axis=0)
        distance[chosen] = np.hypot(*(lab[chosen, 1:] - usual).T)
    return float((distance > TINT_DISTANCE).mean())


def is_hand_tinted(rgb: np.ndarray) -> bool:
    """Whether a photo already carries applied colour (or is a colour photo). The second, tighter
    crop keeps a coloured mount or a gilt case from counting: paint is on the picture itself."""
    return off_tone_share(rgb, TINT_OUTER_INSET) > TINT_OUTER_SHARE and off_tone_share(rgb, TINT_INNER_INSET) > (
        TINT_INNER_SHARE
    )


def stub_package(name: str, path: Path) -> None:
    """Make ``name`` importable from the checkout without running its ``__init__``."""
    module = types.ModuleType(name)
    module.__path__ = [str(path)]
    sys.modules[name] = module


def model_weights(checkpoint: dict[str, Any]) -> dict[str, Any]:
    """The checkpoint's weights without the ConvNeXt classifier head, which DDColor never builds.

    Only those two keys are dropped, so the strict load still refuses any other mismatch.
    """
    weights = checkpoint["params"] if "params" in checkpoint else checkpoint
    return {name: value for name, value in weights.items() if name not in UNUSED_CLASSIFIER_KEYS}


def load_model(args: argparse.Namespace) -> Predict:
    import torch

    cuda = torch.cuda.is_available()
    if not cuda and not args.allow_cpu:
        raise RuntimeError("colourise needs an NVIDIA GPU; no CUDA device is available to this runtime")
    device = torch.device("cuda" if cuda else "cpu")

    root = args.runtime_root.resolve()
    sys.path.insert(0, str(root))
    stub_package("basicsr", root / "basicsr")
    stub_package("basicsr.archs", root / "basicsr" / "archs")
    stub_package("ddcolor", root / "ddcolor")
    from ddcolor.model import DDColor

    model = DDColor(
        encoder_name="convnext-l",
        decoder_name="MultiScaleColorDecoder",
        input_size=[MODEL_SIZE, MODEL_SIZE],
        num_output_channels=2,
        last_norm="Spectral",
        do_normalize=False,
        num_queries=100,
        num_scales=3,
        dec_layers=9,
    )
    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    model.load_state_dict(model_weights(checkpoint), strict=True)
    model.eval().to(device)

    @torch.inference_mode()
    def predict(grey: np.ndarray) -> np.ndarray:
        output = model(torch.from_numpy(grey).unsqueeze(0).to(device))[0]
        return np.ascontiguousarray(output.float().permute(1, 2, 0).cpu().numpy())

    return predict


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
    parser.add_argument("--checkpoint", required=True, type=Path)
    # For adapter checks on a machine without a GPU. The worker's manifest can never pass it.
    parser.add_argument("--allow-cpu", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.input_dir.is_symlink() or [path.name for path in args.input_dir.iterdir()] != [FRAME]:
            raise ValueError("the input directory must contain exactly one decoded frame")
        if args.output_dir.is_symlink() or any(args.output_dir.iterdir()):
            raise ValueError("the output directory must be empty")
        source = read_frame(args.input_dir / FRAME)
        if is_hand_tinted(source):
            parser.exit(REFUSED_EXIT, f"{HAND_TINTED_MESSAGE}\n")
        result = colourise(source, load_model(args))
        if result.shape != source.shape:
            raise ValueError("the colourised frame changed size")
        write_outputs(args.output_dir, result, {"warnings": [SUGGESTED_COLOURS]})
    except (OSError, ValueError, RuntimeError, Image.DecompressionBombError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
