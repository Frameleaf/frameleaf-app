"""Offline ONNX candidate for the existing RIFE frame-folder adapter."""

import argparse
import hashlib
import re
import shutil
import stat
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import onnxruntime as ort
from PIL import Image

MODEL_SHA256 = "4da60c1f20d42dba4f21503140940aa48a488585ead977532bf22e95a0319327"
MODEL_BYTES = 21_604_567
FRAME = re.compile(r"[0-9]{8}\.png")
MAX_FRAMES = 240
MAX_PIXELS = 1920 * 1088


def model_bytes(path: Path) -> bytes:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size != MODEL_BYTES:
        raise ValueError("RIFE candidate model has the wrong file type or size")
    with path.open("rb") as file:
        data = file.read(MODEL_BYTES + 1)
    if len(data) != MODEL_BYTES or hashlib.sha256(data).hexdigest() != MODEL_SHA256:
        raise ValueError("RIFE candidate model digest does not match")
    return data


def session(data: bytes, width: int, height: int) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    for index, dimension in enumerate((1, 6, height, width)):
        options.add_free_dimension_override_by_name(f"dynamic_dim_{index}", dimension)
    model = ort.InferenceSession(data, sess_options=options, providers=["CPUExecutionProvider"])
    inputs = {item.name: (item.type, item.shape) for item in model.get_inputs()}
    outputs = [item.name for item in model.get_outputs()]
    if inputs != {"input": ("tensor(float)", [1, 6, height, width]), "timestep": ("tensor(float)", [])} or outputs != [
        "output"
    ]:
        raise ValueError("RIFE candidate model has an unexpected input or output contract")
    return model


def read_frame(path: Path, expected: tuple[int, int] | None = None) -> np.ndarray:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > 32 * 1024 * 1024:
        raise ValueError("RIFE candidate input must be a bounded regular frame")
    with Image.open(path, formats=["PNG"]) as image:
        if (
            image.width * image.height > MAX_PIXELS
            or max(image.size) > 1920
            or (expected is not None and image.size != expected)
            or image.mode != "RGB"
        ):
            raise ValueError("RIFE candidate input must be same-sized, bounded RGB frames")
        return np.asarray(image).copy()


def is_cut(left: np.ndarray, right: np.ndarray) -> bool:
    stride = max(1, max(left.shape[:2]) // 64)
    coefficients = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32) / 255
    a, b = (frame[::stride, ::stride] @ coefficients for frame in (left, right))
    if np.mean(np.abs(a - b)) < 0.30:
        return False
    before, after = (np.histogram(frame, bins=16, range=(0, 1))[0] for frame in (a, b))
    return bool(np.abs(before - after).sum() / (2 * a.size) >= 0.35)


def interpolate(model: ort.InferenceSession, left: np.ndarray, right: np.ndarray, phase: float) -> np.ndarray:
    height, width, _ = left.shape
    pair = np.concatenate((left, right), axis=2).transpose(2, 0, 1)[None].astype(np.float32) / 255
    (output,) = model.run(["output"], {"input": pair, "timestep": np.array(phase, dtype=np.float32)})
    if output.dtype != np.float32 or output.shape != (1, 3, height, width) or not np.isfinite(output).all():
        raise ValueError("RIFE candidate produced an invalid frame")
    return np.rint(np.clip(output[0].transpose(1, 2, 0), 0, 1) * 255).astype(np.uint8)


def run(model_path: Path, source: Path, output: Path, factor: int) -> None:
    if factor not in (2, 4, 8) or output.is_symlink() or source.is_symlink() or source.resolve() == output.resolve():
        raise ValueError("RIFE candidate needs a supported factor and separate frame directories")
    if any(output.iterdir()):
        raise ValueError("RIFE candidate output directory must be empty")
    frames = sorted(source.iterdir())
    if not 2 <= len(frames) <= MAX_FRAMES or any(
        FRAME.fullmatch(frame.name) is None or int(frame.stem) != index for index, frame in enumerate(frames, 1)
    ):
        raise ValueError("RIFE candidate needs a contiguous decoded frame sequence")
    left = read_frame(frames[0])
    height, width, _ = left.shape
    model = session(model_bytes(model_path), width, height)
    # The restoration worker owns and removes this job directory if its subprocess is cancelled.
    # Publish frame filenames only after every frame has passed validation.
    with TemporaryDirectory(prefix=".rife-", dir=output) as temporary:
        scratch = Path(temporary)
        for index, right_path in enumerate(frames[1:]):
            right = read_frame(right_path, (width, height))
            start = index * factor + 1
            shutil.copyfile(frames[index], scratch / f"{start:08}.png")
            hold = np.array_equal(left, right) or is_cut(left, right)
            for step in range(1, factor):
                target = scratch / f"{start + step:08}.png"
                if hold:
                    shutil.copyfile(frames[index], target)
                else:
                    Image.fromarray(interpolate(model, left, right, step / factor)).save(target)
            left = right
        shutil.copyfile(frames[-1], scratch / f"{(len(frames) - 1) * factor + 1:08}.png")
        for frame in scratch.iterdir():
            frame.replace(output / frame.name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--img", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--exp", type=int, choices=(1, 2, 3), required=True)
    args = parser.parse_args()
    try:
        run(args.model, args.img, args.output, 1 << args.exp)
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f"RIFE candidate failed: {error}\n")


if __name__ == "__main__":
    main()
