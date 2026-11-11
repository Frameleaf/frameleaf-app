"""FD-35 candidate checks. The real-model test accepts an explicitly supplied local file."""

import hashlib
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from frameleaf_ml.video_restoration import media, rife_candidate
from frameleaf_ml.video_restoration.models import (
    RestorationFailure,
    RifeAdapter,
    RuntimeInvocation,
    SelectedModel,
)
from frameleaf_ml.video_restoration.pipeline import restore
from frameleaf_ml.video_restoration.runtime_pool import RuntimePool
from frameleaf_ml.video_restoration.schemas import RestorationRequest


def fixture_frames(directory: Path) -> list[Path]:
    directory.mkdir()
    frames = []
    for index, offset in enumerate((8, 12, 16), 1):
        frame = np.full((64, 64, 3), 24, dtype=np.uint8)
        frame[20:40, offset : offset + 20] = [210, 170, 30]
        path = directory / f"{index:08}.png"
        Image.fromarray(frame).save(path)
        frames.append(path)
    return frames


def test_candidate_refuses_same_size_changed_weights(tmp_path, monkeypatch):
    model = tmp_path / "model.onnx"
    model.write_bytes(b"accepted")
    monkeypatch.setattr(rife_candidate, "MODEL_BYTES", len(b"accepted"))
    monkeypatch.setattr(rife_candidate, "MODEL_SHA256", hashlib.sha256(b"accepted").hexdigest())
    assert rife_candidate.model_bytes(model) == b"accepted"
    model.write_bytes(b"modified")
    with pytest.raises(ValueError, match="digest"):
        rife_candidate.model_bytes(model)


def test_rife_direct_phases_and_source_bytes_are_preserved(tmp_path, monkeypatch):
    source = tmp_path / "source"
    output = tmp_path / "output"
    frames = fixture_frames(source)
    output.mkdir()
    Image.new("RGB", (64, 64), (240, 240, 240)).save(frames[-1])
    before = [frame.read_bytes() for frame in frames]
    phases = []

    def predict(_model, left, _right, phase):
        phases.append(phase)
        return left

    monkeypatch.setattr(rife_candidate, "model_bytes", lambda _path: b"model")
    monkeypatch.setattr(rife_candidate, "session", lambda *_args: None)
    monkeypatch.setattr(rife_candidate, "interpolate", predict)
    rife_candidate.run(tmp_path / "unused", source, output, 4)
    rendered = media.list_frames(output)

    assert phases == [0.25, 0.5, 0.75]
    assert len(rendered) == 9
    assert [rendered[index].read_bytes() for index in (0, 4, 8)] == before
    assert all(frame.read_bytes() == before[1] for frame in rendered[5:8])
    assert [frame.read_bytes() for frame in frames] == before


def test_rife_invalid_tensor_leaves_no_visible_output(tmp_path, monkeypatch):
    source, output = tmp_path / "source", tmp_path / "output"
    fixture_frames(source)
    output.mkdir()

    class InvalidModel:
        def run(self, *_args):
            return [np.full((1, 3, 64, 64), np.nan, dtype=np.float32)]

    monkeypatch.setattr(rife_candidate, "model_bytes", lambda _path: b"model")
    monkeypatch.setattr(rife_candidate, "session", lambda *_args: InvalidModel())
    with pytest.raises(ValueError, match="invalid frame"):
        rife_candidate.run(tmp_path / "unused", source, output, 2)
    assert list(output.iterdir()) == []


@pytest.mark.skipif(os.name != "posix", reason="The Library restoration runner uses POSIX process groups")
def test_rife_cancelled_owned_runtime_cannot_publish_frames(tmp_path):
    source, output, marker = tmp_path / "source", tmp_path / "output", tmp_path / "inference-pid"
    fixture_frames(source)
    output.mkdir()
    script = """
import os, sys, time
from pathlib import Path
from frameleaf_ml.video_restoration import rife_candidate as runtime
runtime.model_bytes = lambda _: b'fixture'
runtime.session = lambda *_: None
def wait_for_cancel(*_):
    Path(sys.argv[3]).write_text(str(os.getpid()))
    time.sleep(30)
runtime.interpolate = wait_for_cancel
runtime.run(Path('unused'), Path(sys.argv[1]), Path(sys.argv[2]), 4)
"""
    invocation = RuntimeInvocation(
        [sys.executable, "-c", script, str(source), str(output), str(marker)],
        Path(__file__).parent,
        dict(os.environ),
        10,
    )
    pool = RuntimePool()
    with ThreadPoolExecutor(max_workers=1) as executor:
        result = executor.submit(pool, invocation)
        try:
            deadline = time.monotonic() + 5
            while not marker.exists() and not result.done() and time.monotonic() < deadline:
                time.sleep(0.02)
            assert marker.exists()
        finally:
            pool.cancel()
        with pytest.raises(RestorationFailure, match="cancelled"):
            result.result(timeout=5)
    with pytest.raises(ProcessLookupError):
        os.kill(int(marker.read_text()), 0)
    assert media.list_frames(output) == []


