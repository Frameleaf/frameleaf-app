"""FL-114: restoration adapters, qualification gate, pipeline checks and worker HTTP surface.

No model weights, GPU or ffmpeg are needed: runtimes and media tools are replaced with fakes.
What these tests cannot show (real model quality, VRAM, timing) is qualification evidence
recorded on hardware; see machine-learning/video-restoration/README.md.
"""

import base64
import hashlib
import json
from datetime import date
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

from immich_ml.video_restoration import media
from immich_ml.video_restoration.app import create_app
from immich_ml.video_restoration.gpu import parse_gpu_query, parse_memory_used
from immich_ml.video_restoration.models import (
    REQUIRED_EVIDENCE,
    AdapterRun,
    ModelSpec,
    QualificationRecord,
    RealBasicVsrAdapter,
    RestorationFailure,
    RestorationRegistry,
    RuntimeInvocation,
    RuntimeJob,
    RuntimeOutcome,
    RuntimeStatus,
    SelectedModel,
    WeightStatus,
    WeightVerifier,
    classify_runtime_failure,
    evaluate_model,
    model_fingerprint,
    render_argv,
)
from immich_ml.video_restoration.pipeline import check_source
from immich_ml.video_restoration.schemas import (
    RESULT_HEADER,
    DynamicRange,
    GpuDescription,
    ModelIdentity,
    ModelState,
    OutputDescription,
    RestorationErrorCode,
    RestorationMode,
    RestorationRequest,
    RestorationResult,
    RestorationTiming,
    WeightIdentity,
)

EXAMPLES = Path(__file__).parent / "video-restoration"
COMMIT = "0123456789abcdef0123456789abcdef01234567"
IMAGE_REVISION = "image-rev-1"
GPU = GpuDescription(name="Qualified GPU", memoryTotalBytes=24 * 1024**3, driverVersion="550.0")
CLEAN = RuntimeStatus(present=True, clean=True)
VERIFIED = WeightStatus()


