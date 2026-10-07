"""Warm runtime and direct SeedVR2 contract tests; no torch or model weights required."""

import json
import os
import shutil
import subprocess
import sys
import threading
from dataclasses import replace
from fractions import Fraction
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from immich_ml.video_restoration import media, runtime_worker
from immich_ml.video_restoration.app import create_app
from immich_ml.video_restoration.models import (
    ModelSpec,
    RealBasicVsrAdapter,
    RestorationFailure,
    RestorationRegistry,
    RuntimeInvocation,
    RuntimeOutcome,
    RuntimeSpec,
    SeedVr2Adapter,
    SelectedModel,
    model_fingerprint,
)
from immich_ml.video_restoration.pipeline import AdapterFactory, restore
from immich_ml.video_restoration.runtime_pool import RuntimePool
from immich_ml.video_restoration.schemas import RestorationErrorCode, RestorationRequest, RestorationResult
from test_video_restoration import TestRegistry as RegistryFixture
from test_video_restoration import evaluate, fake_result, make_spec, passing_record, request_payload

# Match the upstream constructor/main boundary without importing CUDA dependencies.
FAKE_REALBASIC = """
import json, os, sys, time
from pathlib import Path

def init_model(config, checkpoint=None):
    with open('initializations', 'a') as log:
        log.write(config + ':' + str(checkpoint) + '\\n')
    return object()

def main():
    model = init_model(sys.argv[1], sys.argv[2])
    source, output = sys.argv[3:5]
    os.write(1, b'native model logging\\n')
    if source == 'fail':
        raise RuntimeError('CUDA out of memory')
    if source == 'sleep':
        time.sleep(30)
    Path(output).write_text(json.dumps({'pid': os.getpid(), 'source': source, 'model': id(model)}))
"""


def warm_spec(tmp_path: Path) -> ModelSpec:
    (tmp_path / "fake_model.py").write_text(FAKE_REALBASIC)
    spec = make_spec(tmp_path)
    runtime = RuntimeSpec(
        root=tmp_path,
        python=Path(sys.executable),
        protocol="warm-v1",
        argv=[
            sys.executable,
            str(Path(runtime_worker.__file__)),
            "realbasicvsr",
            "--module",
            "fake_model",
            "--config",
            "config.py",
            "--checkpoint",
            "{weight:generator}",
            "--max-seq-len",
            "{max_seq_len}",
        ],
    )
    return spec.model_copy(update={"runtime": runtime})


def invocation(spec: ModelSpec, tmp_path: Path, source: str, output: str = "result.json") -> RuntimeInvocation:
    return RealBasicVsrAdapter(spec, tmp_path).invocation(
        {
            "input_dir": source,
            "output_dir": str(tmp_path / output),
            "seed": "42",
            "target_width": "64",
            "target_height": "48",
            "max_seq_len": "30",
            "weight:generator": str(tmp_path / "generator.pth"),
        }
    )


def test_reuses_model_across_chunks_and_reloads_for_config_or_checkpoint(tmp_path: Path) -> None:
    spec = warm_spec(tmp_path)
    pool = RuntimePool()
    timer_patch = patch("immich_ml.video_restoration.runtime_pool.threading.Timer", wraps=threading.Timer)
    timers = timer_patch.start()
    try:
        pool(invocation(spec, tmp_path, "chunk-1", "one.json"))
        pool(invocation(spec, tmp_path, "chunk-2", "two.json"))
        first, second = [json.loads((tmp_path / name).read_text()) for name in ("one.json", "two.json")]
        assert first["pid"] == second["pid"] and first["model"] == second["model"]
        assert [first["source"], second["source"]] == ["chunk-1", "chunk-2"]
        # A canceled deadline that already woke up cannot evict the reused/idle process.
        timers.call_args_list[0].args[1]()
        assert pool._process is not None and pool._process.poll() is None
        assert len((tmp_path / "initializations").read_text().splitlines()) == 1
        changed = spec.model_copy(update={"runtime": spec.runtime.model_copy(update={"env": {"CONFIG_VERSION": "2"}})})
        assert model_fingerprint(changed) != model_fingerprint(spec)
        pool(invocation(changed, tmp_path, "chunk-3"))
        assert len((tmp_path / "initializations").read_text().splitlines()) == 2
        weight = changed.weights[0].model_copy(update={"sha256": "a" * 64})
        changed = changed.model_copy(update={"weights": [weight, *changed.weights[1:]]})
        pool(invocation(changed, tmp_path, "chunk-4"))
        assert len((tmp_path / "initializations").read_text().splitlines()) == 3
    finally:
        process = pool._process
        pool.close()
        assert process is not None and process.poll() is not None
        timer_patch.stop()


