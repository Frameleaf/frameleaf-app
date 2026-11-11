"""FD-35 candidate checks. The real-model test accepts an explicitly supplied local file."""

import hashlib
import json
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
from pydantic import ValidationError

from frameleaf_ml.video_restoration import media, rife_candidate
from frameleaf_ml.video_restoration.models import (
    RIFE_CANDIDATE_ARGV,
    RIFE_CANDIDATE_ID,
    RIFE_CANDIDATE_SCRIPT,
    ModelSpec,
    RestorationFailure,
    RestorationRegistry,
    RifeAdapter,
    RuntimeInvocation,
    SelectedModel,
)
from frameleaf_ml.video_restoration.pipeline import restore
from frameleaf_ml.video_restoration.runtime_approval import SignedRuntimeApproval, approval_statement
from frameleaf_ml.video_restoration.runtime_pool import RuntimePool
from frameleaf_ml.video_restoration.schemas import RestorationErrorCode, RestorationMode, RestorationRequest


def fixture_frames(directory: Path, offsets=(8, 12, 16)) -> list[Path]:
    directory.mkdir()
    frames = []
    for index, offset in enumerate(offsets, 1):
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


def local_rife_inputs(monkeypatch):
    model_path = os.environ.get("FRAMELEAF_RIFE_CANDIDATE_MODEL")
    if not model_path or not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        pytest.skip("Set FRAMELEAF_RIFE_CANDIDATE_MODEL to the local pinned ONNX file and install ffmpeg")
    model = Path(model_path).resolve()
    ffmpeg_help = subprocess.check_output(["ffmpeg", "-hide_banner", "-h", "full"], timeout=10)
    if b"-vsync " not in ffmpeg_help:
        # Local FFmpeg 9 removed the alias still required by the worker's Ubuntu FFmpeg 4.4.
        monkeypatch.setattr(media, "PASSTHROUGH_TIMING", ["-fps_mode", "passthrough"])
    return model


def fixture_clip(tmp_path, offsets=(8, 12, 16)):
    source_frames = tmp_path / "original-frames"
    fixture_frames(source_frames, offsets)
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
            f"sine=frequency=440:sample_rate=48000:duration={len(offsets) / 6}",
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
    return original


@pytest.mark.parametrize("factor", [2, 4, 8])
def test_exact_rife_artifact_runs_the_smooth_motion_pipeline(tmp_path, monkeypatch, factor):
    from test_video_restoration import evaluate, request_payload, rife_spec

    model = local_rife_inputs(monkeypatch)
    original = fixture_clip(tmp_path)
    before = hashlib.sha256(original.read_bytes()).hexdigest()
    spec = ModelSpec.model_validate(
        {
            **rife_spec(tmp_path, requires_gpu=False).model_dump(mode="json"),
            "id": RIFE_CANDIDATE_ID,
            "weights": [{"role": "model", "path": model.name, "sha256": rife_candidate.MODEL_SHA256}],
            "runtime": {
                "root": Path(__file__).parent.parent,
                "python": Path(sys.executable),
                "argv": list(RIFE_CANDIDATE_ARGV),
            },
            "limits": {"maxInputLongEdge": 1280, "maxFrames": 30, "maxFramesPerChunk": 30, "minVramBytes": 0},
        }
    )
    selected = SelectedModel(spec, evaluate(spec), model.parent)

    class FixtureRegistry:
        def select(self, *_args, kind):
            assert kind == "video"
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


def test_candidate_cannot_use_a_legacy_model_id_or_an_arbitrary_entrypoint(tmp_path):
    from test_video_restoration import rife_spec

    base = rife_spec(tmp_path, requires_gpu=False).model_dump(mode="json")
    base.update(
        {
            "id": RIFE_CANDIDATE_ID,
            "weights": [{"role": "model", "path": "model.onnx", "sha256": rife_candidate.MODEL_SHA256}],
            "runtime": {"root": tmp_path, "python": sys.executable, "argv": list(RIFE_CANDIDATE_ARGV)},
            "limits": {"maxInputLongEdge": 1280, "maxFrames": 30, "maxFramesPerChunk": 30, "minVramBytes": 0},
        }
    )
    assert ModelSpec.model_validate(base).signed_candidate == "rife-onnx"
    with pytest.raises(ValidationError, match="invalid signed RIFE candidate"):
        ModelSpec.model_validate({**base, "id": "legacy-rife"})
    with pytest.raises(ValidationError, match="invalid signed RIFE candidate"):
        ModelSpec.model_validate({**base, "runtime": {**base["runtime"], "argv": ["{python}", "other.py"]}})


