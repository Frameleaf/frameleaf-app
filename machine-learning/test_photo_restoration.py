"""FL-933: the photo repair and colourise workloads of the restoration worker.

The models are faked: these tests cover the adapters, the qualification gate, the wire contract,
the still pipeline (size and orientation) and the image maths of the two runtimes. What they
cannot show (model quality, GPU memory, speed) is qualification evidence recorded on hardware.
"""

import hashlib
import json
import runpy
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pytest
from PIL import Image
from pydantic import ValidationError

from frameleaf_ml.video_restoration import media
from frameleaf_ml.video_restoration.app import upload_limit
from frameleaf_ml.video_restoration.models import (
    PHOTO_REPORT,
    REQUIRED_EVIDENCE,
    RUNTIME_REFUSED_INPUT_EXIT,
    DdColorAdapter,
    LamaRepairAdapter,
    Manifest,
    ModelSpec,
    QualificationFile,
    QualificationRecord,
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
    inspect_runtime,
)
from frameleaf_ml.video_restoration.pipeline import restore
from frameleaf_ml.video_restoration.schemas import (
    WORKLOAD_BY_MODE,
    GpuDescription,
    ModelState,
    PhotoOperation,
    RestorationErrorCode,
    RestorationRequest,
)

HERE = Path(__file__).parent
EXAMPLES = HERE / "video-restoration"
REPAIR = runpy.run_path(str(EXAMPLES / "runtimes" / "photo_repair.py"))
COLOURISE = runpy.run_path(str(EXAMPLES / "runtimes" / "colourise.py"))
COMMIT = "0123456789abcdef0123456789abcdef01234567"
IMAGE_REVISION = "image-rev-1"
GPU = GpuDescription(name="Qualified GPU", memoryTotalBytes=12 * 1024**3, driverVersion="550.0")
CLEAN = RuntimeStatus(present=True, clean=True)
FRAME = "00000001.png"
ROLES = {"lama-repair": ["detection", "lama"], "ddcolor": ["ddcolor"]}
OPERATIONS = {"lama-repair": "repair", "ddcolor": "colourise"}
needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="ffmpeg is not installed"
)


def photo_spec(tmp_path: Path, family: str = "lama-repair", **overrides: Any) -> ModelSpec:
    payload: dict[str, Any] = {
        "id": f"{family}-test",
        "family": family,
        "operation": OPERATIONS[family],
        "displayName": "Test photo model",
        "repository": "https://example.invalid/model",
        "revision": COMMIT,
        "runtime": {
            "root": str(tmp_path / "runtime"),
            "python": str(tmp_path / "runtime" / "python"),
            "argv": ["{python}", "-I", "run.py", "--input-dir", "{input_dir}", "--output-dir", "{output_dir}"],
        },
        "weights": [
            {"role": role, "path": f"{role}.bin", "sha256": f"{index + 1:x}" * 64}
            for index, role in enumerate(ROLES[family])
        ],
        "limits": {"maxInputLongEdge": 8192, "maxFrames": 1, "maxFramesPerChunk": 1, "minVramBytes": 8 * 1024**3},
    }
    payload.update(overrides)
    return ModelSpec.model_validate(payload)


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
                "inputWidth": 4800,
                "inputHeight": 6000,
                "frames": 1,
                "framesPerSecond": 0.1,
                "peakVramBytes": 5 * 1024**3,
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
            "reviewedAt": "2026-10-17",
        },
        "reviewedBy": "qualifier",
        "reviewedAt": "2026-11-22",
    }
    payload.update(overrides)
    return QualificationRecord.model_validate(payload)


def make_registry(
    tmp_path: Path, specs: list[ModelSpec], records: list[QualificationRecord], gpus: list[GpuDescription] | None = None
) -> RestorationRegistry:
    for spec in specs:
        for weight in spec.weights:
            (tmp_path / weight.path).write_bytes(weight.role.encode())
    manifest = {
        "schemaVersion": 1,
        "weightsRoot": str(tmp_path),
        "models": [spec.model_dump(mode="json") for spec in specs],
    }
    (tmp_path / "models.json").write_text(json.dumps(manifest))
    (tmp_path / "qualification.json").write_text(
        json.dumps({"schemaVersion": 1, "records": [record.model_dump(mode="json") for record in records]})
    )

    class Verified:
        def verify(self, spec: ModelSpec, weights_root: Path) -> WeightStatus:
            return WeightStatus()

    return RestorationRegistry(
        tmp_path / "models.json",
        tmp_path / "qualification.json",
        gpu_query=lambda: [GPU] if gpus is None else gpus,
        runtime_inspector=lambda _: CLEAN,
        verifier=Verified(),  # type: ignore[arg-type]
        container_revision=IMAGE_REVISION,
    )


