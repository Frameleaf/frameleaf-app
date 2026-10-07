"""Restoration and Smooth motion model adapters and their qualification gate (FL-114, FL-162).

Three families back the three modes:

* **Faithful** — RealBasicVSR (https://github.com/ckkelvinchan/RealBasicVSR). It restores at
  its native x4 and the pipeline then resizes conventionally (Lanczos) to the requested 2x or
  same-size output, capped at a 3840-pixel long edge.
* **Creative** — SeedVR2 (https://github.com/ByteDance-Seed/SeedVR). It generates at the
  requested size and writes an intermediate encoded video, which the pipeline decodes,
  checks and re-encodes.
* **Smooth motion** — RIFE (https://github.com/hzwer/Practical-RIFE). It makes the in-between
  frames of a folder of frames at 2x, 4x or 8x; the pipeline encodes them at that many times the
  source frame rate, so the clip keeps its length and its audio (FL-162).

Each family runs in its own pinned, isolated runtime (an upstream checkout at an exact
commit with its own Python environment) that this worker invokes as a subprocess from the
operator's model manifest. The worker process never imports torch or either model's code,
so the two runtimes' incompatible dependency stacks never meet.

A model is available only when every one of these holds, checked in this order:

1. the manifest pins an exact 40-hex upstream commit and a sha256 for every weight file;
2. the runtime checkout and interpreter exist;
3. the checkout is at the pinned commit with no modified tracked files;
4. every declared weight (including support weights such as SPyNet) exists and
5. hashes to its pinned sha256;
6. a qualification record for this model id, revision and exact weight hashes carries a
   ``pass`` for every required evidence item and names this container revision;
7. that record approves the code and weight licenses;
8. an NVIDIA GPU is present (RealBasicVSR and SeedVR2 are CUDA-only as pinned; a model whose
   manifest says ``requiresGpu: false``, such as RIFE on the processor, skips 8 to 10);
9. the GPU model and driver branch are ones the record qualified; and
10. it has at least the manifest's minimum memory.

Anything else reports an honest unavailable state with every reason found. Nothing here
invents readiness: with no manifest, no runtime, no weights or no evidence, the worker
serves no restoration workload at all. HDR and high-bit-depth sources stay rejected: offering
them needs an independently HDR-qualified record (``hdrQualified``) and an HDR output path,
which this worker does not have yet (``HDR_OUTPUT_SUPPORTED``).

Public contract — the manifest and qualification formats are documented in
``machine-learning/video-restoration/README.md`` with example files beside it.
"""

import hashlib
import json
import logging
import os
import re
import subprocess
import threading
import time
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from enum import StrEnum
from pathlib import Path
from typing import ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from . import media
from .gpu import VramSampler, query_gpus
from .schemas import (
    RESTORATION_PROTOCOL,
    WORKLOAD_BY_MODE,
    CapabilityReport,
    DynamicRange,
    GpuDescription,
    MeasuredThroughput,
    ModelCapability,
    ModelState,
    RestorationErrorCode,
    RestorationMode,
)

log = logging.getLogger("frameleaf.restoration")

COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
MODEL_ID_PATTERN = r"^[a-z0-9][a-z0-9-]{1,63}$"
PLACEHOLDER_RE = re.compile(r"\{([a-z_]+(?::[a-z0-9-]+)?)\}")
HASH_CHUNK_BYTES = 8 * 1024 * 1024
STDERR_TAIL_BYTES = 4000
# Placeholders a runtime argv template may use, besides ``{weight:<role>}``.
RUNTIME_PLACEHOLDERS = frozenset(
    {
        "python",
        "runtime_root",
        "input_dir",
        "output_dir",
        "seed",
        "target_width",
        "target_height",
        "max_seq_len",
        # Smooth motion: frames per source frame, and its base-2 exponent (RIFE's ``--exp``).
        "factor",
        "exp",
    }
)

ModelFamily = Literal["realbasicvsr", "seedvr2", "rife"]


class RestorationFailure(Exception):
    """A refusal or failure the HTTP layer turns into a ``RestorationError`` response."""

    STATUS: ClassVar[dict[RestorationErrorCode, int]] = {
        RestorationErrorCode.INVALID_REQUEST: 422,
        RestorationErrorCode.MODEL_UNAVAILABLE: 409,
        RestorationErrorCode.MODEL_CHANGED: 409,
        RestorationErrorCode.UNSUPPORTED_INPUT: 422,
        RestorationErrorCode.SOURCE_MISMATCH: 422,
        RestorationErrorCode.BUSY: 503,
        RestorationErrorCode.OUT_OF_MEMORY: 500,
        RestorationErrorCode.INVALID_OUTPUT: 500,
        RestorationErrorCode.RUNTIME_FAILED: 500,
        RestorationErrorCode.TIMEOUT: 504,
    }

    def __init__(self, code: RestorationErrorCode, message: str, *, model_id: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.model_id = model_id

    @property
    def status_code(self) -> int:
        return self.STATUS[self.code]


# ---------------------------------------------------------------------------------------
# Operator configuration: the model manifest.
# ---------------------------------------------------------------------------------------


class ConfigModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, protected_namespaces=())


class LicenseSpec(ConfigModel):
    """What the operator believes the licences are. Only a qualification record approves them."""

    code: str | None = None
    weights: str | None = None
    url: str | None = None


class RuntimeSpec(ConfigModel):
    # Upstream checkout at the pinned commit; also the working directory of the runtime.
    root: Path
    # Interpreter of the runtime's own isolated environment.
    python: Path
    # argv template. Placeholders: {python} {runtime_root} {input_dir} {output_dir} {seed}
    # {target_width} {target_height} {max_seq_len} {weight:<role>}. No shell is involved.
    argv: list[str] = Field(min_length=1)
    env: dict[str, str] = Field(default_factory=dict)
    timeoutSeconds: int = Field(default=3600, ge=10, le=86400)
    # warm-v1 argv starts a JSON-lines worker once; per-request values travel on stdin.
    protocol: Literal["process", "warm-v1"] = "process"
    idleSeconds: int = Field(default=120, ge=1, le=3600)
    maxRequests: int = Field(default=64, ge=1, le=1024)