@pytest.mark.parametrize(
    ("source", "code"), [("fail", RestorationErrorCode.OUT_OF_MEMORY), ("sleep", RestorationErrorCode.TIMEOUT)]
)
def test_discards_failed_runtime_and_restarts(tmp_path: Path, source: str, code: RestorationErrorCode) -> None:
    spec = warm_spec(tmp_path)
    pool = RuntimePool()
    try:
        pool(invocation(spec, tmp_path, "warmup"))
        with pytest.raises(RestorationFailure) as error:
            pool(replace(invocation(spec, tmp_path, source), timeout_s=1))
        assert error.value.code == code
        assert pool._process is None
        pool(invocation(spec, tmp_path, "recovered"))
        assert len((tmp_path / "initializations").read_text().splitlines()) == 2
    finally:
        pool.close()


def test_bounds_warm_lifetime_by_requests_and_idle_time(tmp_path: Path) -> None:
    spec = warm_spec(tmp_path)
    pool = RuntimePool()
    try:
        pool(replace(invocation(spec, tmp_path, "one"), max_requests=1))
        assert pool._process is None
        pool(replace(invocation(spec, tmp_path, "two"), idle_s=1))
        process = pool._process
        assert process is not None
        process.wait(timeout=5)
        assert process.returncode is not None
    finally:
        pool.close()


@pytest.mark.parametrize("torchrun", [False, True])
def test_seedvr2_configures_runner_once_and_keeps_each_jobs_seed_and_geometry(tmp_path: Path, torchrun: bool) -> None:
    launcher = [sys.executable]
    if torchrun:
        executable = shutil.which("torchrun")
        if executable is None:
            pytest.skip("torchrun transport check requires an installed PyTorch")
        launcher = [executable, "--standalone", "--nnodes=1", "--nproc-per-node=1"]
    (tmp_path / "fake_seed.py").write_text("""
import json, os, signal, time
from pathlib import Path

def configure_runner(sp_size):
    with open('initializations', 'a') as log:
        log.write('init\\n')
    return object()

def generation_loop(runner, **job):
    if job['video_path'] == 'hang':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep(30)
    Path(job['output_dir']).write_text(json.dumps({**job, 'pid': os.getpid(), 'model': id(runner)}))
""")
    spec = warm_spec(tmp_path)
    spec = spec.model_copy(
        update={
            "family": "seedvr2",
            "runtime": spec.runtime.model_copy(
                update={"argv": [*launcher, str(Path(runtime_worker.__file__)), "seedvr2", "--module", "fake_seed"]}
            ),
        }
    )
    first = invocation(spec, tmp_path, "chunk-1", "one.json")
    assert first.payload is not None
    second = replace(
        invocation(spec, tmp_path, "chunk-2", "two.json"),
        payload={
            **first.payload,
            "input_dir": "chunk-2",
            "output_dir": str(tmp_path / "two.json"),
            "seed": "91",
            "target_height": "96",
        },
    )
    pool = RuntimePool()
    try:
        pool(first)
        pool(second)
        one, two = [json.loads((tmp_path / name).read_text()) for name in ("one.json", "two.json")]
        assert one["model"] == two["model"] and one["pid"] == two["pid"]
        assert (one["seed"], two["seed"], two["res_h"], two["video_path"]) == (42, 91, 96, "chunk-2")
        assert (tmp_path / "initializations").read_text() == "init\n"
        assert pool._worker_pid == one["pid"]
        if torchrun:
            with pytest.raises(RestorationFailure) as error:
                pool(replace(first, payload={**first.payload, "input_dir": "hang"}, timeout_s=1))
            assert error.value.code == RestorationErrorCode.TIMEOUT
            with pytest.raises(ProcessLookupError):
                os.kill(one["pid"], 0)
    finally:
        pool.close()


def test_changed_upstream_api_and_request_placeholders_fail_closed(tmp_path: Path) -> None:
    spec = warm_spec(tmp_path)
    (tmp_path / "fake_model.py").write_text("def init_model(): pass\ndef main(): pass\n")
    pool = RuntimePool()
    try:
        with pytest.raises(RestorationFailure, match="TypeError"):
            pool(invocation(spec, tmp_path, "one"))
        assert pool._process is None
    finally:
        pool.close()
    changed = spec.model_dump()
    changed["runtime"]["argv"].append("{input_dir}")
    with pytest.raises(ValidationError, match="per-request"):
        type(spec).model_validate(changed)