class TestManifest:
    def test_example_entries_load_and_serve_nothing(self) -> None:
        registry = RestorationRegistry(
            EXAMPLES / "models.example.json",
            EXAMPLES / "qualification.example.json",
            gpu_query=lambda: [GPU],
            container_revision=IMAGE_REVISION,
        )

        report = registry.refresh()

        assert report.configurationProblems == []
        assert {model.id: model.operation for model in report.photoModels} == {
            "lama-photo-repair": PhotoOperation.REPAIR,
            "ddcolor-colourise": PhotoOperation.COLOURISE,
        }
        assert all(model.state == ModelState.NOT_PINNED for model in report.photoModels)
        assert all(model.operation is None for model in report.models)
        assert report.workloads == []

    def test_example_records_ask_for_exactly_the_required_evidence(self) -> None:
        manifest = Manifest.model_validate(json.loads((EXAMPLES / "models.example.json").read_text()))
        records = QualificationFile.model_validate(json.loads((EXAMPLES / "qualification.example.json").read_text()))
        by_model = {record.modelId: record for record in records.records}

        for spec in manifest.models:
            if spec.operation is None:
                continue
            record = by_model[spec.id]
            assert {evidence.item for evidence in record.evidence} == REQUIRED_EVIDENCE[spec.family]
            assert [weight.role for weight in record.weights] == [weight.role for weight in spec.weights]
            assert all(weight.source is not None for weight in spec.weights)
            assert spec.limits.maxInputLongEdge == 8192 and spec.requiresGpu

    def test_weights_come_from_the_frameleaf_model_source_only(self) -> None:
        text = (EXAMPLES / "models.example.json").read_text()
        photo = text[text.index('"lama-photo-repair"') :]

        assert "huggingface" not in photo and "modelscope.cn" not in photo and "releases/download" not in photo

    @pytest.mark.parametrize(
        "overrides",
        [
            {"requiresGpu": False},
            {"mode": "faithful"},
            {"operation": "colourise"},
            {"operation": None, "mode": "faithful"},
            {"nativeScale": 2},
            {"limits": {"maxInputLongEdge": 8192, "maxFrames": 2, "maxFramesPerChunk": 1, "minVramBytes": 0}},
            {"weights": [{"role": "lama", "path": "lama.bin", "sha256": "1" * 64}]},
        ],
    )
    def test_refuses_a_photo_model_that_is_not_gpu_only_stills(self, tmp_path: Path, overrides: dict[str, Any]) -> None:
        with pytest.raises(ValidationError):
            photo_spec(tmp_path, **overrides)

    def test_refuses_the_cpu_switch_in_a_manifest(self, tmp_path: Path) -> None:
        runtime = {"root": "/r", "python": "/r/python", "argv": ["{python}", "run.py", "--allow-cpu"]}

        with pytest.raises(ValidationError, match="invalid photo runtime"):
            photo_spec(tmp_path, runtime=runtime)

    def test_a_restoration_family_cannot_claim_an_operation(self, tmp_path: Path) -> None:
        with pytest.raises(ValidationError, match="does not serve"):
            ModelSpec.model_validate({**photo_spec(tmp_path).model_dump(mode="json"), "family": "rife"})