class WeightSource(ConfigModel):
    """Where ``fetch_weights`` downloads a weight from: a repository of the Frameleaf model source
    (``MACHINE_LEARNING_MODEL_SOURCE_URL``, by default https://models.frameleaf.cloud), under the
    ``frameleaf`` organisation. The download is kept only when it hashes to the pinned sha256."""

    repo: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
    file: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")


class WeightSpec(ConfigModel):
    role: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,39}$")
    # Relative paths resolve against the manifest's ``weightsRoot``.
    path: Path
    # Pinned hash. A value that is not 64 lowercase hex characters leaves the model not pinned.
    sha256: str
    # Optional: where to download it from on the Frameleaf model source.
    source: WeightSource | None = None


class LimitsSpec(ConfigModel):
    # Largest source long edge the qualification measured. Larger sources are refused.
    maxInputLongEdge: int = Field(ge=16, le=8192)
    # Largest number of frames one request may restore.
    maxFrames: int = Field(ge=1, le=100_000)
    # Frames the runtime processes at once (RealBasicVSR --max-seq-len). Seams between
    # chunks are a qualification item.
    maxFramesPerChunk: int = Field(ge=1, le=10_000)
    minVramBytes: int = Field(ge=0)


class ModelSpec(ConfigModel):
    id: str = Field(pattern=MODEL_ID_PATTERN)
    family: ModelFamily
    mode: RestorationMode
    displayName: str = Field(min_length=1, max_length=80)
    repository: str
    revision: str
    license: LicenseSpec = Field(default_factory=LicenseSpec)
    # RealBasicVSR restores at a fixed x4; SeedVR2 generates at the requested size (None).
    nativeScale: int | None = Field(default=None, ge=1, le=8)
    runtime: RuntimeSpec
    weights: list[WeightSpec] = Field(min_length=1)
    limits: LimitsSpec
    dynamicRanges: list[DynamicRange] = Field(default_factory=lambda: [DynamicRange.SDR])
    # False for a model qualified on the processor (RIFE can be); its record then names that processor.
    requiresGpu: bool = True
    notes: str = ""

    @model_validator(mode="after")
    def _check_placeholders(self) -> "ModelSpec":
        roles = {weight.role for weight in self.weights}
        if len(roles) != len(self.weights):
            raise ValueError(f"model {self.id} declares a weight role twice")
        for argument in self.runtime.argv:
            for name in PLACEHOLDER_RE.findall(argument):
                if self.runtime.protocol == "warm-v1" and name in {
                    "input_dir",
                    "output_dir",
                    "seed",
                    "target_width",
                    "target_height",
                    "factor",
                    "exp",
                }:
                    raise ValueError(f"warm startup argv cannot contain per-request placeholder {{{name}}}")
                if name.startswith("weight:"):
                    if name.split(":", 1)[1] not in roles:
                        raise ValueError(f"model {self.id} argv names an undeclared weight: {{{name}}}")
                elif name not in RUNTIME_PLACEHOLDERS:
                    raise ValueError(f"model {self.id} argv uses an unknown placeholder: {{{name}}}")
        if (self.family == "rife") != (self.mode == RestorationMode.SMOOTH_MOTION):
            raise ValueError(f"model {self.id}: only the rife family serves smooth_motion")
        return self


class Manifest(ConfigModel):
    schemaVersion: Literal[1]
    weightsRoot: Path
    models: list[ModelSpec]

    @model_validator(mode="after")
    def _unique_ids(self) -> "Manifest":
        ids = [model.id for model in self.models]
        if len(set(ids)) != len(ids):
            raise ValueError("model ids must be unique")
        return self


# ---------------------------------------------------------------------------------------
# Qualification evidence.
# ---------------------------------------------------------------------------------------


class EvidenceItem(StrEnum):
    """Everything FL-114 requires before a model may serve a person's media."""

    WEIGHTS_HASHED = "weights-hashed"
    RESOURCE_PROFILE = "resource-profile"  # measured VRAM, input size and time
    COMPARE_FACES = "compare-faces"
    COMPARE_TEXT = "compare-text"
    COMPARE_FOLIAGE = "compare-foliage"
    COMPARE_MOTION = "compare-motion"
    COMPARE_CUTS = "compare-cuts"
    CHUNK_SEAMS = "chunk-seams"
    TIMING_PRESERVED = "timing-preserved"
    AUDIO_PRESERVED = "audio-preserved"
    HALLUCINATION = "hallucination"
    TEMPORAL_STABILITY = "temporal-stability"
    DETERMINISTIC_REPEAT = "deterministic-repeat"
    FAULT_OUT_OF_MEMORY = "fault-out-of-memory"
    FAULT_NAN = "fault-nan"
    FAULT_CHANGED_WEIGHTS = "fault-changed-weights"
    FAULT_DIRTY_CHECKOUT = "fault-dirty-checkout"
    FAULT_UNSUPPORTED_INPUT = "fault-unsupported-input"
    # RealBasicVSR: its native x4 followed by the conventional resize to the requested 2x,
    # compared with a plain 2x resize of the source.
    X4_TO_REQUESTED_2X = "x4-to-requested-2x"
    # SeedVR2: the intermediate video's compression and its frame count.
    INTERMEDIATE_COMPRESSION = "intermediate-compression"
    FRAME_COUNT = "frame-count"
    # RIFE: ghosting and warping around occlusions, fast motion and scene cuts, judged against
    # plain frame blending of the same source at the same rate.
    INTERPOLATION_ARTIFACTS = "interpolation-artifacts"


