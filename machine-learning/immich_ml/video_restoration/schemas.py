"""Wire contract between the server and the restoration worker (FL-114).

One restoration inference is one request and one result. The request travels as the
``request`` form field of ``POST /restoration/restore`` next to the ``media`` file; the
result travels base64url-encoded in the ``x-restoration-result`` response header while the
body streams the restored file. Failures answer with a ``RestorationError`` JSON body.

Field names are camelCase on purpose: they are the JSON keys the server parses.

Public contract — KEEP IN SYNC WITH ``server/src/dtos/restoration-inference.dto.ts`` and
``MachineLearningRepository.restore`` / ``getRestorationModels``.
"""

from enum import StrEnum
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

RESTORATION_PROTOCOL: Final = "restoration-v1"
RESULT_HEADER = "x-restoration-result"

# Output is capped at 4K: the server passes the exact box (3840 on the long edge, 2160 on
# the short one for the orientation at hand) and the worker never exceeds it.
MAX_OUTPUT_EDGE = 3840
SUPPORTED_SCALES = (1, 2, 4)

SHA256_PATTERN = r"^[0-9a-f]{64}$"
RATIONAL_PATTERN = r"^[1-9][0-9]{0,8}/[1-9][0-9]{0,8}$"


class RestorationMode(StrEnum):
    """What the person asked for. The names express intention, not a fidelity guarantee."""

    FAITHFUL = "faithful"
    CREATIVE = "creative"


# The server's ``MlWorkload`` values for each mode. A worker lists a workload in
# ``GET /capabilities`` only while at least one model for that mode is available.
WORKLOAD_BY_MODE: dict[RestorationMode, str] = {
    RestorationMode.FAITHFUL: "restoration-faithful",
    RestorationMode.CREATIVE: "restoration-creative",
}


class DynamicRange(StrEnum):
    SDR = "sdr"
    HDR = "hdr"


class RestorationErrorCode(StrEnum):
    INVALID_REQUEST = "invalid-request"
    MODEL_UNAVAILABLE = "model-unavailable"
    # The request pinned a model fingerprint (a full render inheriting its preview) and the
    # worker's model no longer matches it. The server must ask for a new preview.
    MODEL_CHANGED = "model-changed"
    UNSUPPORTED_INPUT = "unsupported-input"
    # The uploaded bytes disagree with what the server said it measured.
    SOURCE_MISMATCH = "source-mismatch"
    BUSY = "busy"
    OUT_OF_MEMORY = "out-of-memory"
    # Wrong frame count, wrong size, or blank frames where the source had content (the
    # visible symptom of NaN activations).
    INVALID_OUTPUT = "invalid-output"
    RUNTIME_FAILED = "runtime-failed"
    TIMEOUT = "timeout"


class ModelState(StrEnum):
    """Why a model can or cannot run. Only ``available`` admits a request."""

    AVAILABLE = "available"
    VERIFYING = "verifying"
    NOT_PINNED = "not-pinned"
    RUNTIME_MISSING = "runtime-missing"
    RUNTIME_DIRTY = "runtime-dirty"
    WEIGHTS_MISSING = "weights-missing"
    WEIGHTS_MISMATCH = "weights-mismatch"
    UNQUALIFIED = "unqualified"
    LICENSE_UNREVIEWED = "license-unreviewed"
    NO_GPU = "no-gpu"
    GPU_UNQUALIFIED = "gpu-unqualified"
    INSUFFICIENT_VRAM = "insufficient-vram"


class WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, protected_namespaces=())


class TimeSegment(WireModel):
    """Part of the uploaded media to restore, in milliseconds from its start."""

    startMs: int = Field(ge=0)
    endMs: int = Field(gt=0)

    @model_validator(mode="after")
    def _ordered(self) -> "TimeSegment":
        if self.endMs <= self.startMs:
            raise ValueError("endMs must be after startMs")
        return self


class SourceDescription(WireModel):
    """What the server measured about the uploaded media. The worker re-probes the bytes and
    refuses when they disagree, so a stale or mismatched upload never produces a derivative.
    Fields the server did not measure are left out and checked only by the worker's own probe."""

    width: int = Field(gt=0, le=16384)
    height: int = Field(gt=0, le=16384)
    # Required for a video, absent for a still.
    durationMs: int | None = Field(default=None, gt=0)
    frameRate: str | None = Field(default=None, pattern=RATIONAL_PATTERN)
    dynamicRange: DynamicRange | None = None
    bitDepth: int | None = Field(default=None, ge=8, le=16)