@pytest.mark.parametrize("factor", [2, 4, 8])
def test_exact_rife_artifact_runs_the_smooth_motion_pipeline(tmp_path, monkeypatch, factor):
    from test_video_restoration import evaluate, request_payload, rife_spec

    model_path = os.environ.get("FRAMELEAF_RIFE_CANDIDATE_MODEL")
    if not model_path or not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("Set FRAMELEAF_RIFE_CANDIDATE_MODEL to the local pinned ONNX file and install ffmpeg")
    model = Path(model_path).resolve()
    ffmpeg_help = subprocess.check_output(["ffmpeg", "-hide_banner", "-h", "full"], timeout=10)
    if b"-vsync " not in ffmpeg_help:
        # Local FFmpeg 9 removed the alias still required by the worker's Ubuntu FFmpeg 4.4.
        monkeypatch.setattr(media, "PASSTHROUGH_TIMING", ["-fps_mode", "passthrough"])
    source_frames = tmp_path / "original-frames"
    fixture_frames(source_frames)
    original = tmp_path / "original.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-framerate",
            "6",
            "-i",
            str(source_frames / "%08d.png"),
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=0.5",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-shortest",
            str(original),
        ],
        check=True,
        timeout=10,
    )
    before = hashlib.sha256(original.read_bytes()).hexdigest()
    spec = rife_spec(tmp_path, requires_gpu=False)
    spec = spec.model_copy(
        update={
            "weights": [
                spec.weights[0].model_copy(
                    update={"role": "rife_onnx", "path": Path(model.name), "sha256": rife_candidate.MODEL_SHA256}
                )
            ],
            "runtime": spec.runtime.model_copy(
                update={
                    "root": Path(__file__).parent,
                    "python": Path(sys.executable),
                    "argv": [
                        "{python}",
                        "-m",
                        "frameleaf_ml.video_restoration.rife_candidate",
                        "--model",
                        str(model),
                        "--img",
                        "{input_dir}",
                        "--output",
                        "{output_dir}",
                        "--exp",
                        "{exp}",
                    ],
                }
            ),
        }
    )
    selected = SelectedModel(spec, evaluate(spec), model.parent)

    class FixtureRegistry:
        def select(self, *_args):
            return selected

    request = RestorationRequest.model_validate(
        request_payload(
            mode="smooth_motion",
            scale=1,
            interpolationFactor=factor,
            source={"width": 64, "height": 64, "durationMs": 500, "frameRate": "6/1", "dynamicRange": "sdr"},
        )
    )
    work = tmp_path / "preview"
    work.mkdir()
    result, preview = restore(
        FixtureRegistry(),
        request,
        original,
        work,
        adapter_factory=lambda model: RifeAdapter(model.spec, model.weights_root, RuntimePool()),
    )

    assert preview != original
    assert hashlib.sha256(original.read_bytes()).hexdigest() == before
    assert (result.output.width, result.output.height, result.output.frameCount) == (64, 64, 3 * factor)
    assert result.output.frameRate == f"{6 * factor}/1"
    assert result.output.audio == "copied"
    probed = media.probe(preview)
    assert probed.frame_rate == 6 * factor
    assert probed.audio_codecs == media.probe(original).audio_codecs == ("aac",)
    assert abs(probed.duration_ms - 500) <= 42
    encoded_frames = subprocess.check_output(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "csv=p=0",
            str(preview),
        ],
        timeout=10,
    )
    assert int(encoded_frames) == 3 * factor
    rendered = media.list_frames(work / "runtime-output")
    assert len({frame.read_bytes() for frame in rendered[: factor + 1]}) > 2