def sha(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def make_spec(
    tmp_path: Path,
    *,
    family: str = "realbasicvsr",
    mode: str = "faithful",
    revision: str = COMMIT,
    weights: dict[str, str] | None = None,
    min_vram: int = 8 * 1024**3,
    dynamic_ranges: list[str] | None = None,
    argv: list[str] | None = None,
) -> ModelSpec:
    weights = weights or {"generator": sha(b"generator"), "spynet": sha(b"spynet")}
    return ModelSpec.model_validate(
        {
            "id": f"{family}-test",
            "family": family,
            "mode": mode,
            "displayName": "Test model",
            "repository": "https://example.invalid/model",
            "revision": revision,
            "nativeScale": 4 if family == "realbasicvsr" else None,
            "runtime": {
                "root": str(tmp_path / "runtime"),
                "python": str(tmp_path / "runtime" / "python"),
                "argv": argv
                or [
                    "{python}",
                    "inference.py",
                    "{weight:generator}",
                    "{input_dir}",
                    "{output_dir}",
                    "--max_seq_len={max_seq_len}",
                ],
            },
            "weights": [{"role": role, "path": f"{role}.pth", "sha256": value} for role, value in weights.items()],
            "limits": {"maxInputLongEdge": 1280, "maxFrames": 300, "maxFramesPerChunk": 30, "minVramBytes": min_vram},
            "dynamicRanges": dynamic_ranges or ["sdr"],
        }
    )


def passing_record(spec: ModelSpec, **overrides: Any) -> QualificationRecord:
    payload: dict[str, Any] = {
        "id": f"{spec.id}-qualified",
        "modelId": spec.id,
        "revision": spec.revision,
        "weights": [{"role": weight.role, "sha256": weight.sha256} for weight in spec.weights],
        "containerRevisions": [IMAGE_REVISION],
        "hardware": [{"gpu": GPU.name, "driverVersion": "550.0", "cudaVersion": "12.4"}],
        "measurements": [
            {
                "gpu": GPU.name,
                "inputWidth": 640,
                "inputHeight": 360,
                "frames": 150,
                "framesPerSecond": 4.2,
                "peakVramBytes": 9 * 1024**3,
            }
        ],
        "evidence": [
            {"item": item, "result": "pass", "artifact": f"reports/{item}.md"}
            for item in REQUIRED_EVIDENCE[spec.family]
        ],
        "license": {
            "approved": True,
            "code": "Apache-2.0",
            "weights": "Apache-2.0",
            "reviewedBy": "reviewer",
            "reviewedAt": "2026-09-01",
        },
        "reviewedBy": "qualifier",
        "reviewedAt": "2026-09-01",
    }
    payload.update(overrides)
    return QualificationRecord.model_validate(payload)


def evaluate(spec: ModelSpec, **overrides: Any) -> Any:
    arguments: dict[str, Any] = {
        "runtime": CLEAN,
        "weights": VERIFIED,
        "records": [passing_record(spec)],
        "gpus": [GPU],
        "container_revision": IMAGE_REVISION,
    }
    arguments.update(overrides)
    return evaluate_model(spec, **arguments)


class TestQualificationGate:
    def test_available_only_with_complete_evidence(self, tmp_path: Path) -> None:
        spec = make_spec(tmp_path)

        capability = evaluate(spec)

        assert capability.state == ModelState.AVAILABLE
        assert capability.reasons == []
        assert capability.fingerprint == model_fingerprint(spec)
        assert capability.qualificationId == f"{spec.id}-qualified"
        assert capability.measured[0].framesPerSecond == 4.2
        assert capability.dynamicRanges == [DynamicRange.SDR]

    @pytest.mark.parametrize(
        ("state", "change"),
        [
            (ModelState.NOT_PINNED, lambda spec, args: {"spec": spec.model_copy(update={"revision": "main"})}),
            (
                ModelState.RUNTIME_MISSING,
                lambda spec, args: {"runtime": RuntimeStatus(present=False, clean=False, problems=["no checkout"])},
            ),
            (
                ModelState.RUNTIME_DIRTY,
                lambda spec, args: {"runtime": RuntimeStatus(present=True, clean=False, problems=["modified"])},
            ),
            (ModelState.WEIGHTS_MISSING, lambda spec, args: {"weights": WeightStatus(missing=["generator"])}),
            (ModelState.WEIGHTS_MISMATCH, lambda spec, args: {"weights": WeightStatus(mismatched=["generator"])}),
            (
                ModelState.UNQUALIFIED,
                lambda spec, args: {
                    "records": [
                        passing_record(
                            spec,
                            evidence=[
                                {"item": item, "result": "pending"} for item in REQUIRED_EVIDENCE[spec.family]
                            ],
                        )
                    ]
                },
            ),
            (ModelState.UNQUALIFIED, lambda spec, args: {"container_revision": "some-other-image"}),
            (ModelState.UNQUALIFIED, lambda spec, args: {"container_revision": None}),
            (ModelState.UNQUALIFIED, lambda spec, args: {"records": [passing_record(spec, reviewedBy=None)]}),
            (ModelState.UNQUALIFIED, lambda spec, args: {"records": [passing_record(spec, measurements=[])]}),
            (
                ModelState.LICENSE_UNREVIEWED,
                lambda spec, args: {"records": [passing_record(spec, license={"approved": False})]},
            ),
            (ModelState.NO_GPU, lambda spec, args: {"gpus": []}),
            (
                ModelState.GPU_UNQUALIFIED,
                lambda spec, args: {
                    "gpus": [GpuDescription(name="Other GPU", memoryTotalBytes=80 * 1024**3, driverVersion="550.0")]
                },
            ),
            (
                ModelState.INSUFFICIENT_VRAM,
                lambda spec, args: {"gpus": [GPU.model_copy(update={"memoryTotalBytes": 4 * 1024**3})]},
            ),
        ],
    )
    def test_every_gap_keeps_the_model_unavailable(
        self, tmp_path: Path, state: ModelState, change: Callable[[ModelSpec, dict[str, Any]], dict[str, Any]]
    ) -> None:
        spec = make_spec(tmp_path)
        overrides = change(spec, {})
        target = overrides.pop("spec", spec)

        capability = evaluate(target, **overrides)

        assert capability.state == state
        assert capability.reasons

    def test_a_record_for_other_weights_does_not_qualify(self, tmp_path: Path) -> None:
        spec = make_spec(tmp_path)
        other = make_spec(tmp_path, weights={"generator": sha(b"changed"), "spynet": sha(b"spynet")})

        capability = evaluate(spec, records=[passing_record(other)])

        assert capability.state == ModelState.UNQUALIFIED
        assert capability.qualificationId is None
        assert "no qualification record" in capability.reasons[0]

    def test_a_later_pass_never_hides_a_failure_and_a_pass_needs_its_artifact(self, tmp_path: Path) -> None:
        spec = make_spec(tmp_path)
        passing = [evidence.model_dump(mode="json") for evidence in passing_record(spec).evidence]
        unsupported = [{**entry, "artifact": ""} if entry["item"] == "fault-nan" else entry for entry in passing]

        failing_first = [{"item": "compare-faces", "result": "fail"}, *passing]

        failed = evaluate(spec, records=[passing_record(spec, evidence=failing_first)])
        bare = evaluate(spec, records=[passing_record(spec, evidence=unsupported)])

        assert failed.state == ModelState.UNQUALIFIED
        assert "evidence compare-faces is fail" in failed.reasons
        assert bare.state == ModelState.UNQUALIFIED
        assert "evidence fault-nan passes without an artifact to reproduce it" in bare.reasons

    def test_a_gpu_on_another_driver_branch_is_not_qualified(self, tmp_path: Path) -> None:
        spec = make_spec(tmp_path)
        other_driver = GPU.model_copy(update={"driverVersion": "560.1"})
        same_branch = GPU.model_copy(update={"driverVersion": "550.54.14"})

        assert evaluate(spec, gpus=[other_driver]).state == ModelState.GPU_UNQUALIFIED
        assert evaluate(spec, gpus=[same_branch]).state == ModelState.AVAILABLE

    def test_hdr_is_never_offered_even_when_a_record_claims_it(self, tmp_path: Path) -> None:
        spec = make_spec(tmp_path, dynamic_ranges=["sdr", "hdr"])

        capability = evaluate(spec, records=[passing_record(spec, hdrQualified=True)])

        assert capability.state == ModelState.AVAILABLE
        assert capability.dynamicRanges == [DynamicRange.SDR]

    def test_every_family_requires_the_fault_and_comparison_evidence(self) -> None:
        for family in ("realbasicvsr", "seedvr2"):
            required = {str(item) for item in REQUIRED_EVIDENCE[family]}
            assert {"fault-out-of-memory", "fault-nan", "fault-changed-weights", "fault-dirty-checkout"} <= required
            assert {"compare-faces", "compare-text", "compare-foliage", "compare-motion", "compare-cuts"} <= required
            assert {"chunk-seams", "timing-preserved", "audio-preserved", "deterministic-repeat"} <= required
        assert "x4-to-requested-2x" in {str(item) for item in REQUIRED_EVIDENCE["realbasicvsr"]}
        assert {"intermediate-compression", "frame-count"} <= {str(item) for item in REQUIRED_EVIDENCE["seedvr2"]}


class TestManifest:
    def test_rejects_unknown_placeholders(self, tmp_path: Path) -> None:
        with pytest.raises(ValidationError, match="unknown placeholder"):
            make_spec(tmp_path, argv=["{python}", "{shell_command}"])

    def test_rejects_undeclared_weight_roles(self, tmp_path: Path) -> None:
        with pytest.raises(ValidationError, match="undeclared weight"):
            make_spec(tmp_path, argv=["{python}", "{weight:vae}"])

    def test_render_argv_substitutes_per_argument_without_a_shell(self) -> None:
        values = {"python": "/py", "output_dir": "/work/out dir", "weight:dit": "/w/dit.pth"}

        argv = render_argv(["{python}", "--out={output_dir}", "{weight:dit}"], values)

        assert argv == ["/py", "--out=/work/out dir", "/w/dit.pth"]

    def test_render_argv_refuses_a_missing_value(self) -> None:
        with pytest.raises(RestorationFailure) as error:
            render_argv(["{seed}"], {})

        assert error.value.code == RestorationErrorCode.RUNTIME_FAILED

    def test_example_files_load_and_serve_nothing(self) -> None:
        registry = RestorationRegistry(
            EXAMPLES / "models.example.json",
            EXAMPLES / "qualification.example.json",
            gpu_query=lambda: [GPU],
            container_revision=IMAGE_REVISION,
        )

        report = registry.refresh()

        assert report.configurationProblems == []
        assert {model.id for model in report.models} == {"realbasicvsr-x4", "seedvr2-3b"}
        assert all(model.state == ModelState.NOT_PINNED for model in report.models)
        assert all(model.fingerprint is None for model in report.models)
        assert report.workloads == []


class TestWeightVerifier:
    def test_detects_a_replaced_weight(self, tmp_path: Path) -> None:
        (tmp_path / "generator.pth").write_bytes(b"generator")
        (tmp_path / "spynet.pth").write_bytes(b"spynet")
        spec = make_spec(tmp_path)
        verifier = WeightVerifier()

        assert verifier.verify(spec, tmp_path).verified

        (tmp_path / "generator.pth").write_bytes(b"a different generator")
        status = verifier.verify(spec, tmp_path)

        assert not status.verified
        assert status.mismatched and "generator" in status.mismatched[0]

    def test_reports_missing_weights(self, tmp_path: Path) -> None:
        status = WeightVerifier().verify(make_spec(tmp_path), tmp_path)

        assert len(status.missing) == 2


class TestRegistry:
    def write_config(self, tmp_path: Path, spec: ModelSpec, record: QualificationRecord | None) -> RestorationRegistry:
        (tmp_path / "generator.pth").write_bytes(b"generator")
        (tmp_path / "spynet.pth").write_bytes(b"spynet")
        manifest = {"schemaVersion": 1, "weightsRoot": str(tmp_path), "models": [spec.model_dump(mode="json")]}
        (tmp_path / "models.json").write_text(json.dumps(manifest))
        records = [record.model_dump(mode="json")] if record else []
        (tmp_path / "qualification.json").write_text(json.dumps({"schemaVersion": 1, "records": records}))
        return RestorationRegistry(
            tmp_path / "models.json",
            tmp_path / "qualification.json",
            gpu_query=lambda: [GPU],
            runtime_inspector=lambda _: CLEAN,
            container_revision=IMAGE_REVISION,
        )

    def test_serves_the_workload_only_for_an_available_model(self, tmp_path: Path) -> None:
        spec = make_spec(tmp_path)
        registry = self.write_config(tmp_path, spec, passing_record(spec))

        report = registry.refresh()

        assert report.workloads == ["restoration-faithful"]
        assert registry.select(RestorationMode.FAITHFUL, None, None).spec.id == spec.id

    def test_without_evidence_serves_nothing_and_refuses_requests(self, tmp_path: Path) -> None:
        spec = make_spec(tmp_path)
        registry = self.write_config(tmp_path, spec, None)

        assert registry.refresh().workloads == []
        with pytest.raises(RestorationFailure) as error:
            registry.select(RestorationMode.FAITHFUL, None, None)

        assert error.value.code == RestorationErrorCode.MODEL_UNAVAILABLE

    def test_refuses_a_full_render_when_the_model_changed_since_the_preview(self, tmp_path: Path) -> None:
        spec = make_spec(tmp_path)
        registry = self.write_config(tmp_path, spec, passing_record(spec))

        with pytest.raises(RestorationFailure) as error:
            registry.select(RestorationMode.FAITHFUL, None, "f" * 64)

        assert error.value.code == RestorationErrorCode.MODEL_CHANGED
        assert registry.select(RestorationMode.FAITHFUL, None, model_fingerprint(spec)).spec.id == spec.id

    def test_catches_a_weight_replaced_after_the_last_report(self, tmp_path: Path) -> None:
        spec = make_spec(tmp_path)
        registry = self.write_config(tmp_path, spec, passing_record(spec))
        registry.refresh()

        (tmp_path / "spynet.pth").write_bytes(b"tampered spynet weights")

        with pytest.raises(RestorationFailure) as error:
            registry.select(RestorationMode.FAITHFUL, None, None)
        assert error.value.code == RestorationErrorCode.MODEL_UNAVAILABLE
        assert "weights-mismatch" in error.value.message

    def test_does_not_offer_a_mode_it_has_no_model_for(self, tmp_path: Path) -> None:
        spec = make_spec(tmp_path)
        registry = self.write_config(tmp_path, spec, passing_record(spec))

        with pytest.raises(RestorationFailure) as error:
            registry.select(RestorationMode.CREATIVE, None, None)

        assert error.value.code == RestorationErrorCode.MODEL_UNAVAILABLE

    def test_reports_a_missing_manifest(self, tmp_path: Path) -> None:
        registry = RestorationRegistry(tmp_path / "missing.json", tmp_path / "missing-too.json", gpu_query=lambda: [])

        report = registry.report()

        assert report.models == []
        assert report.workloads == []
        assert len(report.configurationProblems) == 2

    def test_models_are_verifying_before_the_first_refresh(self, tmp_path: Path) -> None:
        spec = make_spec(tmp_path)
        registry = self.write_config(tmp_path, spec, passing_record(spec))

        report = registry.report()

        assert [model.state for model in report.models] == [ModelState.VERIFYING]
        assert report.workloads == []


def write_frames(directory: Path, count: int, size: tuple[int, int], *, blank_at: int | None = None) -> list[Path]:
    directory.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    paths: list[Path] = []
    for index in range(1, count + 1):
        pixels = (
            np.zeros((size[1], size[0], 3), dtype=np.uint8)
            if index == blank_at
            else rng.integers(0, 255, (size[1], size[0], 3), dtype=np.uint8)
        )
        path = directory / f"{index:08d}.png"
        Image.fromarray(pixels).save(path)
        paths.append(path)
    return paths


class TestMedia:
    @pytest.mark.parametrize(
        ("source", "scale", "box", "expected"),
        [
            ((1920, 1080), 2, (3840, 2160), (3840, 2160)),
            ((1280, 720), 2, (3840, 2160), (2560, 1440)),
            ((3000, 2000), 2, (3840, 2160), (3240, 2160)),
            ((1080, 1920), 2, (2160, 3840), (2160, 3840)),
            ((1080, 1920), 2, (3840, 2160), (1214, 2160)),
            ((721, 405), 1, (3840, 2160), (720, 404)),
            ((640, 480), 4, (3840, 2160), (2560, 1920)),
        ],
    )
    def test_target_geometry_scales_and_fits_the_box(
        self, source: tuple[int, int], scale: int, box: tuple[int, int], expected: tuple[int, int]
    ) -> None:
        assert media.target_geometry(source[0], source[1], scale, box[0], box[1]) == expected

    def test_parse_probe_reads_a_still_without_rate_or_duration(self) -> None:
        probe = media.parse_probe(
            {"streams": [{"codec_type": "video", "width": 800, "height": 600, "pix_fmt": "rgb48be"}]}, still=True
        )

        assert (probe.width, probe.height, probe.duration_ms, probe.frame_rate) == (800, 600, 0, Fraction(1, 1))
        assert probe.bit_depth == 16

    def test_parse_probe_reads_a_constant_rate_sdr_source(self) -> None:
        probe = media.parse_probe(
            {
                "streams": [
                    {
                        "codec_type": "video",
                        "width": 640,
                        "height": 360,
                        "r_frame_rate": "30000/1001",
                        "avg_frame_rate": "30000/1001",
                        "pix_fmt": "yuv420p",
                        "color_primaries": "bt709",
                        "duration": "5.005",
                    },
                    {"codec_type": "audio", "codec_name": "aac"},
                    {"codec_type": "audio", "codec_name": "pcm_s16le"},
                ]
            }
        )

        assert probe.frame_rate == Fraction(30000, 1001)
        assert not probe.variable_frame_rate
        assert probe.dynamic_range == DynamicRange.SDR
        assert probe.bit_depth == 8
        assert probe.audio_streams == 2
        assert probe.audio_codecs == ("aac", "pcm_s16le")
        assert probe.yuv_matrix == "bt601"
        assert probe.duration_ms == 5005

    def test_parse_probe_recognises_hdr_high_bit_depth_and_variable_rate(self) -> None:
        probe = media.parse_probe(
            {
                "streams": [
                    {
                        "codec_type": "video",
                        "width": 3840,
                        "height": 2160,
                        "r_frame_rate": "30/1",
                        "avg_frame_rate": "24/1",
                        "pix_fmt": "yuv420p10le",
                        "color_transfer": "arib-std-b67",
                    }
                ],
                "format": {"duration": "3.0"},
            }
        )

        assert probe.dynamic_range == DynamicRange.HDR
        assert probe.bit_depth == 10
        assert probe.variable_frame_rate

    def test_parse_probe_refuses_media_without_video(self) -> None:
        with pytest.raises(media.MediaError) as error:
            media.parse_probe({"streams": [{"codec_type": "audio"}], "format": {"duration": "1"}})

        assert error.value.unsupported

    def test_validate_output_frames_accepts_matching_frames(self, tmp_path: Path) -> None:
        source = write_frames(tmp_path / "source", 3, (8, 6))
        output = write_frames(tmp_path / "output", 3, (32, 24))

        assert media.validate_output_frames(source, output, expected_size=(32, 24)) == (32, 24)

    def test_validate_output_frames_refuses_a_changed_frame_count(self, tmp_path: Path) -> None:
        source = write_frames(tmp_path / "source", 3, (8, 6))
        output = write_frames(tmp_path / "output", 2, (32, 24))

        with pytest.raises(media.MediaError, match="2 frames for 3"):
            media.validate_output_frames(source, output, expected_size=None)

    def test_validate_output_frames_refuses_an_unexpected_size(self, tmp_path: Path) -> None:
        source = write_frames(tmp_path / "source", 2, (8, 6))
        output = write_frames(tmp_path / "output", 2, (16, 12))

        with pytest.raises(media.MediaError, match="expected 32x24"):
            media.validate_output_frames(source, output, expected_size=(32, 24))

    def test_validate_output_frames_refuses_blank_frames_from_nan_output(self, tmp_path: Path) -> None:
        source = write_frames(tmp_path / "source", 3, (8, 6))
        output = write_frames(tmp_path / "output", 3, (32, 24), blank_at=2)

        with pytest.raises(media.MediaError, match="suspected NaN"):
            media.validate_output_frames(source, output, expected_size=None)

    def test_ffmpeg_arguments_work_on_ffmpeg_4_and_keep_the_source_matrix(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls: list[list[str]] = []
        monkeypatch.setattr(media, "_run", lambda args, timeout: calls.append(args))
        monkeypatch.setattr(media, "count_frames", lambda _: 3)
        probe = source_probe(color_space="bt709", height=720, width=1280)

        media.extract_frames(
            tmp_path / "in.mp4", tmp_path / "frames", start_ms=None, end_ms=None, yuv_matrix="bt709", timeout=5
        )
        copied = media.encode_output(
            tmp_path / "frames",
            tmp_path / "out.mp4",
            source=tmp_path / "in.mp4",
            source_probe=probe,
            target=(2560, 1440),
            start_ms=None,
            end_ms=None,
            timeout=5,
        )
        transcoded = media.encode_output(
            tmp_path / "frames",
            tmp_path / "out2.mp4",
            source=tmp_path / "in.mp4",
            source_probe=source_probe(audio_codecs=("pcm_s16le",)),
            target=(1280, 720),
            start_ms=1000,
            end_ms=6000,
            timeout=5,
        )

        extract, encode_copy, encode_transcode = calls
        assert "-fps_mode" not in extract and "-vsync" in extract
        assert "scale=in_color_matrix=bt709:in_range=auto,format=rgb24" in extract
        assert any("out_color_matrix=bt709" in argument for argument in encode_copy)
        assert copied == "copied" and encode_copy[encode_copy.index("-c:a") + 1] == "copy"
        assert transcoded == "transcoded" and encode_transcode[encode_transcode.index("-c:a") + 1] == "aac"
        assert ["-ss", "1.000", "-t", "5.000"] == encode_transcode[
            encode_transcode.index("-ss") : encode_transcode.index("-ss") + 4
        ]

    def test_parse_gpu_query_and_memory(self) -> None:
        gpus = parse_gpu_query("NVIDIA GeForce RTX 4090, 24564, 550.54.14\nbroken line\n")

        assert gpus == [
            GpuDescription(
                name="NVIDIA GeForce RTX 4090", memoryTotalBytes=24564 * 1024 * 1024, driverVersion="550.54.14"
            )
        ]
        assert parse_memory_used("1024\n2048\n") == 2048 * 1024 * 1024
        assert parse_memory_used("") is None


class TestRuntime:
    def test_classifies_out_of_memory(self) -> None:
        failure = classify_runtime_failure(1, "Traceback...\ntorch.OutOfMemoryError: CUDA out of memory.")

        assert failure.code == RestorationErrorCode.OUT_OF_MEMORY

    def test_classifies_other_failures(self) -> None:
        failure = classify_runtime_failure(2, "ImportError: no module named mmedit")

        assert failure.code == RestorationErrorCode.RUNTIME_FAILED
        assert "mmedit" in failure.message

    def test_realbasicvsr_adapter_runs_the_pinned_runtime_offline_at_x4(self, tmp_path: Path) -> None:
        spec = make_spec(tmp_path)
        source_frames = tmp_path / "work" / "source-frames"
        write_frames(source_frames, 2, (8, 6))
        calls: list[RuntimeInvocation] = []

        def runner(invocation: RuntimeInvocation) -> RuntimeOutcome:
            calls.append(invocation)
            write_frames(Path(invocation.argv[4]), 2, (32, 24))
            return RuntimeOutcome(duration_ms=500, peak_vram_bytes=None)

        job = RuntimeJob(
            work_dir=tmp_path / "work",
            source_frames=source_frames,
            frame_count=2,
            frame_rate="30/1",
            source_size=(8, 6),
            target_size=(16, 12),
            seed=0,
        )
        run = RealBasicVsrAdapter(spec, tmp_path / "weights", runner).run(job)

        assert isinstance(run, AdapterRun)
        assert run.expected_size == (32, 24)
        assert run.runtime_ms == 500
        argv = calls[0].argv
        assert argv[2] == str(tmp_path / "weights" / "generator.pth")
        assert argv[3] == str(source_frames)
        assert argv[5] == "--max_seq_len=30"
        assert calls[0].env["HF_HUB_OFFLINE"] == "1"
        assert "IMMICH_ML_AUTH_TOKEN" not in calls[0].env
        assert calls[0].cwd == spec.runtime.root


def request_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "protocol": "restoration-v1",
        "requestId": "job-1",
        "mode": "faithful",
        "scale": 2,
        "source": {
            "width": 640,
            "height": 360,
            "frameRate": "30/1",
            "durationMs": 5000,
        },
    }
    payload.update(overrides)
    return payload


def source_probe(**overrides: Any) -> media.SourceProbe:
    values: dict[str, Any] = {
        "width": 640,
        "height": 360,
        "frame_rate": Fraction(30, 1),
        "variable_frame_rate": False,
        "duration_ms": 5000,
        "dynamic_range": DynamicRange.SDR,
        "bit_depth": 8,
        "audio_codecs": ("aac",),
        "color_primaries": None,
        "color_transfer": None,
        "color_space": None,
    }
    values.update(overrides)
    return media.SourceProbe(**values)


class TestSourceChecks:
    def selected(self, tmp_path: Path) -> SelectedModel:
        spec = make_spec(tmp_path)
        return SelectedModel(spec=spec, capability=evaluate(spec), weights_root=tmp_path)

    def test_checks_the_segment_against_the_upload(self, tmp_path: Path) -> None:
        request = RestorationRequest.model_validate(request_payload(segment={"startMs": 1000, "endMs": 6000}))

        with pytest.raises(RestorationFailure) as error:
            check_source(request, source_probe(), self.selected(tmp_path))
        assert error.value.code == RestorationErrorCode.INVALID_REQUEST

        request = RestorationRequest.model_validate(request_payload(segment={"startMs": 0, "endMs": 5000}))
        assert check_source(request, source_probe(), self.selected(tmp_path)) == (0, 5000, 150)

    @pytest.mark.parametrize(
        ("probe", "code"),
        [
            (source_probe(width=1280, height=720), RestorationErrorCode.SOURCE_MISMATCH),
            (source_probe(frame_rate=Fraction(25, 1)), RestorationErrorCode.SOURCE_MISMATCH),
            (source_probe(duration_ms=9000), RestorationErrorCode.SOURCE_MISMATCH),
            (source_probe(dynamic_range=DynamicRange.HDR), RestorationErrorCode.UNSUPPORTED_INPUT),
            (source_probe(bit_depth=10), RestorationErrorCode.UNSUPPORTED_INPUT),
            (source_probe(variable_frame_rate=True), RestorationErrorCode.UNSUPPORTED_INPUT),
        ],
    )
    def test_refuses_mismatched_or_unqualified_sources(
        self, tmp_path: Path, probe: media.SourceProbe, code: RestorationErrorCode
    ) -> None:
        request = RestorationRequest.model_validate(request_payload())

        with pytest.raises(RestorationFailure) as error:
            check_source(request, probe, self.selected(tmp_path))

        assert error.value.code == code

    def test_refuses_sources_larger_than_the_qualified_input(self, tmp_path: Path) -> None:
        request = RestorationRequest.model_validate(
            request_payload(source={**request_payload()["source"], "width": 1920, "height": 1080})
        )

        with pytest.raises(RestorationFailure) as error:
            check_source(request, source_probe(width=1920, height=1080), self.selected(tmp_path))

        assert error.value.code == RestorationErrorCode.UNSUPPORTED_INPUT

    def test_checks_a_still_by_size_only(self, tmp_path: Path) -> None:
        still = {"width": 640, "height": 360}
        request = RestorationRequest.model_validate(request_payload(kind="image", source=still))

        probe = source_probe(frame_rate=Fraction(1, 1), duration_ms=0)

        assert check_source(request, probe, self.selected(tmp_path)) == (None, None, 1)
        with pytest.raises(RestorationFailure) as error:
            check_source(request, source_probe(width=641), self.selected(tmp_path))
        assert error.value.code == RestorationErrorCode.SOURCE_MISMATCH

    def test_request_contract_limits_scale_box_and_kind(self) -> None:
        assert RestorationRequest.model_validate(request_payload(scale=4)).scale == 4
        with pytest.raises(ValidationError):
            RestorationRequest.model_validate(request_payload(scale=3))
        with pytest.raises(ValidationError):
            RestorationRequest.model_validate(request_payload(maxWidth=7680))
        with pytest.raises(ValidationError):
            RestorationRequest.model_validate(request_payload(segment={"startMs": 5000, "endMs": 1000}))
        with pytest.raises(ValidationError):
            RestorationRequest.model_validate(request_payload(source={"width": 640, "height": 360}))
        with pytest.raises(ValidationError):
            RestorationRequest.model_validate(
                request_payload(kind="image", source={"width": 640, "height": 360}, segment={"startMs": 0, "endMs": 1})
            )


def fake_result(output: Path) -> RestorationResult:
    content = output.read_bytes()
    return RestorationResult(
        protocol="restoration-v1",
        requestId="job-1",
        mode=RestorationMode.FAITHFUL,
        model=ModelIdentity(
            id="realbasicvsr-test",
            family="realbasicvsr",
            mode=RestorationMode.FAITHFUL,
            revision=COMMIT,
            fingerprint="a" * 64,
            weights=[WeightIdentity(role="generator", sha256="b" * 64)],
            qualificationId="realbasicvsr-test-qualified",
        ),
        output=OutputDescription(
            width=1280,
            height=720,
            frameRate="30/1",
            frameCount=150,
            durationMs=5000,
            container="mp4",
            codec="h264",
            dynamicRange=DynamicRange.SDR,
            bitDepth=8,
            audio="copied",
            bytes=len(content),
            sha256=sha(content),
        ),
        timing=RestorationTiming(decodeMs=10, runtimeMs=1000, encodeMs=20, totalMs=1100, framesPerSecond=150.0),
        peakVramBytes=None,
        seed=0,
        warnings=[],
    )


class TestWorkerApp:
    def client(self, tmp_path: Path, *, token: str | None = None) -> TestClient:
        registry = RestorationRegistry(tmp_path / "models.json", tmp_path / "qualification.json", gpu_query=lambda: [])
        work_root = tmp_path / "work"
        work_root.mkdir()
        return TestClient(create_app(registry, work_root=work_root, auth_token=token, refresh_on_startup=False))

    def test_unqualified_worker_serves_no_restoration_workload(self, tmp_path: Path) -> None:
        client = self.client(tmp_path)

        assert client.get("/ping").text == "pong"
        assert client.get("/capabilities").json() == {"protocol": "restoration-v1", "workloads": []}
        models = client.get("/restoration/models").json()
        assert models["workloads"] == []
        assert models["configurationProblems"]

    def test_requires_the_bearer_token_except_for_health(self, tmp_path: Path) -> None:
        client = self.client(tmp_path, token="worker-token")

        assert client.get("/ping").status_code == 200
        assert client.get("/capabilities").status_code == 401
        assert client.post("/restoration/restore").status_code == 401
        assert client.get("/capabilities", headers={"Authorization": "Bearer worker-token"}).status_code == 200

    def test_rejects_an_invalid_request(self, tmp_path: Path) -> None:
        response = self.client(tmp_path).post(
            "/restoration/restore",
            data={"request": json.dumps(request_payload(scale=3))},
            files={"media": ("clip.mp4", b"video", "video/mp4")},
        )

        assert response.status_code == 422
        assert response.json()["code"] == "invalid-request"

    def test_refuses_when_no_model_is_available(self, tmp_path: Path) -> None:
        response = self.client(tmp_path).post(
            "/restoration/restore",
            data={"request": json.dumps(request_payload())},
            files={"media": ("clip.mp4", b"video", "video/mp4")},
        )

        assert response.status_code == 409
        assert response.json()["code"] == "model-unavailable"
        assert list((tmp_path / "work").iterdir()) == []

    def test_streams_the_restored_file_with_the_result_header(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        uploads: list[bytes] = []

        def fake_restore(
            registry: RestorationRegistry, request: RestorationRequest, media_path: Path, work_dir: Path, **_: Any
        ) -> tuple[RestorationResult, Path]:
            uploads.append(media_path.read_bytes())
            output = work_dir / "restored.mp4"
            output.write_bytes(b"restored video bytes")
            return fake_result(output), output

        monkeypatch.setattr("immich_ml.video_restoration.app.restore", fake_restore)

        response = self.client(tmp_path).post(
            "/restoration/restore",
            data={"request": json.dumps(request_payload())},
            files={"media": ("clip.mp4", b"original video", "video/mp4")},
        )

        assert response.status_code == 200
        assert response.content == b"restored video bytes"
        assert uploads == [b"original video"]
        header = response.headers[RESULT_HEADER]
        decoded = json.loads(base64.urlsafe_b64decode(header + "=" * (-len(header) % 4)))
        assert decoded["output"]["sha256"] == sha(b"restored video bytes")
        assert decoded["model"]["qualificationId"] == "realbasicvsr-test-qualified"
        # The working directory, upload included, is gone once the file has been streamed.
        assert list((tmp_path / "work").iterdir()) == []


def test_reviewed_dates_parse_as_dates(tmp_path: Path) -> None:
    record = passing_record(make_spec(tmp_path))

    assert record.reviewedAt == date(2026, 9, 1)
