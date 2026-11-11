import os
import runpy
import sys
from pathlib import Path

import numpy as np
import pytest
import torch
from PIL import Image
from torch.nn import functional as F

from frameleaf_ml.video_restoration.models import RUNTIME_ENV, RestorationFailure, RuntimeInvocation, run_runtime

SCRIPT = Path(__file__).parent / "video-restoration" / "runtimes" / "realesrgan_still.py"
CANDIDATE = runpy.run_path(str(SCRIPT))
FRAME = "00000001.png"


@pytest.fixture(autouse=True)
def bound_torch_threads():
    previous = torch.get_num_threads()
    torch.set_num_threads(2)
    yield
    torch.set_num_threads(previous)


def fixture_image():
    rng = np.random.default_rng(34)
    return Image.fromarray(rng.integers(32, 225, size=(113, 139, 3), dtype=np.uint8))


def whole_image(source, model):
    tensor = torch.from_numpy(np.array(source)).permute(2, 0, 1).unsqueeze(0).float() / 255
    with torch.inference_mode():
        pixels = model(tensor)[0].clamp(0, 1).mul(255).round().byte().permute(1, 2, 0)
    return pixels.numpy()


def test_tiles_match_full_frame_at_corners_and_seams():
    source = fixture_image()

    def model(tensor):
        detail = F.avg_pool2d(tensor, kernel_size=69, stride=1, padding=34)
        return F.interpolate(detail, scale_factor=4, mode="nearest")

    assert np.array_equal(np.asarray(CANDIDATE["enhance_tiled"](source, model)), whole_image(source, model))


def test_invalid_frame_and_unpinned_checkpoint_are_rejected(tmp_path):
    frame = tmp_path / FRAME
    Image.new("RGBA", (4, 4)).save(frame)
    with pytest.raises(ValueError, match="opaque RGB"):
        CANDIDATE["read_frame"](frame)
    Image.new("RGB", (1025, 1025)).save(frame)
    with pytest.raises(ValueError, match="size limit"):
        CANDIDATE["read_frame"](frame)
    with pytest.raises(ValueError, match="does not match"):
        CANDIDATE["load_model"](frame)


def test_official_checkpoint_runs_through_the_worker_runner(tmp_path):
    checkpoint = os.getenv("FRAMELEAF_TEST_REALESRGAN_CHECKPOINT")
    if not checkpoint:
        pytest.skip("requires the pinned official Real-ESRGAN checkpoint")
    source_dir = tmp_path / "decoded"
    output_dir = tmp_path / "rendered"
    source_dir.mkdir()
    output_dir.mkdir()
    source = fixture_image()
    source_path = source_dir / FRAME
    source.save(source_path)
    original = source_path.read_bytes()
    invocation = RuntimeInvocation(
        argv=[
            sys.executable,
            str(SCRIPT),
            "--input-dir",
            str(source_dir),
            "--output-dir",
            str(output_dir),
            "--checkpoint",
            checkpoint,
        ],
        cwd=tmp_path,
        env={**RUNTIME_ENV, "PATH": os.defpath},
        timeout_s=60,
    )

    assert run_runtime(invocation).duration_ms > 0
    with Image.open(output_dir / FRAME) as image:
        rendered = np.asarray(image)
    expected = whole_image(source, CANDIDATE["load_model"](Path(checkpoint)))
    assert rendered.shape == (452, 556, 3)
    assert np.abs(rendered.astype(np.int16) - expected).max() <= 1
    assert not np.array_equal(rendered, np.asarray(source.resize((556, 452), Image.Resampling.LANCZOS)))

    output_bytes = (output_dir / FRAME).read_bytes()
    with pytest.raises(RestorationFailure, match="output directory must be empty"):
        run_runtime(invocation)
    assert (output_dir / FRAME).read_bytes() == output_bytes
    assert source_path.read_bytes() == original

    (source_dir / "00000002.png").write_bytes(original)
    (output_dir / FRAME).unlink()
    with pytest.raises(RestorationFailure, match="exactly one decoded frame"):
        run_runtime(invocation)
    assert list(output_dir.iterdir()) == []