COMMON_EVIDENCE: frozenset[EvidenceItem] = frozenset(
    {
        EvidenceItem.WEIGHTS_HASHED,
        EvidenceItem.RESOURCE_PROFILE,
        EvidenceItem.COMPARE_FACES,
        EvidenceItem.COMPARE_TEXT,
        EvidenceItem.COMPARE_FOLIAGE,
        EvidenceItem.COMPARE_MOTION,
        EvidenceItem.COMPARE_CUTS,
        EvidenceItem.CHUNK_SEAMS,
        EvidenceItem.TIMING_PRESERVED,
        EvidenceItem.AUDIO_PRESERVED,
        EvidenceItem.HALLUCINATION,
        EvidenceItem.TEMPORAL_STABILITY,
        EvidenceItem.DETERMINISTIC_REPEAT,
        EvidenceItem.FAULT_OUT_OF_MEMORY,
        EvidenceItem.FAULT_NAN,
        EvidenceItem.FAULT_CHANGED_WEIGHTS,
        EvidenceItem.FAULT_DIRTY_CHECKOUT,
        EvidenceItem.FAULT_UNSUPPORTED_INPUT,
    }
)

REQUIRED_EVIDENCE: dict[str, frozenset[EvidenceItem]] = {
    "realbasicvsr": COMMON_EVIDENCE | {EvidenceItem.X4_TO_REQUESTED_2X},
    "seedvr2": COMMON_EVIDENCE | {EvidenceItem.INTERMEDIATE_COMPRESSION, EvidenceItem.FRAME_COUNT},
    "rife": COMMON_EVIDENCE | {EvidenceItem.FRAME_COUNT, EvidenceItem.INTERPOLATION_ARTIFACTS},
}


class EvidenceRecord(ConfigModel):
    item: EvidenceItem
    result: Literal["pass", "fail", "pending"]
    # Where the reproducible evidence lives (report path, artifact URL or CI run).
    artifact: str = ""
    notes: str = ""


class QualifiedHardware(ConfigModel):
    # GPU name exactly as ``nvidia-smi --query-gpu=name`` reports it.
    gpu: str
    driverVersion: str
    cudaVersion: str


class LicenseApproval(ConfigModel):
    approved: bool = False
    # SPDX identifiers (or licence names) the reviewer confirmed for the code and weights.
    code: str | None = None
    weights: str | None = None
    reviewedBy: str | None = None
    reviewedAt: date | None = None

    @property
    def complete(self) -> bool:
        return (
            self.approved
            and bool(self.code)
            and bool(self.weights)
            and bool(self.reviewedBy)
            and self.reviewedAt is not None
        )


class WeightPin(ConfigModel):
    role: str
    # Compared for equality with the manifest; a placeholder never matches a pinned hash.
    sha256: str


class QualificationRecord(ConfigModel):
    id: str = Field(min_length=1, max_length=64)
    modelId: str
    revision: str
    weights: list[WeightPin] = Field(min_length=1)
    # Worker image revisions (``FRAMELEAF_RESTORATION_IMAGE_REVISION``) the evidence covers.
    containerRevisions: list[str] = Field(default_factory=list)
    hardware: list[QualifiedHardware] = Field(default_factory=list)
    measurements: list[MeasuredThroughput] = Field(default_factory=list)
    evidence: list[EvidenceRecord] = Field(default_factory=list)
    license: LicenseApproval = Field(default_factory=LicenseApproval)
    # HDR needs its own evidence; see ``HDR_OUTPUT_SUPPORTED``.
    hdrQualified: bool = False
    reviewedBy: str | None = None
    reviewedAt: date | None = None
    notes: str = ""


class QualificationFile(ConfigModel):
    schemaVersion: Literal[1]
    records: list[QualificationRecord]


# ---------------------------------------------------------------------------------------
# Verification of what is actually installed.
# ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class RuntimeStatus:
    present: bool
    clean: bool
    problems: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class WeightStatus:
    missing: list[str] = field(default_factory=list)
    mismatched: list[str] = field(default_factory=list)

    @property
    def verified(self) -> bool:
        return not self.missing and not self.mismatched


def is_pinned(spec: ModelSpec) -> list[str]:
    """Problems that leave the manifest entry unpinned; empty when fully pinned."""
    problems: list[str] = []
    if not COMMIT_PATTERN.match(spec.revision):
        problems.append(f"revision {spec.revision!r} is not an exact 40-character commit")
    for weight in spec.weights:
        if not SHA256_RE.match(weight.sha256):
            problems.append(f"weight {weight.role} has no pinned sha256")
    return problems


def resolve_weight_path(weights_root: Path, weight: WeightSpec) -> Path:
    return weight.path if weight.path.is_absolute() else weights_root / weight.path


class WeightVerifier:
    """Hash weight files, reusing a hash only while the file's device, inode, size,
    modification time and status-change time are all unchanged. A replaced file or any write
    moves the status-change time, which a caller cannot set back, so it forces a fresh hash."""

    def __init__(self) -> None:
        self._cache: dict[Path, tuple[tuple[int, int, int, int, int], str]] = {}
        self._lock = threading.Lock()

    def sha256(self, path: Path) -> str | None:
        try:
            stat = path.stat()
        except OSError:
            return None
        key = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        with self._lock:
            cached = self._cache.get(path)
        if cached is not None and cached[0] == key:
            return cached[1]

        digest = hashlib.sha256()
        try:
            with path.open("rb") as handle:
                while chunk := handle.read(HASH_CHUNK_BYTES):
                    digest.update(chunk)
        except OSError:
            return None
        value = digest.hexdigest()
        with self._lock:
            self._cache[path] = (key, value)
        return value

    def verify(self, spec: ModelSpec, weights_root: Path) -> WeightStatus:
        missing: list[str] = []
        mismatched: list[str] = []
        for weight in spec.weights:
            path = resolve_weight_path(weights_root, weight)
            if not path.is_file():
                missing.append(f"{weight.role} ({path})")
                continue
            actual = self.sha256(path)
            if actual is None:
                missing.append(f"{weight.role} ({path}) is unreadable")
            elif actual != weight.sha256:
                mismatched.append(f"{weight.role} hashes to {actual}, pinned {weight.sha256}")
        return WeightStatus(missing=missing, mismatched=mismatched)


def _git(root: Path, *args: str) -> str | None:
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            # Never take the index lock: the checkout may be read-only and is only inspected.
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    return completed.stdout if completed.returncode == 0 else None