def test_http_worker_uses_warm_runner_and_closes_on_shutdown(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    spec = warm_spec(tmp_path)
    registry = RegistryFixture().write_config(tmp_path, spec, passing_record(spec))
    selected = SelectedModel(spec=spec, capability=evaluate(spec), weights_root=tmp_path)
    processes: list[subprocess.Popen[bytes] | None] = []

    def fake_restore(
        registry: RestorationRegistry,
        request: RestorationRequest,
        media_path: Path,
        work_dir: Path,
        *,
        adapter_factory: AdapterFactory,
    ) -> tuple[RestorationResult, Path]:
        adapter = adapter_factory(selected)
        assert isinstance(adapter.runner, RuntimePool)
        adapter.runner(invocation(spec, tmp_path, request.requestId))
        processes.append(adapter.runner._process)
        output = work_dir / "restored.mp4"
        output.write_bytes(b"restored")
        return fake_result(output), output

    monkeypatch.setattr("immich_ml.video_restoration.app.restore", fake_restore)
    with TestClient(create_app(registry, work_root=tmp_path, refresh_on_startup=False)) as client:
        for request_id in ("chunk-1", "chunk-2"):
            response = client.post(
                "/restoration/restore",
                data={"request": json.dumps(request_payload(requestId=request_id))},
                files={"media": ("clip.mp4", b"video", "video/mp4")},
            )
            assert response.status_code == 200, response.text
        assert processes[0] is processes[1]
    assert processes[0] is not None and processes[0].poll() is not None
    assert len((tmp_path / "initializations").read_text().splitlines()) == 1


HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


@pytest.fixture
def ffmpeg_timing(monkeypatch: pytest.MonkeyPatch) -> None:
    # The image pins Ubuntu's ffmpeg 4.4. Host ffmpeg 9 removed its legacy -vsync
    # spelling; exercise the identical passthrough mode without changing image flags.
    version = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, check=True).stdout
    if int(version.split()[2].split(".")[0]) >= 9:
        monkeypatch.setattr(media, "PASSTHROUGH_TIMING", ["-fps_mode", "passthrough"])


def make_video(path: Path, *, blank: bool = False, frames: int = 12, rate: str = "12") -> None:
    pattern = "color=black:size=64x48" if blank else "testsrc2=size=64x48"
    subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"{pattern}:rate={rate}",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-frames:v",
            str(frames),
            "-t",
            str(frames / float(Fraction(rate))),
            "-c:v",
            "libx264",
            "-c:a",
            "aac",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            str(path),
        ],
        check=True,
    )


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg integration check")
@pytest.mark.parametrize("segment", [None, {"startMs": 250, "endMs": 750}])
def test_seedvr2_pipeline_avoids_png_passes_and_preserves_segment_timing_audio(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, segment: dict[str, int] | None, ffmpeg_timing: None
) -> None:
    upload = tmp_path / "upload.mp4"
    make_video(upload)
    spec = make_spec(tmp_path, family="seedvr2", mode="creative", argv=["{input_dir}", "{output_dir}"])
    registry = RegistryFixture().write_config(tmp_path, spec, passing_record(spec))
    request = RestorationRequest.model_validate(
        request_payload(
            mode="creative",
            scale=1,
            segment=segment,
            source={"width": 64, "height": 48, "frameRate": "12/1", "durationMs": 1000},
        )
    )

    def runner(call: RuntimeInvocation) -> RuntimeOutcome:
        source = Path(call.argv[0]) / "source.mp4"
        if segment is None:
            assert source.stat().st_ino == upload.stat().st_ino
        else:
            assert len(media.video_frame_statistics(source, media.probe(source), max_frames=12, timeout=10)) == 6
        shutil.copyfile(source, Path(call.argv[1]) / "result.mp4")
        return RuntimeOutcome(10, None)

    def forbidden(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("direct video must not extract or encode PNG frames")

    monkeypatch.setattr(media, "extract_frames", forbidden)
    monkeypatch.setattr(media, "encode_near_lossless_clip", forbidden)
    monkeypatch.setattr(media, "decode_video_frames", forbidden)
    result, output = restore(
        registry, request, upload, tmp_path, adapter_factory=lambda selected: SeedVr2Adapter(spec, tmp_path, runner)
    )
    assert result.output.frameCount == (6 if segment else 12)
    assert result.output.frameRate == "12/1" and result.output.audio == "copied"
    assert result.output.durationMs is not None
    assert abs(result.output.durationMs - (500 if segment else 1000)) < 100
    encoded = media.probe(output)
    assert encoded.color_space == "bt709" and encoded.frame_rate == Fraction(12) and encoded.audio_streams == 1
    assert not list(tmp_path.rglob("*.png"))


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg integration check")
def test_streaming_validation_rejects_missing_extra_blank_frames_and_dimension_changes(
    tmp_path: Path, ffmpeg_timing: None
) -> None:
    source = tmp_path / "source.mp4"
    make_video(source)
    statistics = media.video_frame_statistics(source, media.probe(source), max_frames=12, timeout=10)
    assert len(statistics) == 12 and min(statistics) >= media.SOURCE_CONTENT_STD
    for name, frames, blank in [("missing", 11, False), ("extra", 13, False), ("blank", 12, True)]:
        output = tmp_path / f"{name}.mp4"
        make_video(output, frames=frames, blank=blank)
        with pytest.raises(media.MediaError):
            media.validate_video_output(statistics, output, timeout=10)
    with pytest.raises(media.MediaError, match="dimensions"):
        media.video_frame_statistics(source, replace(media.probe(source), width=62), max_frames=12, timeout=10)