class RestorationRequest(WireModel):
    protocol: Literal["restoration-v1"]
    requestId: str = Field(min_length=1, max_length=200)
    mode: RestorationMode
    # A still is restored as a one-frame sequence and returned as PNG; a video as MP4.
    kind: Literal["image", "video"] = "video"
    # None: the worker's available model for the mode. A value names one model exactly.
    modelId: str | None = Field(default=None, min_length=1, max_length=64)
    # A full render passes the fingerprint its approved preview reported; any change to the
    # model revision or weights since then is refused with ``model-changed``.
    modelFingerprint: str | None = Field(default=None, pattern=SHA256_PATTERN)
    scale: Literal[1, 2, 4] = 2
    # The output never exceeds this box on either edge; aspect is kept.
    maxWidth: int = Field(default=MAX_OUTPUT_EDGE, ge=16, le=MAX_OUTPUT_EDGE)
    maxHeight: int = Field(default=MAX_OUTPUT_EDGE, ge=16, le=MAX_OUTPUT_EDGE)
    # Neither pinned model has a grain control; asking for it is answered with a warning.
    keepGrain: bool = False
    # None restores the whole upload. The server cuts clips before upload so a remote worker
    # never receives more of the original than the job needs; this is for local callers.
    segment: TimeSegment | None = None
    seed: int = Field(default=0, ge=0, le=2**31 - 1)
    source: SourceDescription

    @model_validator(mode="after")
    def _kind_fields(self) -> "RestorationRequest":
        if self.kind == "video" and self.source.durationMs is None:
            raise ValueError("a video request needs source.durationMs")
        if self.kind == "image" and self.segment is not None:
            raise ValueError("a still has no segment")
        return self


class WeightIdentity(WireModel):
    role: str
    sha256: str = Field(pattern=SHA256_PATTERN)


class ModelIdentity(WireModel):
    id: str
    family: str
    mode: RestorationMode
    revision: str
    fingerprint: str = Field(pattern=SHA256_PATTERN)
    weights: list[WeightIdentity]
    qualificationId: str


class OutputDescription(WireModel):
    width: int
    height: int
    # None for a still.
    frameRate: str | None
    frameCount: int
    durationMs: int | None
    container: Literal["mp4", "png"]
    codec: str
    dynamicRange: DynamicRange
    bitDepth: int
    # "transcoded" when a source codec cannot live in MP4 (PCM, for example) and became AAC.
    audio: Literal["copied", "transcoded", "none"]
    bytes: int
    sha256: str = Field(pattern=SHA256_PATTERN)


class RestorationTiming(WireModel):
    decodeMs: int
    runtimeMs: int
    encodeMs: int
    totalMs: int
    # Frames restored per second of runtime; the measured throughput estimates build on.
    framesPerSecond: float


class RestorationResult(WireModel):
    protocol: Literal["restoration-v1"]
    requestId: str
    mode: RestorationMode
    model: ModelIdentity
    output: OutputDescription
    timing: RestorationTiming
    # Highest device memory in use while the runtime ran, sampled from nvidia-smi; None when
    # it could not be sampled. Device-wide, so it includes other processes on the GPU.
    peakVramBytes: int | None
    seed: int
    warnings: list[str]


class RestorationError(WireModel):
    code: RestorationErrorCode
    message: str
    modelId: str | None = None


class MeasuredThroughput(WireModel):
    """A measurement recorded during qualification on real hardware."""

    gpu: str
    inputWidth: int
    inputHeight: int
    frames: int
    framesPerSecond: float
    peakVramBytes: int


class ModelCapability(WireModel):
    id: str
    family: str
    mode: RestorationMode
    displayName: str
    revision: str
    fingerprint: str | None
    state: ModelState
    reasons: list[str]
    nativeScale: int | None
    maxInputLongEdge: int
    maxFrames: int
    dynamicRanges: list[DynamicRange]
    measured: list[MeasuredThroughput]
    qualificationId: str | None


class GpuDescription(WireModel):
    name: str
    memoryTotalBytes: int
    driverVersion: str


class CapabilityReport(WireModel):
    protocol: Literal["restoration-v1"]
    workloads: list[str]
    models: list[ModelCapability]
    gpus: list[GpuDescription]
    # Problems reading the model manifest or qualification file. Non-empty means the worker
    # is misconfigured; every affected model is reported unavailable, never guessed.
    configurationProblems: list[str]
    checkedAt: str