def inspect_runtime(spec: ModelSpec) -> RuntimeStatus:
    """Check the runtime checkout exists, is at the pinned commit and has no modified
    tracked files. A checkout without git metadata cannot prove either and is not clean."""
    root, python = spec.runtime.root, spec.runtime.python
    missing: list[str] = []
    if not root.is_dir():
        missing.append(f"runtime checkout {root} does not exist")
    if not python.is_file():
        missing.append(f"runtime interpreter {python} does not exist")
    if missing:
        return RuntimeStatus(present=False, clean=False, problems=missing)

    head = _git(root, "rev-parse", "HEAD")
    if head is None:
        return RuntimeStatus(present=True, clean=False, problems=[f"{root} has no git metadata to verify"])
    problems: list[str] = []
    if head.strip() != spec.revision:
        problems.append(f"{root} is at {head.strip()}, pinned {spec.revision}")
    status = _git(root, "status", "--porcelain", "--untracked-files=no")
    if status is None:
        problems.append(f"could not read the working tree state of {root}")
    elif status.strip():
        problems.append(f"{root} has modified tracked files")
    return RuntimeStatus(present=True, clean=not problems, problems=problems)


def model_fingerprint(spec: ModelSpec) -> str:
    """Identity of this model, pinned weights, runtime configuration and qualified limits.
    A full render must present the fingerprint its preview was made with."""
    digest = hashlib.sha256()
    digest.update(f"{spec.id}\n{spec.family}\n{spec.revision}\n".encode())
    for weight in sorted(spec.weights, key=lambda item: item.role):
        digest.update(f"{weight.role}:{weight.sha256}\n".encode())
    # A changed constructor/config or chunk limit must also invalidate a preview and warm model.
    digest.update(spec.runtime.model_dump_json().encode())
    digest.update(spec.limits.model_dump_json().encode())
    digest.update(str(spec.nativeScale).encode())
    return digest.hexdigest()


def find_qualification(
    spec: ModelSpec,
    records: list[QualificationRecord],
    container_revision: str | None,
) -> tuple[QualificationRecord | None, list[str]]:
    """The record covering this exact model, and every gap in it."""
    pinned = {(weight.role, weight.sha256) for weight in spec.weights}
    candidates = [
        record
        for record in records
        if record.modelId == spec.id
        and record.revision == spec.revision
        and {(weight.role, weight.sha256) for weight in record.weights} == pinned
    ]
    if not candidates:
        return None, [f"no qualification record covers {spec.id} at {spec.revision} with these weights"]

    record = max(candidates, key=lambda candidate: candidate.reviewedAt or date.min)
    problems: list[str] = []
    if not record.reviewedBy or record.reviewedAt is None:
        problems.append(f"qualification record {record.id} has not been reviewed")
    for item in sorted(REQUIRED_EVIDENCE[spec.family]):
        entries = [evidence for evidence in record.evidence if evidence.item == item]
        # Every entry for an item must pass and point at its evidence; a later "pass" never
        # hides an earlier "fail", and a pass without an artifact is only a claim.
        if not entries:
            problems.append(f"evidence {item} is missing")
        elif any(entry.result != "pass" for entry in entries):
            failed = sorted({entry.result for entry in entries if entry.result != "pass"})
            problems.append(f"evidence {item} is {', '.join(failed)}")
        elif any(not entry.artifact.strip() for entry in entries):
            problems.append(f"evidence {item} passes without an artifact to reproduce it")
    if not record.measurements:
        problems.append("no measured throughput was recorded")
    if not record.hardware:
        problems.append("no qualified GPU was recorded")
    if container_revision is None:
        problems.append("this worker image has no FRAMELEAF_RESTORATION_IMAGE_REVISION to match")
    elif container_revision not in record.containerRevisions:
        problems.append(f"worker image {container_revision} is not a qualified revision")
    return record, problems


def driver_branch(version: str) -> str:
    """The NVIDIA driver branch ("550" of "550.54.14"); minor updates stay qualified."""
    return version.strip().split(".", 1)[0]


# The worker's encode path writes 8-bit SDR H.264. Offering HDR needs both an independently
# HDR-qualified record and an HDR output path; until the second exists HDR is never offered,
# whatever a record says, so an HDR source is refused instead of being flattened to SDR.
HDR_OUTPUT_SUPPORTED = False


def allowed_dynamic_ranges(spec: ModelSpec, record: QualificationRecord | None) -> list[DynamicRange]:
    """SDR when declared; HDR only when declared, independently qualified and encodable."""
    ranges = [DynamicRange.SDR] if DynamicRange.SDR in spec.dynamicRanges else []
    if HDR_OUTPUT_SUPPORTED and DynamicRange.HDR in spec.dynamicRanges and record is not None and record.hdrQualified:
        ranges.append(DynamicRange.HDR)
    return ranges


def gpu_findings(
    spec: ModelSpec, gpus: list[GpuDescription], qualified: set[tuple[str, str]]
) -> list[tuple[ModelState, str]]:
    """The GPU a CUDA runtime needs: present, a qualified model and driver branch, enough memory."""
    findings: list[tuple[ModelState, str]] = []
    if not gpus:
        findings.append((ModelState.NO_GPU, "no NVIDIA GPU is visible to the worker"))
    else:
        matching = [gpu for gpu in gpus if (gpu.name, driver_branch(gpu.driverVersion)) in qualified]
        if not matching:
            present = ", ".join(f"{gpu.name} (driver {gpu.driverVersion})" for gpu in gpus)
            findings.append((ModelState.GPU_UNQUALIFIED, f"{present} is not a qualified GPU and driver for {spec.id}"))
        elif max(gpu.memoryTotalBytes for gpu in matching) < spec.limits.minVramBytes:
            findings.append(
                (
                    ModelState.INSUFFICIENT_VRAM,
                    f"{spec.id} needs {spec.limits.minVramBytes} bytes of GPU memory",
                )
            )
    return findings