def test_signed_smooth_motion_preview_and_full_version(tmp_path, monkeypatch):
    from test_video_restoration import IMAGE_REVISION, passing_record, request_payload, rife_spec

    model = local_rife_inputs(monkeypatch)
    openssl = os.environ.get("FRAMELEAF_TEST_OPENSSL")
    if not openssl:
        pytest.skip("Set FRAMELEAF_TEST_OPENSSL to an absolute OpenSSL 3 executable")
    root = tmp_path / "runtime"
    script = root / RIFE_CANDIDATE_SCRIPT
    script.parent.mkdir(parents=True)
    shutil.copyfile(Path(rife_candidate.__file__), script)

    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args], text=True, timeout=10).strip()

    git("init", "-q")
    git("add", RIFE_CANDIDATE_SCRIPT)
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture runtime")
    spec = ModelSpec.model_validate(
        {
            **rife_spec(tmp_path, requires_gpu=False).model_dump(mode="json"),
            "id": RIFE_CANDIDATE_ID,
            "revision": git("rev-parse", "HEAD"),
            "weights": [{"role": "model", "path": model.name, "sha256": rife_candidate.MODEL_SHA256}],
            "runtime": {
                "root": root,
                "python": sys.executable,
                "argv": list(RIFE_CANDIDATE_ARGV),
                "timeoutSeconds": 30,
            },
            "limits": {"maxInputLongEdge": 1280, "maxFrames": 30, "maxFramesPerChunk": 30, "minVramBytes": 0},
        }
    )
    record = passing_record(spec)
    manifest, qualification = tmp_path / "models.json", tmp_path / "qualification.json"
    manifest.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "weightsRoot": str(model.parent),
                "models": [spec.model_dump(mode="json")],
            }
        )
    )

    def write_record(value):
        qualification.write_text(json.dumps({"schemaVersion": 1, "records": [value.model_dump(mode="json")]}))

    write_record(record)
    (tmp_path / "statement").write_bytes(approval_statement(spec, record, IMAGE_REVISION))
    for args in (
        ["genpkey", "-algorithm", "ED25519", "-out", "private"],
        ["pkey", "-in", "private", "-pubout", "-outform", "DER", "-out", "public"],
        ["pkeyutl", "-sign", "-rawin", "-inkey", "private", "-in", "statement", "-out", "signature"],
    ):
        subprocess.run([openssl, *args], cwd=tmp_path, check=True, timeout=10)
    approval = SignedRuntimeApproval(
        Path(openssl), (tmp_path / "public").read_bytes(), (tmp_path / "signature").read_bytes()
    )

    def registry(admission=None):
        return RestorationRegistry(
            manifest,
            qualification,
            gpu_query=list,
            container_revision=IMAGE_REVISION,
            signed_admission=admission,
        )

    with pytest.raises(RestorationFailure, match="no valid signed installed runtime approval"):
        registry().select(RestorationMode.SMOOTH_MOTION, spec.id, None)
    with pytest.raises(RestorationFailure, match="no valid signed installed runtime approval"):
        registry(SignedRuntimeApproval(approval.openssl, approval.public_key, bytes(64))).select(
            RestorationMode.SMOOTH_MOTION,
            spec.id,
            None,
        )
    admitted = registry(approval)
    assert admitted.report().models == []
    assert admitted.refresh().workloads == []
    with pytest.raises(RestorationFailure, match="no smooth_motion model"):
        admitted.select(RestorationMode.SMOOTH_MOTION, None, None)
    with pytest.raises(RestorationFailure, match="no smooth_motion model"):
        admitted.select(RestorationMode.SMOOTH_MOTION, spec.id, None, kind="image")

    original = fixture_clip(tmp_path, offsets=(8, 12, 16, 20, 24, 28))
    original_bytes = original.read_bytes()
    request = RestorationRequest.model_validate(
        request_payload(
            mode="smooth_motion",
            modelId=spec.id,
            scale=1,
            interpolationFactor=4,
            source={"width": 64, "height": 64, "durationMs": 1000, "frameRate": "6/1", "dynamicRange": "sdr"},
            segment={"startMs": 0, "endMs": 500},
        )
    )
    preview_dir, full_dir = tmp_path / "preview", tmp_path / "full"
    preview_dir.mkdir()
    full_dir.mkdir()
    preview, preview_file = restore(admitted, request, original, preview_dir)
    preview_bytes = preview_file.read_bytes()
    full_request = request.model_copy(
        update={
            "requestId": "full-version",
            "segment": None,
            "modelFingerprint": preview.model.fingerprint,
        }
    )
    full, full_file = restore(admitted, full_request, original, full_dir)
    assert full.model == preview.model
    assert (preview.output.frameCount, full.output.frameCount) == (12, 24)
    assert full.output.frameRate == preview.output.frameRate == "24/1"
    assert full.output.audio == preview.output.audio == "copied"
    assert preview_file.parent == preview_dir and full_file.parent == full_dir
    assert full_file.read_bytes() != preview_bytes
    assert preview_file.read_bytes() == preview_bytes
    assert original.read_bytes() == original_bytes

    refused = tmp_path / "stale-full"
    refused.mkdir()
    with pytest.raises(RestorationFailure) as stale:
        restore(admitted, full_request.model_copy(update={"modelFingerprint": "0" * 64}), original, refused)
    assert stale.value.code == RestorationErrorCode.MODEL_CHANGED
    assert list(refused.iterdir()) == []
    write_record(record.model_copy(update={"notes": "changed after review"}))
    with pytest.raises(RestorationFailure, match="no valid signed installed runtime approval"):
        admitted.select(RestorationMode.SMOOTH_MOTION, spec.id, preview.model.fingerprint)
    write_record(record)
    script.write_text(script.read_text() + "\n# changed after review\n")
    assert not approval(spec, record, IMAGE_REVISION)
    with pytest.raises(RestorationFailure, match="runtime-dirty"):
        admitted.select(RestorationMode.SMOOTH_MOTION, spec.id, preview.model.fingerprint)