class TestGate:
    @pytest.mark.parametrize(("family", "workload"), [("lama-repair", "photo-repair"), ("ddcolor", "colourise")])
    def test_lists_the_workload_only_with_a_passing_record(self, tmp_path: Path, family: str, workload: str) -> None:
        spec = photo_spec(tmp_path, family)

        qualified = make_registry(tmp_path, [spec], [passing_record(spec)]).refresh()
        assert qualified.workloads == [workload]
        assert [model.state for model in qualified.photoModels] == [ModelState.AVAILABLE]
        # A server that predates the photo workloads reads only ``models``: nothing there may change.
        assert qualified.models == []

        for record in ([], [passing_record(spec, reviewedBy=None)], [passing_record(spec, revision="f" * 40)]):
            unqualified = make_registry(tmp_path, [spec], record).refresh()
            assert unqualified.workloads == []
            assert [model.state for model in unqualified.photoModels] == [ModelState.UNQUALIFIED]

    def test_one_pending_evidence_item_keeps_the_workload_out(self, tmp_path: Path) -> None:
        spec = photo_spec(tmp_path, "ddcolor")
        evidence = [
            {"item": item, "result": "pending" if item == "colour-plausibility" else "pass", "artifact": "run 1"}
            for item in REQUIRED_EVIDENCE["ddcolor"]
        ]

        report = make_registry(tmp_path, [spec], [passing_record(spec, evidence=evidence)]).refresh()

        assert report.workloads == []
        assert "evidence colour-plausibility is pending" in report.photoModels[0].reasons

    def test_without_a_gpu_the_workload_is_refused_with_the_reason(self, tmp_path: Path) -> None:
        spec = photo_spec(tmp_path)
        registry = make_registry(tmp_path, [spec], [passing_record(spec)], gpus=[])

        report = registry.refresh()
        assert report.workloads == []
        assert report.photoModels[0].state == ModelState.NO_GPU
        assert report.photoModels[0].reasons == ["no NVIDIA GPU is visible to the worker"]
        with pytest.raises(RestorationFailure) as error:
            registry.select(None, None, None, kind="image", operation=PhotoOperation.REPAIR)
        assert error.value.code == RestorationErrorCode.MODEL_UNAVAILABLE
        assert "no NVIDIA GPU is visible to the worker" in error.value.message

    def test_an_unqualified_gpu_or_too_little_memory_is_refused(self, tmp_path: Path) -> None:
        spec = photo_spec(tmp_path)
        other = GpuDescription(name="Another GPU", memoryTotalBytes=12 * 1024**3, driverVersion="550.0")
        small = GpuDescription(name=GPU.name, memoryTotalBytes=6 * 1024**3, driverVersion="550.0")

        for gpu, state in ((other, ModelState.GPU_UNQUALIFIED), (small, ModelState.INSUFFICIENT_VRAM)):
            capability = evaluate_model(
                spec,
                runtime=CLEAN,
                weights=WeightStatus(),
                records=[passing_record(spec)],
                gpus=[gpu],
                container_revision=IMAGE_REVISION,
            )
            assert capability.state == state

    @pytest.mark.parametrize("family", ["lama-repair", "ddcolor"])
    def test_a_changed_weight_is_found_by_its_hash(self, tmp_path: Path, family: str) -> None:
        contents = {role: f"weight {role}".encode() for role in ROLES[family]}
        weights = [
            {"role": role, "path": f"{role}.bin", "sha256": hashlib.sha256(data).hexdigest()}
            for role, data in contents.items()
        ]
        spec = photo_spec(tmp_path, family, weights=weights)
        for role, data in contents.items():
            (tmp_path / f"{role}.bin").write_bytes(data)
        assert WeightVerifier().verify(spec, tmp_path).verified

        (tmp_path / f"{ROLES[family][0]}.bin").write_bytes(b"changed")

        status = WeightVerifier().verify(spec, tmp_path)
        assert not status.verified and ROLES[family][0] in status.mismatched[0]

    def test_a_modified_checkout_is_not_clean(self, tmp_path: Path) -> None:
        root = tmp_path / "runtime"
        root.mkdir()
        (root / "python").write_text("interpreter")
        git = ["git", "-C", str(root), "-c", "user.name=test", "-c", "user.email=test@example.invalid"]
        subprocess.run([*git, "init", "-q"], check=True)
        subprocess.run([*git, "add", "python"], check=True)
        subprocess.run([*git, "commit", "-q", "-m", "pinned"], check=True)
        head = subprocess.run([*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
        spec = photo_spec(tmp_path, revision=head)
        assert inspect_runtime(spec).clean

        (root / "python").write_text("modified")

        status = inspect_runtime(spec)
        assert not status.clean and "modified tracked files" in status.problems[0]

    def test_modes_and_operations_never_answer_for_each_other(self, tmp_path: Path) -> None:
        repair, colour = photo_spec(tmp_path), photo_spec(tmp_path, "ddcolor")
        registry = make_registry(tmp_path, [repair, colour], [passing_record(repair), passing_record(colour)])

        assert registry.refresh().workloads == ["photo-repair", "colourise"]
        assert not set(registry.report().workloads) & set(WORKLOAD_BY_MODE.values())
        assert registry.select(None, None, None, kind="image", operation=PhotoOperation.COLOURISE).spec.id == colour.id
        for mode in WORKLOAD_BY_MODE:
            with pytest.raises(RestorationFailure):
                registry.select(mode, None, None, kind="image")
        assert upload_limit(registry) >= 8192 * 8192 * 3


class TestSignedOffRecords:
    """The committed records from run 1296, through the real gate."""

    RUNNER_GPU = GpuDescription(name="NVIDIA GeForce RTX 3060", memoryTotalBytes=12 * 1024**3, driverVersion="610.88")

    def signed(self, tmp_path: Path) -> tuple[list[ModelSpec], list[QualificationRecord]]:
        folder = EXAMPLES / "qualification"
        manifest = Manifest.model_validate(json.loads((folder / "models.qualified.photo.json").read_text()))
        records = QualificationFile.model_validate(json.loads((folder / "qualification.photo.json").read_text()))
        specs = [
            spec.model_copy(
                update={
                    "weights": [
                        weight.model_copy(update={"path": Path(f"{weight.role}.bin")}) for weight in spec.weights
                    ]
                }
            )
            for spec in manifest.models
        ]
        return specs, records.records

    @staticmethod
    def with_open_items_closed(record: QualificationRecord) -> QualificationRecord:
        """A test-only copy naming an image revision. The committed record names none: none has run."""
        return record.model_copy(update={"containerRevisions": [IMAGE_REVISION]})

    def test_the_committed_records_are_refused_only_because_no_image_has_run(self, tmp_path: Path) -> None:
        specs, records = self.signed(tmp_path)

        report = make_registry(tmp_path, specs, records, gpus=[self.RUNNER_GPU]).refresh()

        assert report.workloads == []
        assert len(report.photoModels) == 2
        assert all(record.containerRevisions == [] for record in records)
        for model in report.photoModels:
            assert model.state == ModelState.UNQUALIFIED
            assert model.reasons == [f"worker image {IMAGE_REVISION} is not a qualified revision"]

    def test_only_the_branch_a_run_used_is_recorded(self, tmp_path: Path) -> None:
        _, records = self.signed(tmp_path)

        assert all(record.anyNvidiaGpu for record in records)
        assert {entry.driverVersion for record in records for entry in record.hardware} == {"610.88"}

    @pytest.mark.parametrize(
        ("gpu", "state", "reason"),
        [
            (None, ModelState.NO_GPU, "no NVIDIA GPU is visible"),
            (("AMD Radeon RX 7900", 16384, "610.88"), ModelState.GPU_UNQUALIFIED, "is not an NVIDIA GPU"),
            (("NVIDIA GeForce RTX 3060", 6144, "610.88"), ModelState.INSUFFICIENT_VRAM, "needs 8000000000 bytes"),
            (("NVIDIA GeForce RTX 4070", 12288, "550.54.14"), ModelState.GPU_UNQUALIFIED, "(tested: 610)"),
        ],
    )
    def test_the_gpu_policy_still_refuses(
        self, tmp_path: Path, gpu: tuple[str, int, str] | None, state: ModelState, reason: str
    ) -> None:
        specs, records = self.signed(tmp_path)
        closed = [self.with_open_items_closed(record) for record in records]
        gpus = [GpuDescription(name=gpu[0], memoryTotalBytes=gpu[1] * 1024**2, driverVersion=gpu[2])] if gpu else []

        report = make_registry(tmp_path, specs, closed, gpus=gpus).refresh()

        assert report.workloads == []
        for model in report.photoModels:
            assert model.state == state and reason in model.reasons[0]

    @pytest.mark.parametrize(("name", "mib"), [("NVIDIA GeForce RTX 4060", 8188), ("NVIDIA GeForce RTX 4090", 24576)])
    def test_the_gpu_policy_accepts_an_untested_card_on_a_tested_branch(
        self, tmp_path: Path, name: str, mib: int
    ) -> None:
        specs, records = self.signed(tmp_path)
        closed = [self.with_open_items_closed(record) for record in records]
        gpu = GpuDescription(name=name, memoryTotalBytes=mib * 1024**2, driverVersion="610.12")

        assert make_registry(tmp_path, specs, closed, gpus=[gpu]).refresh().workloads == ["photo-repair", "colourise"]

    def test_a_record_without_the_policy_keeps_the_exact_model_match(self, tmp_path: Path) -> None:
        specs, records = self.signed(tmp_path)
        exact = [self.with_open_items_closed(record).model_copy(update={"anyNvidiaGpu": False}) for record in records]
        other = GpuDescription(name="NVIDIA GeForce RTX 4090", memoryTotalBytes=24 * 1024**3, driverVersion="610.88")

        assert make_registry(tmp_path, specs, exact, gpus=[other]).refresh().workloads == []
        assert make_registry(tmp_path, specs, exact, gpus=[self.RUNNER_GPU]).refresh().workloads == [
            "photo-repair",
            "colourise",
        ]

    def test_the_policy_cannot_widen_a_workload_that_is_not_a_photo_model(self) -> None:
        spec = ModelSpec.model_validate(
            next(
                model
                for model in json.loads((EXAMPLES / "models.example.json").read_text())["models"]
                if model["family"] == "rife"
            )
            | {"revision": COMMIT}
        ).model_copy(update={"requiresGpu": True})
        spec = spec.model_copy(
            update={
                "weights": [
                    weight.model_copy(update={"sha256": f"{index + 1:x}" * 64})
                    for index, weight in enumerate(spec.weights)
                ]
            }
        )
        record = passing_record(spec, anyNvidiaGpu=True)
        other = GpuDescription(name="NVIDIA GeForce RTX 4090", memoryTotalBytes=24 * 1024**3, driverVersion="550.1")

        capability = evaluate_model(
            spec,
            runtime=CLEAN,
            weights=WeightStatus(),
            records=[record],
            gpus=[other],
            container_revision=IMAGE_REVISION,
        )

        assert capability.state == ModelState.GPU_UNQUALIFIED

    def test_with_an_image_revision_the_gate_lists_both_workloads(self, tmp_path: Path) -> None:
        specs, records = self.signed(tmp_path)
        closed = [self.with_open_items_closed(record) for record in records]

        report = make_registry(tmp_path, specs, closed, gpus=[self.RUNNER_GPU]).refresh()

        assert report.workloads == ["photo-repair", "colourise"]
        assert [model.state for model in report.photoModels] == [ModelState.AVAILABLE, ModelState.AVAILABLE]

    def test_a_record_without_a_reviewer_is_still_refused(self, tmp_path: Path) -> None:
        specs, records = self.signed(tmp_path)
        unsigned = [
            self.with_open_items_closed(record).model_copy(update={"reviewedBy": None, "reviewedAt": None})
            for record in records
        ]

        report = make_registry(tmp_path, specs, unsigned, gpus=[self.RUNNER_GPU]).refresh()

        assert report.workloads == []
        assert all(any("has not been reviewed" in reason for reason in model.reasons) for model in report.photoModels)

    def test_accepted_limits_keep_their_measured_wording(self, tmp_path: Path) -> None:
        _, records = self.signed(tmp_path)
        notes = {entry.item: entry.notes for record in records for entry in record.evidence}

        for item, limit in (("scratch-mask", "real detail marked"), ("colour-plausibility", "arbitrary")):
            assert limit in notes[item]
            assert notes[item].endswith("accepted by the owner for release on 2026-11-22, known limit")


def request(**overrides: Any) -> RestorationRequest:
    payload: dict[str, Any] = {
        "protocol": "restoration-v1",
        "requestId": "request-1",
        "operation": "repair",
        "kind": "image",
        "scale": 1,
        "source": {"width": 41, "height": 23},
    }
    payload.update(overrides)
    return RestorationRequest.model_validate(payload)


class TestWire:
    @pytest.mark.parametrize(
        "overrides",
        [{"scale": 2}, {"kind": "video"}, {"mode": "faithful"}, {"operation": None}, {"interpolationFactor": 2}],
    )
    def test_refuses_a_request_that_is_not_a_same_size_still(self, overrides: dict[str, Any]) -> None:
        with pytest.raises(ValidationError):
            request(**overrides)

    def test_a_mode_request_still_parses_without_an_operation(self) -> None:
        parsed = request(operation=None, mode="faithful", scale=2)

        assert parsed.operation is None and parsed.mode == "faithful"


def copying_runner(report: dict[str, Any] | str | None = None, *, transform: Any = None) -> Any:
    """A runtime that copies its frame (optionally changed) and leaves a report."""

    def run(invocation: RuntimeInvocation) -> RuntimeOutcome:
        arguments = invocation.argv
        source = Path(arguments[arguments.index("--input-dir") + 1]) / FRAME
        output = Path(arguments[arguments.index("--output-dir") + 1])
        with Image.open(source) as image:
            (transform(image) if transform else image).save(output / FRAME)
        if report is not None:
            (output / PHOTO_REPORT).write_text(report if isinstance(report, str) else json.dumps(report))
        return RuntimeOutcome(duration_ms=1200, peak_vram_bytes=3 * 1024**3)

    return run


def job(tmp_path: Path, **overrides: Any) -> RuntimeJob:
    frames = tmp_path / "source-frames"
    frames.mkdir()
    Image.new("RGB", (41, 23), (120, 110, 100)).save(frames / FRAME)
    values: dict[str, Any] = {
        "work_dir": tmp_path,
        "source_frames": frames,
        "frame_count": 1,
        "frame_rate": "1/1",
        "source_size": (41, 23),
        "target_size": (41, 23),
        "seed": 0,
        "kind": "image",
    }
    values.update(overrides)
    return RuntimeJob(**values)


class TestAdapters:
    @pytest.mark.parametrize(("adapter", "family"), [(LamaRepairAdapter, "lama-repair"), (DdColorAdapter, "ddcolor")])
    def test_expects_the_source_size_and_passes_the_runtime_warnings_on(
        self, tmp_path: Path, adapter: Any, family: str
    ) -> None:
        runner = copying_runner({"warnings": ["1 face(s) were too small to restore", 7], "facesFound": 1})

        run = adapter(photo_spec(tmp_path, family), tmp_path, runner).run(job(tmp_path))

        assert run.expected_size == (41, 23)
        assert run.warnings == ["1 face(s) were too small to restore"]
        assert run.peak_vram_bytes == 3 * 1024**3
        assert media.list_frames(run.frames_dir) == [run.frames_dir / FRAME]

    @pytest.mark.parametrize("report", ["not json", "[]", json.dumps({"warnings": "none"}), "x" * 20000])
    def test_ignores_a_report_it_does_not_understand(self, tmp_path: Path, report: str) -> None:
        run = LamaRepairAdapter(photo_spec(tmp_path), tmp_path, copying_runner(report)).run(job(tmp_path))

        assert run.warnings == []

    def test_refuses_a_video(self, tmp_path: Path) -> None:
        for overrides in ({"kind": "video"}, {"frame_count": 2}):
            with pytest.raises(RestorationFailure) as error:
                DdColorAdapter(photo_spec(tmp_path, "ddcolor"), tmp_path, copying_runner()).run(
                    job(tmp_path, **overrides)
                )
            assert error.value.code == RestorationErrorCode.UNSUPPORTED_INPUT
            shutil.rmtree(tmp_path / "source-frames")

    def test_the_runtime_gets_only_the_manifest_command(self, tmp_path: Path) -> None:
        seen: list[RuntimeInvocation] = []

        def runner(invocation: RuntimeInvocation) -> RuntimeOutcome:
            seen.append(invocation)
            return copying_runner()(invocation)

        LamaRepairAdapter(photo_spec(tmp_path), tmp_path, runner).run(job(tmp_path))

        assert seen[0].argv[:3] == [str(tmp_path / "runtime" / "python"), "-I", "run.py"]
        assert "--allow-cpu" not in seen[0].argv and seen[0].payload is None


@pytest.fixture
def ffmpeg_timing(monkeypatch: pytest.MonkeyPatch) -> None:
    # The image pins Ubuntu's ffmpeg 4.4; ffmpeg 9 dropped the -vsync spelling of the same mode.
    version = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True, check=True).stdout
    if int(version.split()[2].split(".")[0]) >= 9:
        monkeypatch.setattr(media, "PASSTHROUGH_TIMING", ["-fps_mode", "passthrough"])


@needs_ffmpeg
@pytest.mark.usefixtures("ffmpeg_timing")
class TestPipeline:
    def run(
        self, tmp_path: Path, upload: Path, size: tuple[int, int], family: str = "lama-repair", transform: Any = None
    ) -> Any:
        spec = photo_spec(tmp_path, family)
        registry = make_registry(tmp_path, [spec], [passing_record(spec)])
        work = tmp_path / "work"
        work.mkdir()

        def factory(selected: SelectedModel) -> Any:
            adapter = LamaRepairAdapter if family == "lama-repair" else DdColorAdapter
            return adapter(selected.spec, selected.weights_root, copying_runner({"warnings": []}, transform=transform))

        parsed = request(operation=OPERATIONS[family], source={"width": size[0], "height": size[1]})
        return restore(registry, parsed, upload, work, adapter_factory=factory)

    def test_keeps_the_exact_size_and_the_orientation_tag(self, tmp_path: Path) -> None:
        # Orientation 6: the stored grid is 41 x 23 and a viewer turns it a quarter turn. Odd sizes on
        # purpose: a restoration rounds to even numbers, a photo operation must not.
        pixels = np.repeat(np.tile(np.linspace(10, 240, 41, dtype=np.uint8), (23, 1))[..., None], 3, axis=2)
        exif = Image.Exif()
        exif[media.EXIF_ORIENTATION] = 6
        upload = tmp_path / "upload"
        Image.fromarray(pixels).save(upload, format="JPEG", quality=95, exif=exif)

        result, output = self.run(tmp_path, upload, (41, 23))

        assert (result.output.width, result.output.height) == (41, 23)
        assert result.operation == PhotoOperation.REPAIR and result.mode is None
        assert result.model.operation == PhotoOperation.REPAIR and result.model.mode is None
        assert result.output.container == "png" and result.output.frameCount == 1
        with Image.open(output) as restored:
            assert restored.size == (41, 23)
            assert restored.getexif().get(media.EXIF_ORIENTATION) == 6
            # The stored pixels are the source's, not a rotated copy of them.
            assert np.abs(np.asarray(restored.convert("RGB"), dtype=np.int16) - pixels).mean() < 12

    def test_a_photo_without_a_tag_gets_none(self, tmp_path: Path) -> None:
        upload = tmp_path / "upload"
        Image.new("RGB", (64, 48), (90, 120, 150)).save(upload, format="PNG")

        _, output = self.run(tmp_path, upload, (64, 48), family="ddcolor")

        with Image.open(output) as restored:
            assert restored.size == (64, 48) and media.EXIF_ORIENTATION not in restored.getexif()

    def test_a_greyscale_photo_comes_back_as_rgb_of_the_same_size(self, tmp_path: Path) -> None:
        upload = tmp_path / "upload"
        gradient = np.tile(np.linspace(20, 230, 57, dtype=np.uint8), (33, 1))
        Image.fromarray(gradient, mode="L").save(upload, format="JPEG", quality=95)

        result, output = self.run(tmp_path, upload, (57, 33), family="ddcolor")

        with Image.open(output) as restored:
            assert restored.size == (57, 33) and restored.mode == "RGB"
        assert result.output.bitDepth == 8

    def test_refuses_sixteen_bit_input_clearly(self, tmp_path: Path) -> None:
        upload = tmp_path / "upload"
        cv2.imwrite(str(tmp_path / "deep.png"), np.full((32, 32, 3), 40000, dtype=np.uint16))
        (tmp_path / "deep.png").rename(upload)

        with pytest.raises(RestorationFailure) as error:
            self.run(tmp_path, upload, (32, 32))

        assert error.value.code == RestorationErrorCode.UNSUPPORTED_INPUT
        assert "16-bit sources are not qualified" in error.value.message

    def test_refuses_a_runtime_that_changes_the_size(self, tmp_path: Path) -> None:
        upload = tmp_path / "upload"
        Image.new("RGB", (64, 48), (90, 120, 150)).save(upload, format="PNG")

        with pytest.raises(RestorationFailure) as error:
            self.run(tmp_path, upload, (64, 48), transform=lambda image: image.resize((128, 96)))

        assert error.value.code == RestorationErrorCode.INVALID_OUTPUT

    def test_refuses_a_scan_over_the_long_edge_limit(self, tmp_path: Path) -> None:
        upload = tmp_path / "upload"
        Image.new("L", (8200, 16), 128).save(upload, format="PNG")

        with pytest.raises(RestorationFailure) as error:
            self.run(tmp_path, upload, (8200, 16))

        assert error.value.code == RestorationErrorCode.UNSUPPORTED_INPUT and "8192" in error.value.message


# ---------------------------------------------------------------------------------------
# The runtimes' image maths, with the models faked.
# ---------------------------------------------------------------------------------------


def old_print(height: int = 600, width: int = 800) -> np.ndarray:
    """A soft, slightly grainy picture: smooth tones like a studio backdrop."""
    rng = np.random.default_rng(933)
    ramp = (
        np.linspace(70, 170, width, dtype=np.float32)[None, :] + np.linspace(-20, 20, height, dtype=np.float32)[:, None]
    )
    grain = rng.normal(0, 3, (height, width)).astype(np.float32)
    return np.repeat(np.clip(ramp + grain, 0, 255).astype(np.uint8)[..., None], 3, axis=2)


class TestScratchMask:
    def test_finds_a_hairline_scratch_and_dust_but_not_the_picture(self) -> None:
        photo = old_print()
        cv2.line(photo, (100, 80), (520, 300), (250, 250, 250), 2)
        for x, y in ((650, 100), (700, 420), (60, 500)):
            cv2.circle(photo, (x, y), 2, (5, 5, 5), -1)

        mask = REPAIR["scratch_mask"](photo, [])

        assert mask.shape == photo.shape[:2] and mask.dtype == np.uint8
        assert mask[190, 310] == 255 and mask[100, 650] == 255 and mask[500, 60] == 255
        assert 0 < np.count_nonzero(mask) / mask.size < 0.01
        assert not REPAIR["scratch_mask"](old_print(), []).any()

    def test_never_marks_anything_inside_a_face(self) -> None:
        photo = old_print()
        cv2.circle(photo, (400, 300), 2, (255, 255, 255), -1)  # a catchlight in an eye
        cv2.line(photo, (300, 250), (500, 350), (250, 250, 250), 2)

        mask = REPAIR["scratch_mask"](photo, [(340, 240, 460, 360)])

        margin = int(120 * REPAIR["FACE_MARGIN"])
        assert not mask[240 - margin : 360 + margin, 340 - margin : 460 + margin].any()

    def test_leaves_texture_alone(self) -> None:
        rng = np.random.default_rng(1)
        texture = np.repeat(rng.integers(0, 255, (400, 400, 1), dtype=np.uint8), 3, axis=2)

        assert np.count_nonzero(REPAIR["scratch_mask"](texture, [])) / texture[..., 0].size < 0.001

    def test_keeps_a_wide_bright_shape(self) -> None:
        photo = old_print()
        cv2.rectangle(photo, (200, 200), (260, 420), (250, 250, 250), -1)  # a white collar, not a scratch

        assert not REPAIR["scratch_mask"](photo, [])[230:400, 215:245].any()


def box_fill(window: np.ndarray, window_mask: np.ndarray) -> np.ndarray:
    """A stand-in for the inpainting model: a local average, so its answer depends on its context."""
    return cv2.blur(window, (31, 31), borderType=cv2.BORDER_REFLECT_101)


class TestInpaintTiles:
    @pytest.mark.parametrize("size", [(300, 420), (512, 512), (900, 1300), (385, 1025)])
    def test_windows_match_one_whole_pass_at_seams_and_edges(self, size: tuple[int, int]) -> None:
        height, width = size
        rng = np.random.default_rng(height)
        photo = rng.integers(0, 255, (height, width, 3), dtype=np.uint8)
        mask = np.zeros((height, width), dtype=np.uint8)
        cv2.line(mask, (0, 3), (width - 1, height - 4), 255, 3)  # crosses every window seam
        cv2.line(mask, (width - 1, 0), (0, height - 1), 255, 3)
        whole = cv2.blur(photo, (31, 31), borderType=cv2.BORDER_REFLECT_101)

        output, tiles = REPAIR["inpaint_tiled"](photo, mask, box_fill)

        assert output.shape == photo.shape and tiles >= 1
        assert np.array_equal(output[mask == 0], photo[mask == 0])
        inner = np.zeros_like(mask, dtype=bool)
        inner[16:-16, 16:-16] = True  # the stand-in's own border handling differs only at the photo's edge
        assert np.array_equal(output[(mask > 0) & inner], whole[(mask > 0) & inner])

    def test_an_empty_mask_runs_no_window(self) -> None:
        photo = old_print(200, 300)

        output, tiles = REPAIR["inpaint_tiled"](photo, np.zeros((200, 300), np.uint8), box_fill)

        assert tiles == 0 and np.array_equal(output, photo)

    def test_refuses_a_model_answer_of_the_wrong_shape(self) -> None:
        mask = np.zeros((200, 300), np.uint8)
        mask[50, 50] = 255

        with pytest.raises(ValueError, match="invalid window"):
            REPAIR["inpaint_tiled"](old_print(200, 300), mask, lambda window, _: window[:100])


def face_row(box: tuple[float, float, float, float]) -> np.ndarray:
    """A detection row: box, score and five landmarks the runtime no longer uses."""
    return np.array([*box, 0.99, *([0.0] * 10)], dtype=np.float32)


def fake_models(faces: list[np.ndarray], *, fill: Any = box_fill) -> Any:
    return REPAIR["Models"](
        detect=lambda bgr: np.stack(faces) if faces else np.zeros((0, 15), np.float32),
        fill=fill,
    )


def scratched_print() -> np.ndarray:
    photo = old_print(600, 800)
    cv2.line(photo, (40, 40), (300, 90), (250, 250, 250), 2)
    cv2.line(photo, (540, 280), (660, 320), (250, 250, 250), 2)  # across the face
    cv2.circle(photo, (600, 500), 2, (5, 5, 5), -1)
    return photo


class TestRepair:
    def test_a_face_comes_back_byte_identical_even_with_a_scratch_across_it(self) -> None:
        photo = scratched_print()
        box = (560.0, 260.0, 640.0, 340.0)

        output, report = REPAIR["repair"](photo, fake_models([face_row(box)]))

        margin = 80 * REPAIR["FACE_MARGIN"]
        left, top, right, bottom = int(560 - margin), int(260 - margin), int(640 + margin), int(340 + margin)
        assert report.facesProtected == 1 and report.scratchPass == "applied"
        assert np.array_equal(output[top:bottom, left:right], photo[top:bottom, left:right])
        assert not np.array_equal(output, photo)

    def test_every_pixel_outside_the_mask_is_identical(self) -> None:
        photo = scratched_print()
        models = fake_models([face_row((560.0, 260.0, 640.0, 340.0))])

        faces, mask = REPAIR["find_marks"](photo, models)
        output, _ = REPAIR["fill_marks"](photo, faces, mask, models)

        assert mask.any() and np.array_equal(output[mask == 0], photo[mask == 0])
        assert output[65, 170, 0] < 200  # the scratch outside the face is gone

    def test_a_photo_without_marks_comes_back_identical_without_running_the_model(self) -> None:
        def refuse(window: np.ndarray, window_mask: np.ndarray) -> np.ndarray:
            raise AssertionError("the inpainting model must not run")

        photo = old_print(400, 500)

        output, report = REPAIR["repair"](photo, fake_models([], fill=refuse))

        assert report.scratchPass == "none" and np.array_equal(output, photo) and output is not photo

    def test_skips_the_scratch_pass_over_the_mask_limit(self) -> None:
        photo = old_print(400, 400)
        mask = np.zeros((400, 400), np.uint8)
        mask[:40, :] = 255  # 10% of the photo

        def refuse(window: np.ndarray, window_mask: np.ndarray) -> np.ndarray:
            raise AssertionError("the inpainting model must not run")

        output, report = REPAIR["fill_marks"](photo, [], mask, fake_models([], fill=refuse))

        assert report.scratchPass == "skipped-over-cap" and report.scratchMaskFraction > REPAIR["MASK_CAP"]
        assert "skipped" in report.warnings[0] and np.array_equal(output, photo)

    def test_detection_runs_on_a_bounded_copy_and_maps_back_outwards(self) -> None:
        sizes: list[tuple[int, ...]] = []

        def detect(bgr: np.ndarray) -> np.ndarray:
            sizes.append(bgr.shape)
            return face_row((100.2, 50.2, 120.7, 80.7))[None]

        faces = REPAIR["detect_faces"](np.zeros((3000, 6144, 3), np.uint8), detect)

        assert sizes == [(750, 1536, 3)]
        assert faces == [(400, 200, 483, 323)]


class TestColourise:
    @pytest.mark.parametrize("wrapped", [True, False])
    def test_only_the_unused_classifier_head_is_dropped_from_the_checkpoint(self, wrapped: bool) -> None:
        weights = {"encoder.arch.head_cls.weight": 1, "encoder.arch.head_cls.bias": 2, "decoder.other_head.weight": 3}

        kept = COLOURISE["model_weights"]({"params": weights} if wrapped else weights)

        assert kept == {"decoder.other_head.weight": 3}

    def test_keeps_the_size_and_the_lightness_of_the_photo(self) -> None:
        photo = old_print(333, 517)
        colour = np.zeros((512, 512, 2), dtype=np.float32)
        colour[..., 0], colour[..., 1] = 12.0, 18.0  # a warm cast

        output = COLOURISE["colourise"](photo, lambda grey: colour)

        assert output.shape == photo.shape and output.dtype == np.uint8
        before = cv2.cvtColor(photo.astype(np.float32) / 255, cv2.COLOR_RGB2Lab)
        after = cv2.cvtColor(output.astype(np.float32) / 255, cv2.COLOR_RGB2Lab)
        assert np.abs(after[..., 0] - before[..., 0]).max() < 1.5
        assert after[..., 1].mean() == pytest.approx(12.0, abs=1.0) and after[..., 2].mean() == pytest.approx(
            18.0, abs=1.0
        )

    def test_no_colour_from_the_model_returns_the_photo(self) -> None:
        photo = old_print(250, 190)

        output = COLOURISE["colourise"](photo, lambda grey: np.zeros((512, 512, 2), np.float32))

        assert np.abs(output.astype(np.int16) - photo).max() <= 1

    def test_strips_join_without_a_seam(self) -> None:
        rows = COLOURISE["STRIP_ROWS"]
        photo = old_print(rows + 37, 64)
        colour = np.zeros((512, 512, 2), dtype=np.float32)
        colour[..., 1] = np.linspace(-30, 30, 512, dtype=np.float32)[:, None]

        output = COLOURISE["merge_colour"](photo, colour).astype(np.int16)

        step = np.abs(np.diff(output, axis=0)).max(axis=(1, 2))
        assert step[rows - 1] <= step[rows - 20 : rows + 20].max() and step[rows - 1] < 40

    def test_the_model_sees_a_grey_square_of_its_own_size(self) -> None:
        rng = np.random.default_rng(3)
        grey = COLOURISE["model_input"](rng.integers(0, 255, (300, 700, 3), dtype=np.uint8))

        assert grey.shape == (3, 512, 512) and grey.dtype == np.float32
        assert np.abs(grey[0] - grey[1]).max() < 0.02 and np.abs(grey[1] - grey[2]).max() < 0.02

    def test_refuses_model_output_of_the_wrong_shape_or_with_nan(self) -> None:
        photo = old_print(64, 64)
        broken = np.full((512, 512, 2), np.nan, dtype=np.float32)

        for answer in (np.zeros((256, 256, 2), np.float32), broken):
            with pytest.raises(ValueError, match="invalid output"):
                COLOURISE["colourise"](photo, lambda grey, answer=answer: answer)

    @pytest.mark.parametrize("tone", [(1.0, 1.0, 1.0), (1.0, 0.82, 0.6), (0.92, 0.84, 0.9), (1.0, 0.7, 0.4)])
    def test_accepts_true_and_toned_monochrome(self, tone: tuple[float, float, float]) -> None:
        toned = np.clip(old_print(400, 300).astype(np.float32) * np.array(tone), 0, 255).astype(np.uint8)

        assert not COLOURISE["is_hand_tinted"](toned)

    def test_refuses_a_toned_print_with_paint_on_it(self) -> None:
        tinted = np.clip(old_print(400, 300).astype(np.float32) * np.array((1.0, 0.82, 0.6)), 0, 255).astype(np.uint8)
        tinted[120:220, 90:170] = (tinted[120:220, 90:170] * np.array((1.0, 0.55, 0.55))).astype(np.uint8)  # rouge
        tinted[240:320, 120:200] = (tinted[240:320, 120:200] * np.array((0.6, 0.8, 1.6))).clip(0, 255).astype(np.uint8)

        assert COLOURISE["is_hand_tinted"](tinted)

    def test_a_coloured_mount_alone_is_not_paint(self) -> None:
        toned = np.clip(old_print(400, 300).astype(np.float32) * np.array((1.0, 0.82, 0.6)), 0, 255).astype(np.uint8)
        toned[:30], toned[-30:] = (70, 130, 90), (70, 130, 90)
        toned[:, :24], toned[:, -24:] = (70, 130, 90), (70, 130, 90)

        assert not COLOURISE["is_hand_tinted"](toned)

    def test_a_refused_photo_never_loads_the_model_and_gives_the_reason(self, tmp_path: Path) -> None:
        (tmp_path / "in").mkdir()
        (tmp_path / "out").mkdir()
        colour = old_print(200, 200)
        colour[:100, ..., 0] = 220
        colour[100:, ..., 2] = 220
        Image.fromarray(colour).save(tmp_path / "in" / FRAME)
        arguments = [sys.executable, "-I", str(EXAMPLES / "runtimes" / "colourise.py")]
        arguments += ["--input-dir", str(tmp_path / "in"), "--output-dir", str(tmp_path / "out")]
        arguments += ["--runtime-root", str(tmp_path), "--checkpoint", str(tmp_path / "missing.bin")]

        completed = subprocess.run(arguments, capture_output=True, text=True, timeout=120, check=False)

        assert completed.returncode == RUNTIME_REFUSED_INPUT_EXIT == COLOURISE["REFUSED_EXIT"]
        failure = classify_runtime_failure(completed.returncode, completed.stderr)
        assert failure.code == RestorationErrorCode.UNSUPPORTED_INPUT
        assert failure.message == COLOURISE["HAND_TINTED_MESSAGE"]
        assert list((tmp_path / "out").iterdir()) == []

    def test_the_suggestion_marker_survives_the_worker(self, tmp_path: Path) -> None:
        marker = COLOURISE["SUGGESTED_COLOURS"]

        run = DdColorAdapter(photo_spec(tmp_path, "ddcolor"), tmp_path, copying_runner({"warnings": [marker]})).run(
            job(tmp_path)
        )

        assert run.warnings == [marker] and marker.startswith("suggested-colours:") and len(marker) <= 300


class TestScratchDetail:
    """Real detail the detector must leave alone: a missed scratch is better than a removed detail."""

    def test_leaves_a_row_of_beads_alone(self) -> None:
        photo = old_print()
        for x in range(200, 600, 12):
            cv2.circle(photo, (x, 300), 2, (250, 250, 250), -1)

        assert not REPAIR["scratch_mask"](photo, [])[290:310, 200:600].any()

    def test_leaves_handwriting_alone(self) -> None:
        photo = old_print()
        cv2.putText(photo, "Harry 1858", (180, 320), cv2.FONT_HERSHEY_SCRIPT_SIMPLEX, 2.0, (20, 20, 20), 2, cv2.LINE_AA)

        assert np.count_nonzero(REPAIR["scratch_mask"](photo, [])[250:345, 170:640]) == 0

    def test_leaves_a_ruled_mount_line_alone(self) -> None:
        photo = old_print()
        cv2.line(photo, (40, 200), (760, 200), (20, 20, 20), 1)
        cv2.line(photo, (300, 20), (300, 580), (20, 20, 20), 1)

        mask = REPAIR["scratch_mask"](photo, [])

        assert not mask[198:203, 40:760].any() and not mask[20:580, 298:303].any()

    def test_leaves_the_edge_of_a_card_alone(self) -> None:
        photo = old_print()
        photo[:, 400:] = 235
        for y in range(40, 560, 40):  # small nicks along the edge
            photo[y : y + 2, 399:402] = 20

        assert not REPAIR["scratch_mask"](photo, [])[:, 392:408].any()


@pytest.mark.parametrize(
    ("script", "weights", "reason"),
    [
        ("photo_repair.py", ["--detection", "--lama"], "photo repair needs an NVIDIA GPU"),
        ("colourise.py", ["--checkpoint"], "colourise needs an NVIDIA GPU"),
    ],
)
def test_a_runtime_without_a_gpu_refuses_with_the_reason(
    tmp_path: Path, script: str, weights: list[str], reason: str
) -> None:
    import torch

    if torch.cuda.is_available():
        pytest.skip("this machine has a CUDA device")
    (tmp_path / "in").mkdir()
    (tmp_path / "out").mkdir()
    Image.new("RGB", (32, 32), (128, 128, 128)).save(tmp_path / "in" / FRAME)
    arguments = [sys.executable, "-I", str(EXAMPLES / "runtimes" / script)]
    arguments += [
        "--input-dir",
        str(tmp_path / "in"),
        "--output-dir",
        str(tmp_path / "out"),
        "--runtime-root",
        str(tmp_path),
    ]
    for name in weights:
        arguments += [name, str(tmp_path / "missing.bin")]

    completed = subprocess.run(arguments, capture_output=True, text=True, timeout=120, check=False)

    assert completed.returncode == 1
    assert reason in completed.stderr and "no CUDA device is available" in completed.stderr
    assert list((tmp_path / "out").iterdir()) == []