def evaluate_model(
    spec: ModelSpec,
    *,
    runtime: RuntimeStatus,
    weights: WeightStatus,
    records: list[QualificationRecord],
    gpus: list[GpuDescription],
    container_revision: str | None,
) -> ModelCapability:
    """Pure admission rule for one model. Collects every reason; the state is the first."""
    findings: list[tuple[ModelState, str]] = []
    findings += [(ModelState.NOT_PINNED, problem) for problem in is_pinned(spec)]
    if not runtime.present:
        findings += [(ModelState.RUNTIME_MISSING, problem) for problem in runtime.problems]
    elif not runtime.clean:
        findings += [(ModelState.RUNTIME_DIRTY, problem) for problem in runtime.problems]
    findings += [(ModelState.WEIGHTS_MISSING, f"weight {problem} is missing") for problem in weights.missing]
    findings += [(ModelState.WEIGHTS_MISMATCH, f"weight {problem}") for problem in weights.mismatched]

    record, gaps = find_qualification(spec, records, container_revision)
    findings += [(ModelState.UNQUALIFIED, gap) for gap in gaps]
    if record is None or not record.license.complete:
        findings.append((ModelState.LICENSE_UNREVIEWED, "the code and weight licenses are not approved"))

    # The restoration runtimes are CUDA-only as pinned, so a qualified NVIDIA GPU is required: the
    # same model name on the same driver branch the evidence was recorded with. A model qualified on
    # the processor says so in its manifest and skips this.
    hardware = record.hardware if record else []
    qualified = {(entry.gpu, driver_branch(entry.driverVersion)) for entry in hardware}
    if spec.requiresGpu:
        findings += gpu_findings(spec, gpus, qualified)

    verified = weights.verified and not is_pinned(spec)
    return ModelCapability(
        id=spec.id,
        family=spec.family,
        mode=spec.mode,
        displayName=spec.displayName,
        revision=spec.revision,
        fingerprint=model_fingerprint(spec) if verified else None,
        state=findings[0][0] if findings else ModelState.AVAILABLE,
        reasons=[reason for _, reason in findings],
        nativeScale=spec.nativeScale,
        maxInputLongEdge=spec.limits.maxInputLongEdge,
        maxFrames=spec.limits.maxFrames,
        dynamicRanges=allowed_dynamic_ranges(spec, record),
        measured=list(record.measurements) if record else [],
        qualificationId=record.id if record else None,
    )


def verifying_capability(spec: ModelSpec) -> ModelCapability:
    return ModelCapability(
        id=spec.id,
        family=spec.family,
        mode=spec.mode,
        displayName=spec.displayName,
        revision=spec.revision,
        fingerprint=None,
        state=ModelState.VERIFYING,
        reasons=["weights and runtime are being verified"],
        nativeScale=spec.nativeScale,
        maxInputLongEdge=spec.limits.maxInputLongEdge,
        maxFrames=spec.limits.maxFrames,
        dynamicRanges=[],
        measured=[],
        qualificationId=None,
    )


# ---------------------------------------------------------------------------------------
# Runtime invocation.
# ---------------------------------------------------------------------------------------


