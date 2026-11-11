"""CPU candidate for the Real-ESRGAN general x4v3 still-image checkpoint."""

import argparse
import hashlib
import io
import os
import tempfile
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch import nn
from torch.nn import functional as F

FRAME = "00000001.png"
SCALE = 4
BODY_CONVOLUTIONS = 32
HALO = BODY_CONVOLUTIONS + 2
TILE = 96
MAX_INPUT_PIXELS = 1_048_576
MAX_INPUT_EDGE = 2048
CHECKPOINT_BYTES = 4_885_111
CHECKPOINT_SHA256 = "8dc7edb9ac80ccdc30c3a5dca6616509367f05fbc184ad95b731f05bece96292"


class CompactUpscaler(nn.Module):
    """SRVGG compact architecture compatible with realesr-general-x4v3."""

    def __init__(self):
        super().__init__()
        channels = 64
        body = [nn.Conv2d(3, channels, 3, padding=1), nn.PReLU(channels)]
        for _ in range(BODY_CONVOLUTIONS):
            body.extend((nn.Conv2d(channels, channels, 3, padding=1), nn.PReLU(channels)))
        body.append(nn.Conv2d(channels, 3 * SCALE**2, 3, padding=1))
        self.body = nn.Sequential(*body)

    def forward(self, source: torch.Tensor) -> torch.Tensor:
        detail = F.pixel_shuffle(self.body(source), SCALE)
        return detail + F.interpolate(source, scale_factor=SCALE, mode="nearest")


def load_model(checkpoint: Path) -> CompactUpscaler:
    with checkpoint.open("rb") as stream:
        data = stream.read(CHECKPOINT_BYTES + 1)
    if len(data) != CHECKPOINT_BYTES or hashlib.sha256(data).hexdigest() != CHECKPOINT_SHA256:
        raise ValueError("the checkpoint does not match Real-ESRGAN general x4v3")
    weights = torch.load(io.BytesIO(data), map_location="cpu", weights_only=True)
    model = CompactUpscaler()
    model.load_state_dict(weights["params"], strict=True)
    return model.eval()


def read_frame(path: Path) -> Image.Image:
    if path.is_symlink() or not path.is_file():
        raise ValueError("a regular decoded PNG frame is required")
    with Image.open(path, formats=["PNG"]) as source:
        width, height = source.size
        if max(width, height) > MAX_INPUT_EDGE or width * height > MAX_INPUT_PIXELS:
            raise ValueError("the decoded frame exceeds the CPU candidate size limit")
        if source.mode != "RGB" or source.n_frames != 1 or "transparency" in source.info:
            raise ValueError("a single opaque RGB frame is required")
        return source.copy()


@torch.inference_mode()
def enhance_tiled(source: Image.Image, model: nn.Module) -> Image.Image:
    width, height = source.size
    output = Image.new("RGB", (width * SCALE, height * SCALE))
    for top in range(0, height, TILE):
        bottom = min(top + TILE, height)
        for left in range(0, width, TILE):
            right = min(left + TILE, width)
            x0, y0 = max(left - HALO, 0), max(top - HALO, 0)
            x1, y1 = min(right + HALO, width), min(bottom + HALO, height)
            pixels = np.array(source.crop((x0, y0, x1, y1)))
            tensor = torch.from_numpy(pixels).permute(2, 0, 1).unsqueeze(0).float().div_(255)
            enhanced = model(tensor)
            if enhanced.shape != (1, 3, (y1 - y0) * SCALE, (x1 - x0) * SCALE):
                raise ValueError("the model returned invalid dimensions")
            if not torch.isfinite(enhanced).all():
                raise ValueError("the model returned nonfinite pixels")
            core = enhanced[
                0, :, (top - y0) * SCALE : (bottom - y0) * SCALE, (left - x0) * SCALE : (right - x0) * SCALE
            ]
            rgb = core.clamp(0, 1).mul(255).round().to(torch.uint8).permute(1, 2, 0).numpy()
            output.paste(Image.fromarray(rgb), (left * SCALE, top * SCALE))
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--checkpoint", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.input_dir.is_symlink() or [path.name for path in args.input_dir.iterdir()] != [FRAME]:
            raise ValueError("the input directory must contain exactly one decoded frame")
        if args.output_dir.is_symlink() or any(args.output_dir.iterdir()):
            raise ValueError("the output directory must be empty")
        source = read_frame(args.input_dir / FRAME)
        torch.set_num_threads(2)
        result = enhance_tiled(source, load_model(args.checkpoint))
        with tempfile.TemporaryDirectory(dir=args.output_dir) as stage:
            pending = Path(stage) / FRAME
            result.save(pending)
            os.link(pending, args.output_dir / FRAME)
    except (OSError, ValueError, RuntimeError, Image.DecompressionBombError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