def render_argv(template: list[str], values: dict[str, str]) -> list[str]:
    """Substitute placeholders argument by argument. Values come from the manifest and from
    validated integers; nothing from a request is interpolated as text and no shell runs."""

    def substitute(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in values:
            raise RestorationFailure(RestorationErrorCode.RUNTIME_FAILED, f"no value for placeholder {{{name}}}")
        return values[name]

    return [PLACEHOLDER_RE.sub(substitute, argument) for argument in template]


# Environment every runtime gets: no network model downloads, deterministic hashing and
# cuBLAS workspace so repeat runs can be compared.
RUNTIME_ENV = {
    "HF_HUB_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
    "HF_HUB_DISABLE_TELEMETRY": "1",
    "DO_NOT_TRACK": "1",
    "PYTHONHASHSEED": "0",
    "CUBLAS_WORKSPACE_CONFIG": ":4096:8",
}

# Variables a runtime may inherit from the worker's environment.
RUNTIME_ENV_ALLOWED = frozenset(
    {
        "PATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "TZ",
        "TMPDIR",
        "LD_LIBRARY_PATH",
        "CUDA_VISIBLE_DEVICES",
        "CUDA_HOME",
        "NVIDIA_VISIBLE_DEVICES",
        "NVIDIA_DRIVER_CAPABILITIES",
    }
)

OOM_MARKERS = ("out of memory", "outofmemoryerror", "cuda error: out of memory", "cudnn_status_alloc_failed")


@dataclass(frozen=True)
class RuntimeInvocation:
    argv: list[str]
    cwd: Path
    env: dict[str, str]
    timeout_s: int
    payload: dict[str, str] | None = None
    cache_key: str | None = None
    idle_s: int = 120
    max_requests: int = 64


@dataclass(frozen=True)
class RuntimeOutcome:
    duration_ms: int
    peak_vram_bytes: int | None


def classify_runtime_failure(returncode: int, stderr: str) -> RestorationFailure:
    tail = stderr.strip()[-STDERR_TAIL_BYTES:]
    lowered = tail.lower()
    if any(marker in lowered for marker in OOM_MARKERS):
        return RestorationFailure(RestorationErrorCode.OUT_OF_MEMORY, f"the runtime ran out of GPU memory: {tail}")
    return RestorationFailure(RestorationErrorCode.RUNTIME_FAILED, f"the runtime exited with {returncode}: {tail}")


def run_runtime(invocation: RuntimeInvocation) -> RuntimeOutcome:
    if invocation.payload is not None:
        raise RestorationFailure(RestorationErrorCode.RUNTIME_FAILED, "warm-v1 requires the worker's managed runner")
    started = time.monotonic()
    with VramSampler() as sampler:
        try:
            completed = subprocess.run(
                invocation.argv,
                cwd=invocation.cwd,
                env=invocation.env,
                capture_output=True,
                text=True,
                timeout=invocation.timeout_s,
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise RestorationFailure(
                RestorationErrorCode.TIMEOUT, f"the runtime did not finish within {invocation.timeout_s} s"
            )
        except OSError as error:
            raise RestorationFailure(RestorationErrorCode.RUNTIME_FAILED, f"the runtime could not start: {error}")
    if completed.returncode != 0:
        raise classify_runtime_failure(completed.returncode, completed.stderr)
    return RuntimeOutcome(duration_ms=int((time.monotonic() - started) * 1000), peak_vram_bytes=sampler.peak)


Runner = Callable[[RuntimeInvocation], RuntimeOutcome]


# ---------------------------------------------------------------------------------------
# Adapters.
# ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class RuntimeJob:
    work_dir: Path
    # ``%08d.png`` sequence of the source segment at source size.
    source_frames: Path
    frame_count: int
    frame_rate: str
    source_size: tuple[int, int]
    target_size: tuple[int, int]
    seed: int
    # swscale matrix of the source, for any conversion back to YCbCr and out again.
    yuv_matrix: str = "bt709"
    # Smooth motion: frames per source frame. 1 for a restoration.
    interpolation_factor: int = 1
    # SeedVR2 consumes the validated video segment without a PNG/re-encode round trip.
    source_video: Path | None = None


@dataclass(frozen=True)
class AdapterRun:
    # ``%08d.png`` sequence of restored frames, before the final resize.
    frames_dir: Path
    expected_size: tuple[int, int] | None
    runtime_ms: int
    peak_vram_bytes: int | None
    warnings: list[str]
    video: Path | None = None


class RestorationAdapter(ABC):
    family: ClassVar[str]

    def __init__(self, spec: ModelSpec, weights_root: Path, runner: Runner = run_runtime) -> None:
        self.spec = spec
        self.weights_root = weights_root
        self.runner = runner

    def base_values(self, job: RuntimeJob) -> dict[str, str]:
        values = {
            "python": str(self.spec.runtime.python),
            "runtime_root": str(self.spec.runtime.root),
            "seed": str(job.seed),
            "target_width": str(job.target_size[0]),
            "target_height": str(job.target_size[1]),
            "max_seq_len": str(self.spec.limits.maxFramesPerChunk),
        }
        for weight in self.spec.weights:
            values[f"weight:{weight.role}"] = str(resolve_weight_path(self.weights_root, weight))
        return values

    def invocation(self, values: dict[str, str]) -> RuntimeInvocation:
        # Only what a CUDA runtime needs is inherited; the worker's own secrets (its bearer
        # token, for one) never reach third-party model code.
        inherited = {name: value for name, value in os.environ.items() if name in RUNTIME_ENV_ALLOWED}
        env = {**inherited, **self.spec.runtime.env, **RUNTIME_ENV}
        warm = self.spec.runtime.protocol == "warm-v1"
        # Include every configuration value and resolved weight root, not request paths/seed.
        # Registry.select still verifies checkout, checkpoint hashes and qualification first.
        key = hashlib.sha256(
            (self.spec.model_dump_json() + str(self.weights_root.resolve()) + json.dumps(env, sort_keys=True)).encode()
        ).hexdigest()
        return RuntimeInvocation(
            argv=render_argv(self.spec.runtime.argv, values),
            cwd=self.spec.runtime.root,
            env=env,
            timeout_s=self.spec.runtime.timeoutSeconds,
            payload={
                name: values[name] for name in ("input_dir", "output_dir", "seed", "target_width", "target_height")
            }
            if warm
            else None,
            cache_key=key if warm else None,
            idle_s=self.spec.runtime.idleSeconds,
            max_requests=self.spec.runtime.maxRequests,
        )

    @abstractmethod
    def run(self, job: RuntimeJob) -> AdapterRun: ...


class RealBasicVsrAdapter(RestorationAdapter):
    """Faithful. Upstream's own ``inference_realbasicvsr.py`` reads a folder of frames and
    writes restored PNG frames at x4, processing ``--max-seq-len`` frames at a time. The
    pipeline then resizes to the requested size; that x4-to-2x step is a qualification item
    because it is where a conventional resize meets the model's output."""

    family = "realbasicvsr"

    def run(self, job: RuntimeJob) -> AdapterRun:
        output_dir = job.work_dir / "runtime-output"
        output_dir.mkdir()
        values = {**self.base_values(job), "input_dir": str(job.source_frames), "output_dir": str(output_dir)}
        outcome = self.runner(self.invocation(values))
        scale = self.spec.nativeScale or 4
        expected = (job.source_size[0] * scale, job.source_size[1] * scale)
        warnings: list[str] = []
        if job.frame_count > self.spec.limits.maxFramesPerChunk:
            warnings.append(
                f"restored in chunks of {self.spec.limits.maxFramesPerChunk} frames; chunk seams are a qualified risk"
            )
        return AdapterRun(
            frames_dir=output_dir,
            expected_size=expected,
            runtime_ms=outcome.duration_ms,
            peak_vram_bytes=outcome.peak_vram_bytes,
            warnings=warnings,
        )


class SeedVr2Adapter(RestorationAdapter):
    """Creative. Upstream's ``projects/inference_seedvr2_*.py`` reads a folder of videos and
    writes one encoded video per input at ``--res_h``/``--res_w``. The pipeline validates
    every frame as a stream and encodes directly from it, without scratch PNGs. Stills use
    the frame path. The intermediate size is recorded for compression qualification."""

    family = "seedvr2"
    VIDEO_SUFFIXES = frozenset({".mp4", ".mov", ".mkv"})

    def run(self, job: RuntimeJob) -> AdapterRun:
        input_dir = job.work_dir / "runtime-input"
        output_dir = job.work_dir / "runtime-output"
        frames_dir = job.work_dir / "runtime-frames"
        input_dir.mkdir()
        output_dir.mkdir()
        timeout = float(self.spec.runtime.timeoutSeconds)
        try:
            if job.source_video is not None:
                # Both files live inside this request's private directory, on the same volume.
                os.link(job.source_video, input_dir / "source.mp4")
            else:
                media.encode_near_lossless_clip(
                    job.source_frames,
                    input_dir / "source.mp4",
                    job.frame_rate,
                    yuv_matrix=job.yuv_matrix,
                    timeout=timeout,
                )
        except media.MediaError as error:
            raise RestorationFailure(RestorationErrorCode.RUNTIME_FAILED, str(error), model_id=self.spec.id)

        values = {**self.base_values(job), "input_dir": str(input_dir), "output_dir": str(output_dir)}
        outcome = self.runner(self.invocation(values))

        videos = sorted(path for path in output_dir.rglob("*") if path.suffix.lower() in self.VIDEO_SUFFIXES)
        if len(videos) != 1:
            raise RestorationFailure(
                RestorationErrorCode.INVALID_OUTPUT,
                f"the runtime wrote {len(videos)} videos; expected exactly one",
                model_id=self.spec.id,
            )
        intermediate = videos[0]
        try:
            # The runtime chose its own encoder settings, so its file is read with the matrix it
            # is tagged with (or the size convention when untagged), not the source's.
            if job.source_video is None:
                intermediate_matrix = media.probe(intermediate, still=job.frame_count == 1).yuv_matrix
                media.decode_video_frames(intermediate, frames_dir, yuv_matrix=intermediate_matrix, timeout=timeout)
        except media.MediaError as error:
            raise RestorationFailure(RestorationErrorCode.INVALID_OUTPUT, str(error), model_id=self.spec.id)
        return AdapterRun(
            frames_dir=frames_dir,
            expected_size=None,
            runtime_ms=outcome.duration_ms,
            peak_vram_bytes=outcome.peak_vram_bytes,
            warnings=[f"intermediate video {intermediate.name} was {intermediate.stat().st_size} bytes"],
            video=intermediate if job.source_video is not None else None,
        )


class RifeAdapter(RestorationAdapter):
    """Smooth motion (FL-162). Upstream's frame-folder inference reads the source frames and writes
    ``(n - 1) * factor + 1`` PNG frames at the source size: every source frame, with ``factor - 1``
    new frames between each pair. The pipeline checks that count, keeps the size and encodes them at
    ``factor`` times the source frame rate."""

    family = "rife"

    def run(self, job: RuntimeJob) -> AdapterRun:
        factor = job.interpolation_factor
        if factor not in (2, 4, 8):
            raise RestorationFailure(
                RestorationErrorCode.INVALID_REQUEST, f"smooth motion needs a factor of 2, 4 or 8, not {factor}"
            )
        output_dir = job.work_dir / "runtime-output"
        output_dir.mkdir()
        values = {
            **self.base_values(job),
            "input_dir": str(job.source_frames),
            "output_dir": str(output_dir),
            "factor": str(factor),
            "exp": str(factor.bit_length() - 1),
        }
        outcome = self.runner(self.invocation(values))
        return AdapterRun(
            frames_dir=output_dir,
            expected_size=job.source_size,
            runtime_ms=outcome.duration_ms,
            peak_vram_bytes=outcome.peak_vram_bytes,
            warnings=[],
        )


ADAPTERS: dict[str, type[RestorationAdapter]] = {
    RealBasicVsrAdapter.family: RealBasicVsrAdapter,
    SeedVr2Adapter.family: SeedVr2Adapter,
    RifeAdapter.family: RifeAdapter,
}


# ---------------------------------------------------------------------------------------
# Registry: loads configuration, verifies installations and reports capability.
# ---------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SelectedModel:
    spec: ModelSpec
    capability: ModelCapability
    weights_root: Path


def _load_json(path: Path) -> object:
    with path.open("rb") as handle:
        return json.load(handle)


@dataclass(frozen=True)
class LoadedConfiguration:
    manifest: Manifest | None
    records: list[QualificationRecord]
    problems: list[str]


class RestorationRegistry:
    """Configuration, verification and the published capability report.

    Verification hashes multi-gigabyte weights, so it runs without holding the lock that
    guards the published report: probes keep answering (``verifying`` at first) while a
    refresh is under way.
    """

    def __init__(
        self,
        manifest_path: Path,
        qualification_path: Path,
        *,
        gpu_query: Callable[[], list[GpuDescription]] = query_gpus,
        runtime_inspector: Callable[[ModelSpec], RuntimeStatus] = inspect_runtime,
        verifier: WeightVerifier | None = None,
        container_revision: str | None = None,
    ) -> None:
        self.manifest_path = manifest_path
        self.qualification_path = qualification_path
        self.gpu_query = gpu_query
        self.runtime_inspector = runtime_inspector
        self.verifier = verifier or WeightVerifier()
        self.container_revision = container_revision
        self._lock = threading.Lock()
        self._report: CapabilityReport | None = None

    def load(self) -> LoadedConfiguration:
        """Read the manifest and qualification file. Never raises: problems are reported."""
        problems: list[str] = []
        manifest: Manifest | None = None
        records: list[QualificationRecord] = []
        if not self.manifest_path.is_file():
            problems.append(f"no model manifest at {self.manifest_path}")
        else:
            try:
                manifest = Manifest.model_validate(_load_json(self.manifest_path))
            except (OSError, ValueError, ValidationError) as error:
                problems.append(f"model manifest {self.manifest_path} is invalid: {error}")
        if not self.qualification_path.is_file():
            problems.append(f"no qualification file at {self.qualification_path}")
        else:
            try:
                records = QualificationFile.model_validate(_load_json(self.qualification_path)).records
            except (OSError, ValueError, ValidationError) as error:
                problems.append(f"qualification file {self.qualification_path} is invalid: {error}")
        return LoadedConfiguration(manifest=manifest, records=records, problems=problems)

    def _evaluate(
        self, spec: ModelSpec, config: LoadedConfiguration, manifest: Manifest, gpus: list[GpuDescription]
    ) -> ModelCapability:
        return evaluate_model(
            spec,
            runtime=self.runtime_inspector(spec),
            weights=self.verifier.verify(spec, manifest.weightsRoot),
            records=config.records,
            gpus=gpus,
            container_revision=self.container_revision,
        )

    @staticmethod
    def _build_report(
        models: list[ModelCapability], gpus: list[GpuDescription], problems: list[str]
    ) -> CapabilityReport:
        available_modes = {model.mode for model in models if model.state == ModelState.AVAILABLE}
        return CapabilityReport(
            protocol=RESTORATION_PROTOCOL,
            workloads=[WORKLOAD_BY_MODE[mode] for mode in RestorationMode if mode in available_modes],
            models=models,
            gpus=gpus,
            configurationProblems=problems,
            checkedAt=datetime.now(timezone.utc).isoformat(),
        )

    def refresh(self) -> CapabilityReport:
        """Re-read configuration, verify every model and replace the published report."""
        config = self.load()
        gpus = self.gpu_query()
        manifest = config.manifest
        models = [self._evaluate(spec, config, manifest, gpus) for spec in manifest.models] if manifest else []
        report = self._build_report(models, gpus, config.problems)
        with self._lock:
            self._report = report
        for model in report.models:
            log.info("Restoration model %s is %s: %s", model.id, model.state, "; ".join(model.reasons) or "ready")
        for problem in report.configurationProblems:
            log.warning("Restoration configuration problem: %s", problem)
        return report

    def report(self) -> CapabilityReport:
        """The last published report. Before the first verification finishes every model is
        ``verifying`` and no workload is served."""
        with self._lock:
            if self._report is not None:
                return self._report
        config = self.load()
        specs = config.manifest.models if config.manifest else []
        return self._build_report([verifying_capability(spec) for spec in specs], [], config.problems)

    def select(self, mode: RestorationMode, model_id: str | None, fingerprint: str | None) -> SelectedModel:
        """Choose the model for one request and verify it again now, so weights or a checkout
        changed since the last report are caught before any frame is decoded.

        With a fingerprint (a full render inheriting its preview) only the model with exactly
        that identity is acceptable; another available model is never substituted.
        """
        config = self.load()
        manifest = config.manifest
        if manifest is None:
            raise RestorationFailure(
                RestorationErrorCode.MODEL_UNAVAILABLE, "; ".join(config.problems) or "no model manifest"
            )
        candidates = [spec for spec in manifest.models if spec.mode == mode]
        if model_id is not None:
            candidates = [spec for spec in candidates if spec.id == model_id]
        if not candidates:
            detail = f"no {mode} model named {model_id} is configured" if model_id else f"no {mode} model is configured"
            raise RestorationFailure(RestorationErrorCode.MODEL_UNAVAILABLE, detail, model_id=model_id)

        gpus = self.gpu_query()
        reasons: list[str] = []
        available: list[tuple[ModelSpec, ModelCapability]] = []
        for spec in candidates:
            capability = self._evaluate(spec, config, manifest, gpus)
            if capability.state == ModelState.AVAILABLE:
                available.append((spec, capability))
            else:
                reasons.append(f"{spec.id}: {capability.state} ({'; '.join(capability.reasons)})")

        if not available:
            raise RestorationFailure(
                RestorationErrorCode.MODEL_UNAVAILABLE,
                f"no {mode} model is available: " + " | ".join(reasons),
                model_id=model_id,
            )
        if fingerprint is not None:
            matching = [entry for entry in available if entry[1].fingerprint == fingerprint]
            if not matching:
                raise RestorationFailure(
                    RestorationErrorCode.MODEL_CHANGED,
                    "no available model matches the one the preview was made with; make a new preview",
                    model_id=model_id,
                )
            available = matching
        spec, capability = available[0]
        return SelectedModel(spec=spec, capability=capability, weights_root=manifest.weightsRoot)


def adapter_for(selected: SelectedModel, runner: Runner = run_runtime) -> RestorationAdapter:
    return ADAPTERS[selected.spec.family](selected.spec, selected.weights_root, runner)


# ---------------------------------------------------------------------------------------
# Weights from the Frameleaf model source.
# ---------------------------------------------------------------------------------------

MODEL_SOURCE_ORG = "frameleaf"

Downloader = Callable[[str, str, Path], Path]


def _download_from_model_source(repo_id: str, filename: str, directory: Path) -> Path:
    from huggingface_hub import hf_hub_download

    from immich_ml.config import model_source_token, model_source_url

    return Path(
        hf_hub_download(
            repo_id,
            filename,
            local_dir=directory,
            endpoint=model_source_url(),
            # A Hugging Face token only ever goes to huggingface.co (see model_source_token).
            token=model_source_token(),
        )
    )


def fetch_weights(
    manifest: Manifest,
    *,
    model_ids: list[str] | None = None,
    download: Downloader = _download_from_model_source,
    verifier: WeightVerifier | None = None,
) -> list[str]:
    """Download every weight that names a ``source`` from the Frameleaf model source into its
    manifest path. A weight already present with its pinned hash is left alone; a download is moved
    into place only when it hashes to the pinned sha256, so a wrong or tampered file never becomes
    a weight. Returns what was done, one line per weight. Qualification is still required before
    any model serves a request."""
    verifier = verifier or WeightVerifier()
    report: list[str] = []
    for spec in manifest.models:
        if model_ids and spec.id not in model_ids:
            continue
        for weight in spec.weights:
            target = resolve_weight_path(manifest.weightsRoot, weight)
            if weight.source is None:
                report.append(f"{spec.id} {weight.role}: no model source entry; place {target} yourself")
                continue
            if not SHA256_RE.match(weight.sha256):
                report.append(f"{spec.id} {weight.role}: not pinned; nothing downloaded")
                continue
            if target.is_file() and verifier.sha256(target) == weight.sha256:
                report.append(f"{spec.id} {weight.role}: already present")
                continue
            staging = target.parent / f".download-{weight.role}"
            staging.mkdir(parents=True, exist_ok=True)
            try:
                downloaded = download(f"{MODEL_SOURCE_ORG}/{weight.source.repo}", weight.source.file, staging)
                actual = WeightVerifier().sha256(downloaded)
                if actual != weight.sha256:
                    raise RestorationFailure(
                        RestorationErrorCode.MODEL_UNAVAILABLE,
                        f"{spec.id} {weight.role} from the model source hashes to {actual}, pinned {weight.sha256}",
                        model_id=spec.id,
                    )
                os.replace(downloaded, target)
            finally:
                for leftover in sorted(staging.rglob("*"), reverse=True):
                    leftover.unlink() if leftover.is_file() or leftover.is_symlink() else leftover.rmdir()
                staging.rmdir()
            report.append(f"{spec.id} {weight.role}: downloaded and verified")
    return report
