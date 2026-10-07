# Worker wire models and non-controller HTTP inventory

Source baseline: **24d509f1346e344bb356f92cd0fbed2a59b74ca8**. This is an exact schema supplement for ML, restoration, render workers and Buddy peers. Snippets are source schema/type declarations; they are not runnable standalone modules. `z` is Zod, `Field`/`BaseModel` are Pydantic. Optional omission and nullable values are distinct. DTO field descriptions and validators are contract evidence, not proof that an inference/runtime/deployment works.

## ML HTTP and envelopes

Ordinary ML has GET `/`, `/ping`, `/capabilities`, `/hardware`, POST `/predict`. `/predict` is multipart `entries` (JSON string) plus `image` file or `text` string; when both media fields exist image wins. Missing both is 400; invalid entries are 422. Images add `imageHeight`/`imageWidth` to the response. Dependency-model output is assigned to its task key: consumers must use the selected pipeline's final response contracts, not assume a list per model type.

**Authentication:** ordinary ML and the dedicated restoration worker enforce their own configured `FRAMELEAF_ML_AUTH_TOKEN` bearer token on all routes except normalized `/` and `/ping`. When unset, middleware authentication is disabled. This is independent of local-user sessions/API keys. Unauthorized middleware response is 401 `{message:"Unauthorized"}`. The normal Nest AuthGuard is not attached.

**Options qualification:** listed registered `(task,type)` combinations use Pydantic validators with `extra="forbid"`; unknown keys are rejected there. The `validate_options` fallback returns options unchanged when no validator is registered for the pair. Enum annotations in a TypedDict are not themselves full request validation: do not claim every unknown task/type is rejected by that annotation alone. Subsequent model/dependency admission can still fail.

[machine-learning/immich_ml/main.py:182–207](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/main.py#L182-L207) [machine-learning/immich_ml/main.py:213–287](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/main.py#L213-L287) [machine-learning/immich_ml/main.py:383–428](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/main.py#L383-L428) [machine-learning/immich_ml/schemas.py:245–264](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L245-L264)

## Ordinary ML complete declarations

`ModelTask`, `ModelType`, `PipelineEntry`, `PipelineRequest`, `InferenceResponse` and every registered option class follow. Runtime-only ONNX session protocols are omitted. `InferenceResponse` intentionally uses `Any`; typed server response contracts below narrow the built-in workloads. `external_prompt` is capped at 65536 characters by its validator. `ImageDescriptionOptions.acceleration` is annotated enum **or string**, so the schema alone does not enforce only enum spellings. `nsfw` is dict[str,Any], not a strictly typed object at this boundary.

[machine-learning/immich_ml/schemas.py:18–19](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L18-L19)

```python
class StrEnum(str, Enum):
    __str__ = str.__str__
```

[machine-learning/immich_ml/schemas.py:22–26](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L22-L26)

```python
class BoundingBox(TypedDict):
    x1: int
    y1: int
    x2: int
    y2: int
```

[machine-learning/immich_ml/schemas.py:29–35](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L29-L35)

```python
class ModelTask(StrEnum):
    FACIAL_RECOGNITION = "facial-recognition"
    SEARCH = "clip"
    OCR = "ocr"
    IMAGE_DESCRIPTION = "image-description-tagging"
    NSFW_DETECTION = "nsfw-detection"
    SEMANTIC_MASK = "semantic-mask"
```

[machine-learning/immich_ml/schemas.py:38–43](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L38-L43)

```python
class ModelType(StrEnum):
    CLASSIFICATION = "classification"
    DETECTION = "detection"
    RECOGNITION = "recognition"
    TEXTUAL = "textual"
    VISUAL = "visual"
```

[machine-learning/immich_ml/schemas.py:46–49](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L46-L49)

```python
class ModelFormat(StrEnum):
    ARMNN = "armnn"
    ONNX = "onnx"
    RKNN = "rknn"
```

[machine-learning/immich_ml/schemas.py:52–56](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L52-L56)

```python
class ModelSource(StrEnum):
    INSIGHTFACE = "insightface"
    MCLIP = "mclip"
    OPENCLIP = "openclip"
    PADDLE = "paddle"
```

[machine-learning/immich_ml/schemas.py:59–61](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L59-L61)

```python
class ModelPrecision(StrEnum):
    FP16 = "FP16"
    FP32 = "FP32"
```

[machine-learning/immich_ml/schemas.py:64–67](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L64-L67)

```python
class ImageDescriptionAcceleration(StrEnum):
    AUTO = "auto"
    OPENVINO = "openvino"
    CUDA = "cuda"
```

[machine-learning/immich_ml/schemas.py:108–111](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L108-L111)

```python
class DetectedFace(TypedDict):
    boundingBox: BoundingBox
    embedding: str
    score: float
```

[machine-learning/immich_ml/schemas.py:114](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L114)

```python
FacialRecognitionOutput = list[DetectedFace]
```

[machine-learning/immich_ml/schemas.py:117–119](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L117-L119)

```python
class PipelineEntry(TypedDict):
    modelName: str
    options: dict[str, Any]
```

[machine-learning/immich_ml/schemas.py:122](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L122)

```python
PipelineRequest = dict[ModelTask, dict[ModelType, PipelineEntry]]
```

[machine-learning/immich_ml/schemas.py:125–129](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L125-L129)

```python
class InferenceEntry(TypedDict):
    name: str
    task: ModelTask
    type: ModelType
    options: dict[str, Any]
```

[machine-learning/immich_ml/schemas.py:132](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L132)

```python
InferenceEntries = tuple[list[InferenceEntry], list[InferenceEntry]]
```

[machine-learning/immich_ml/schemas.py:135](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L135)

```python
InferenceResponse = dict[ModelTask | Literal["imageHeight"] | Literal["imageWidth"], Any]
```

[machine-learning/immich_ml/schemas.py:146](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L146)

```python
MAX_EXTERNAL_PROMPT_LENGTH = 64 * 1024
```

[machine-learning/immich_ml/schemas.py:149–167](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L149-L167)

```python
class _OptionsBase(BaseModel):
    """Common ground for per-task option models.

    `extra="forbid"` enforces a closed keyspace per task — this catches
    schema drift between server and ML service, and provides a defensive
    barrier against an attacker who controls the server side from sending
    arbitrary kwargs to model constructors.

    NOTE: ``ttl`` is intentionally NOT declared here. ``main.run_inference``
    passes ``ttl=settings.model_ttl`` to ``model_cache.get`` alongside
    ``**entry["options"]``; declaring ``ttl`` as a per-task option would
    let a caller send ``ttl`` in the validated payload, then collide with
    the explicit keyword and raise ``TypeError: got multiple values for
    keyword argument 'ttl'``.
    """

    model_config = ConfigDict(extra="forbid")

    device: str | None = Field(default=None, max_length=64)
```

[machine-learning/immich_ml/schemas.py:170–177](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L170-L177)

```python
class ClipOptions(_OptionsBase):
    """Options for CLIP textual/visual models."""

    # Weblate language code (e.g. "en-US", "de") for multilingual CLIP text
    # search. The server forwards it via TextEncodingOptions; NLLB tokenizers
    # map it to a FLORES-200 code (see models/clip/textual.py). Bounded length
    # preserves the closed-keyspace hardening's defensive posture.
    language: str | None = Field(default=None, max_length=64)
```

[machine-learning/immich_ml/schemas.py:180–183](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L180-L183)

```python
class FacialRecognitionDetectionOptions(_OptionsBase):
    """Options for the facial-recognition detection task."""

    minScore: float | None = Field(default=None, ge=0.0, le=1.0)
```

[machine-learning/immich_ml/schemas.py:186–187](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L186-L187)

```python
class FacialRecognitionRecognitionOptions(_OptionsBase):
    """Options for the facial-recognition recognition task."""
```

[machine-learning/immich_ml/schemas.py:190–198](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L190-L198)

```python
class OcrDetectionOptions(_OptionsBase):
    """Options for the OCR detection task."""

    minScore: float | None = Field(default=None, ge=0.0, le=1.0)
    # The server forwards maxResolution (machine-learning.repository.ts) and the
    # detector's configure() consumes it (models/ocr/detection.py). Without it
    # declared here, extra="forbid" rejects every OCR request. Bound mirrors the
    # server DTO (model-config.dto.ts: z.int().min(1)).
    maxResolution: int | None = Field(default=None, ge=1)
```

[machine-learning/immich_ml/schemas.py:201–204](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L201-L204)

```python
class OcrRecognitionOptions(_OptionsBase):
    """Options for the OCR recognition task."""

    minScore: float | None = Field(default=None, ge=0.0, le=1.0)
```

[machine-learning/immich_ml/schemas.py:207–210](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L207-L210)

```python
class NsfwDetectionOptions(_OptionsBase):
    """Options for the NSFW classification model."""

    threshold: float | None = Field(default=None, ge=0.0, le=1.0)
```

[machine-learning/immich_ml/schemas.py:213–233](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L213-L233)

```python
class ImageDescriptionOptions(_OptionsBase):
    """Options for the image-description-tagging task.

    Restricts the option keyspace per ml.md High concern — unknown keys are
    rejected, the external prompt is length-capped, and acceleration/device
    are constrained to expected values.
    """

    external_prompt: str | None = None
    # nsfw can be the dict shape {"isNsfw": bool} or None.
    nsfw: dict[str, Any] | None = None
    acceleration: ImageDescriptionAcceleration | str | None = None

    @field_validator("external_prompt")
    @classmethod
    def _cap_prompt_length(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if len(value) > MAX_EXTERNAL_PROMPT_LENGTH:
            raise ValueError(f"external_prompt exceeds maximum length of {MAX_EXTERNAL_PROMPT_LENGTH} characters")
        return value
```

[machine-learning/immich_ml/schemas.py:236–238](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L236-L238)

```python
class SemanticMaskOptions(_OptionsBase):
    target: Literal["subject", "sky"] = "subject"
    device: Literal["cpu", "cuda"] = "cpu"
```

[machine-learning/immich_ml/schemas.py:242–252](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/schemas.py#L242-L252)

```python
OPTIONS_VALIDATORS: dict[tuple[ModelTask, ModelType], type[BaseModel]] = {
    (ModelTask.SEARCH, ModelType.TEXTUAL): ClipOptions,
    (ModelTask.SEARCH, ModelType.VISUAL): ClipOptions,
    (ModelTask.FACIAL_RECOGNITION, ModelType.DETECTION): FacialRecognitionDetectionOptions,
    (ModelTask.FACIAL_RECOGNITION, ModelType.RECOGNITION): FacialRecognitionRecognitionOptions,
    (ModelTask.OCR, ModelType.DETECTION): OcrDetectionOptions,
    (ModelTask.OCR, ModelType.RECOGNITION): OcrRecognitionOptions,
    (ModelTask.IMAGE_DESCRIPTION, ModelType.VISUAL): ImageDescriptionOptions,
    (ModelTask.NSFW_DETECTION, ModelType.CLASSIFICATION): NsfwDetectionOptions,
    (ModelTask.SEMANTIC_MASK, ModelType.VISUAL): SemanticMaskOptions,
}
```

## Server built-in ML response types

These are exact HTTP caller-side response expectations for CLIP, OCR, face recognition, NSFW and image description. A declaration is not additional validation beyond the actual caller. `embedding`/CLIP encodings are strings; OCR boxes are flat numeric arrays as declared. The backend model still determines encoding internals.

[server/src/repositories/machine-learning.repository.ts:47–193](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/repositories/machine-learning.repository.ts#L47-L193)

```ts
export interface BoundingBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export enum ModelTask {
  FACIAL_RECOGNITION = 'facial-recognition',
  SEARCH = 'clip',
  OCR = 'ocr',
  IMAGE_DESCRIPTION = 'image-description-tagging',
  NSFW_DETECTION = 'nsfw-detection',
}

export enum ModelType {
  CLASSIFICATION = 'classification',
  DETECTION = 'detection',
  PIPELINE = 'pipeline',
  RECOGNITION = 'recognition',
  TEXTUAL = 'textual',
  VISUAL = 'visual',
  OCR = 'ocr',
}

export type ModelPayload = { imagePath: string } | { text: string };

type ModelOptions = { modelName: string };

export type FaceDetectionOptions = ModelOptions & { minScore: number };
export type OcrOptions = ModelOptions & {
  minDetectionScore: number;
  minRecognitionScore: number;
  maxResolution: number;
};
export type ImageDescriptionOptions = ModelOptions & {
  acceleration: MachineLearningHardwareAcceleration;
  fallbackModelName: string;
  device: string;
};
export type NsfwDetectionOptions = ModelOptions & {
  threshold: number;
  device: string;
};
type VisualResponse = { imageHeight: number; imageWidth: number };
export type ClipVisualRequest = { [ModelTask.SEARCH]: { [ModelType.VISUAL]: ModelOptions } };
export type ClipVisualResponse = { [ModelTask.SEARCH]: string } & VisualResponse;

export type ClipTextualRequest = { [ModelTask.SEARCH]: { [ModelType.TEXTUAL]: ModelOptions } };
export type ClipTextualResponse = { [ModelTask.SEARCH]: string };

export type OCR = {
  text: string[];
  box: number[];
  boxScore: number[];
  textScore: number[];
};

export type OcrRequest = {
  [ModelTask.OCR]: {
    [ModelType.DETECTION]: ModelOptions & { options: { minScore: number; maxResolution: number } };
    [ModelType.RECOGNITION]: ModelOptions & { options: { minScore: number } };
  };
};
export type OcrResponse = { [ModelTask.OCR]: OCR } & VisualResponse;

export type NsfwDetectionResult = {
  isNsfw: boolean;
  score: number;
  labels: Record<string, number>;
};

export type ImageDescriptionResult = {
  description: string;
  /**
   * FL-36: the model's confidence in the description, 0 to 1, when the destination reports one.
   * The bundled service does not (its people and safety signals carry only low/medium/high labels,
   * which are never turned into a number); stored only when present, null otherwise.
   */
  confidence?: number | null;
  people: Array<{
    count: number;
    apparent_age_group: string;
    activity: string;
    confidence: string;
  }>;
  environment: string;
  objects: string[];
  visible_text: string[];
  context: string;
  tags: string[];
  safety?: {
    is_nsfw_likely: boolean;
    confidence: string;
    indicators: string[];
    reason: string;
  };
  medical?: {
    is_medical_likely: boolean;
    confidence: string;
    indicators: string[];
    reason: string;
  };
};

export type ImageDescriptionRequest = {
  [ModelTask.IMAGE_DESCRIPTION]: {
    [ModelType.VISUAL]: ModelOptions & {
      options: {
        acceleration: MachineLearningHardwareAcceleration;
        device: string;
        nsfw?: NsfwDetectionResult;
      };
    };
  };
};
export type ImageDescriptionResponse = { [ModelTask.IMAGE_DESCRIPTION]: ImageDescriptionResult } & VisualResponse;

export type NsfwDetectionRequest = {
  [ModelTask.NSFW_DETECTION]: {
    [ModelType.CLASSIFICATION]: ModelOptions & { options: { threshold: number; device: string } };
  };
};
export type NsfwDetectionResponse = { [ModelTask.NSFW_DETECTION]: NsfwDetectionResult } & VisualResponse;

export type FacialRecognitionRequest = {
  [ModelTask.FACIAL_RECOGNITION]: {
    [ModelType.DETECTION]: ModelOptions & { options: { minScore: number } };
    [ModelType.RECOGNITION]: ModelOptions;
  };
};

export interface Face {
  boundingBox: BoundingBox;
  embedding: string;
  score: number;
}

export type FacialRecognitionResponse = { [ModelTask.FACIAL_RECOGNITION]: Face[] } & VisualResponse;

export type MachineLearningRequest =
  | ClipVisualRequest
  | ClipTextualRequest
  | FacialRecognitionRequest
  | OcrRequest
  | ImageDescriptionRequest
  | NsfwDetectionRequest;
```

## Semantic-mask response

The `semantic-mask`/`visual` pipeline returns task-keyed data with `png` (standard base64 grayscale PNG), width, height, target (`subject` or `sky`), coordinates (`sensor-active`), and models (`{repository,revision}[]`). It shares `/predict`; there is no separate `/enrichment` or `/semantic-mask` HTTP route in either FastAPI application. The server constructs a local-only request with modelName `frameleaf-florence2-sam2.1` and does not force a CPU device in its request options. The worker selects the configured semantic-mask device; `auto` chooses CUDA when available and CPU otherwise. Empty proposals fail instead of publishing an empty mask. [machine-learning/immich_ml/models/semantic_mask.py:35–77](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/models/semantic_mask.py#L35-L77)

[machine-learning/immich_ml/models/semantic_mask.py:116–127](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/models/semantic_mask.py#L116-L127) [server/src/repositories/machine-learning.repository.ts:429–451](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/repositories/machine-learning.repository.ts#L429-L451)

## ML hardware response

Ordinary `/hardware` combines providers:string[], openvinoDeviceIds:string[], torchCudaAvailable:boolean, cudaDeviceCount:number, preferredAcceleration (`auto`,`cuda`,`openvino`) and container below. Restoration `/hardware` reports the same five top-level hardware fields but no container; providers/openvinoDeviceIds are empty and torchCudaAvailable is false because its worker process does not open a torch context. GPU count comes from the registry report.

[server/src/utils/hardware-check.ts:1–92](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/hardware-check.ts#L1-L92)

```ts
/**
 * Hardware & GPU (FL-159, CLD-201, handoff §3.2): what the server container (video transcoding and
 * Studio export) and the machine-learning container (AI features) can each actually use. Detection
 * runs inside each container: the server reads its own devices and runs a short test transcode; the
 * ML container reports through `GET /hardware` (`container`) and a test search embedding is timed.
 *
 * Pure functions: they turn what was read into one result per container and the set-up problems
 * that result shows, by the ids of the web catalogue's `gpuProblems`. Nothing here guesses at a card
 * the container cannot see; a problem is named only when the container gives evidence of it.
 */

export type HardwareBackend = 'CUDA' | 'ROCm' | 'OpenVINO' | 'NVENC' | 'VA-API' | 'QSV' | 'CPU';

export type RenderNode = {
  node: string;
  vendor: string | null;
  accessible: boolean;
  memoryTotalBytes: number | null;
  /** Group that owns the node, as a number: the host's render group when /dev/dri is passed in. */
  gid?: number | null;
  /** The host render node this is (by device number); it can differ from the name inside. */
  hostNode?: string | null;
};

/** A GPU on the host, from the PCI list the container reads in `/sys` (not only what was passed in). */
export type HostGpu = {
  pciAddress: string;
  vendor: string;
  /** Its render node on the host, when it has one. */
  renderNode: string | null;
  /** An integrated GPU (Intel at 00:02.0, or AMD with little dedicated memory). */
  integrated: boolean;
  memoryTotalBytes: number | null;
};

/** What a container can read about the machine it runs on. */
export type HostFacts = {
  /** `/proc/sys/kernel/osrelease`: names WSL2, Docker Desktop's virtual machine and Unraid. */
  kernel: string | null;
  /** GPUs on the host; null when the PCI list cannot be read. */
  gpus: HostGpu[] | null;
  /** `/dev/dxg` is passed in (WSL2's GPU device). */
  dxg: boolean;
  /** The groups the container's process runs with. */
  groups: number[];
  /** The process runs as root, which opens any device node regardless of its group. */
  root: boolean;
};

/** What the server container read about itself. */
export type ServerHardwareFacts = {
  nvidia: { name: string; memoryTotalBytes: number | null; driver: string } | null;
  nvidiaError: string | null;
  nvidiaRequested: boolean;
  nvidiaDevice: boolean;
  renderNodes: RenderNode[];
  encoders: string[];
  test: TestTranscode | null;
  host: HostFacts | null;
};

export type TestTranscode = {
  /** The encoder the test used. */
  encoder: string;
  /** True when it ran on the GPU's video engine. */
  gpu: boolean;
  /** Real-time multiple for 1080p (e.g. 9.6 = 9.6× real time), or null when it failed. */
  speed: number | null;
  /** The first line ffmpeg wrote when the GPU encoder failed. */
  error: string | null;
};

/** What the ML container reported (`GET /hardware` → `container`). */
export type MlContainerReport = {
  image: string;
  backend: string;
  gpus: Array<{ name: string; vendor: string | null; memoryTotalBytes: number | null }>;
  driver: string | null;
  nvidiaError: string | null;
  devices: {
    renderNodes: RenderNode[];
    kfd: boolean;
    kfdAccessible: boolean;
    nvidia: boolean;
    nvidiaRequested: boolean;
  };
  /** Absent from an older ML image. */
  host?: HostFacts | null;
  /** CUDA compute capability of the first GPU, such as "7.5"; bf16 and FlashAttention need 8.0. */
  computeCapability?: string | null;
  /** ROCm: the gfx targets of the GPUs and the `HSA_OVERRIDE_GFX_VERSION` set, if any. */
  rocm?: { gfxTargets: string[]; hsaOverride: string | null } | null;
```

## Dedicated restoration HTTP protocol

This is a separate FastAPI app (default port 3004). Its six explicit routes are GET `/`, `/ping`, `/capabilities`, `/hardware`, `/restoration/models` and POST `/restoration/restore`. `/restoration/models?refresh=true` forces a fresh registry report; `/capabilities` returns `{protocol:"restoration-v1",workloads:string[]}`. Restore is multipart `request` (serialized RestorationRequest JSON) and `media` (file). Success body is restored bytes; `x-restoration-result` is unpadded base64url UTF-8 `RestorationResult` JSON. Error body is `RestorationError`, except separate authentication/transport/framework failures.

**Source discrepancies to retain:** Python accepts optional `segment` (ordered start/end milliseconds); server RestorationWorkerRequestSchema has no segment field and prepares/cuts media before submission. Python request defaults `kind="video"`, scale=2 and output box defaults; server schema requires those fields explicitly. Python output/timing fields have fewer nonnegative/positive constraints than server result parsing, whose declarations follow. The HTTP FileResponse currently hardcodes `media_type="video/mp4"` even though the result schema supports `container:"png"` for still images; consumers must validate result metadata/bytes rather than infer the actual file format from that header alone.

[machine-learning/immich_ml/video_restoration/app.py:189–308](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/video_restoration/app.py#L189-L308) [server/src/repositories/machine-learning.repository.ts:875–971](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/repositories/machine-learning.repository.ts#L875-L971)

The restore handler admits one request at a time. On client disconnect or task cancellation, it cancels managed runtimes and waits for inference cleanup before releasing admission; a disconnected caller may receive no result body. Shutdown also cancels managed runtimes. Warm model processes and their JSON-lines control are internal worker execution details; the external `restoration-v1` request/result schemas remain those below. [machine-learning/immich_ml/video_restoration/app.py:152–181](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/video_restoration/app.py#L152-L181) [machine-learning/immich_ml/video_restoration/app.py:220–307](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/video_restoration/app.py#L220-L307)

## Restoration complete Python wire schemas

All fields, optional/default values, enum alternatives and cross-field validators are reproduced. Every WireModel rejects extra fields. TimeSegment requires endMs \> startMs. Video requires durationMs; still images cannot have segment. Smooth motion requires interpolationFactor, video and scale=1; other modes refuse interpolationFactor/trailingContextFrame. Width/height source bounds are 1–16384, output box 16–3840, seed 0–2147483647. SHA-256 is lowercase 64 hex; frame-rate rational parts are positive 1–9 digit integers.

[machine-learning/immich_ml/video_restoration/schemas.py:18–274](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/video_restoration/schemas.py#L18-L274)

```python

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
    # FL-162 Smooth motion: frame interpolation (RIFE) that adds in-between frames, so a clip plays
    # slower without stutter or at a higher frame rate. It changes timing, never size.
    SMOOTH_MOTION = "smooth_motion"


# The server's ``MlWorkload`` values for each mode. A worker lists a workload in
# ``GET /capabilities`` only while at least one model for that mode is available.
WORKLOAD_BY_MODE: dict[RestorationMode, str] = {
    RestorationMode.FAITHFUL: "restoration-faithful",
    RestorationMode.CREATIVE: "restoration-creative",
    RestorationMode.SMOOTH_MOTION: "interpolation",
}

# How many frames each source frame becomes with Smooth motion.
SUPPORTED_INTERPOLATION_FACTORS = (2, 4, 8)


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
    # Smooth motion only: each source frame becomes this many frames, at this many times the frame
    # rate, so the clip keeps its length and its audio.
    interpolationFactor: Literal[2, 4, 8] | None = None
    # Smooth motion only: the last uploaded frame is the first frame of the next chunk, sent so the
    # frames between the two chunks are made too. It is used as context and not returned.
    trailingContextFrame: bool = False

    @model_validator(mode="after")
    def _kind_fields(self) -> "RestorationRequest":
        if self.kind == "video" and self.source.durationMs is None:
            raise ValueError("a video request needs source.durationMs")
        if self.kind == "image" and self.segment is not None:
            raise ValueError("a still has no segment")
        if self.mode == RestorationMode.SMOOTH_MOTION:
            if self.interpolationFactor is None:
                raise ValueError("a smooth_motion request needs interpolationFactor")
            if self.kind != "video":
                raise ValueError("smooth_motion needs a video")
            if self.scale != 1:
                raise ValueError("smooth_motion keeps the size; scale must be 1")
        elif self.interpolationFactor is not None or self.trailingContextFrame:
            raise ValueError("interpolationFactor and trailingContextFrame are for smooth_motion only")
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
```

## Restoration server-side schemas

These define what the server actually submits and accepts on return. They use shared AssetRestorationMode (`faithful`,`creative`,`smooth_motion`) and upscale (1,2,4), and include capability/model projections into public administrator DTOs. Keep Python and server differences explicit rather than silently merging them into an invented schema.

[server/src/dtos/restoration-inference.dto.ts:1–276](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/dtos/restoration-inference.dto.ts#L1-L276)

```ts
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  AssetRestorationMode,
  AssetRestorationModeSchema,
  AssetRestorationUpscaleSchema,
} from 'src/dtos/asset-restoration.dto.js';
import { MlWorkload, MlWorkloadSchema } from 'src/enum.js';

/**
 * Restoration worker contract (FL-114).
 *
 * One restoration inference is one request and one result between the server and a
 * restoration worker (`machine-learning/immich_ml/video_restoration`). The request travels as
 * the `request` form field of `POST /restoration/restore` beside the `media` file; the result
 * comes back base64url-encoded in the `x-restoration-result` header while the body streams the
 * restored file (MP4 for a video, PNG for a still). A failure answers with a
 * {@link RestorationWorkerErrorSchema} body.
 *
 * This is a worker wire contract, not a public API body: only the capability report is exposed,
 * read-only, to administrators. FL-115's lifecycle reaches it through
 * `MachineLearningRepository.restore`, which implements `RestorationInference` from
 * `src/utils/restoration.ts`. The mode is FL-115's `AssetRestorationMode`.
 *
 * Public contract — KEEP IN SYNC WITH `machine-learning/immich_ml/video_restoration/schemas.py`.
 */

export const RESTORATION_PROTOCOL = 'restoration-v1';
export const RESTORATION_RESULT_HEADER = 'x-restoration-result';
/** No output edge exceeds this; the caller passes the exact 4K box for the orientation. */
export const RESTORATION_MAX_OUTPUT_EDGE = 3840;

const SHA256 = /^[0-9a-f]{64}$/;
const RATIONAL = /^[1-9]\d{0,8}\/[1-9]\d{0,8}$/;

export enum RestorationDynamicRange {
  Sdr = 'sdr',
  Hdr = 'hdr',
}

export const RestorationDynamicRangeSchema = z
  .enum(RestorationDynamicRange)
  .describe('Dynamic range a restoration model accepts')
  .meta({ id: 'RestorationDynamicRange' });

/** Why a restoration inference was refused or failed on the worker. */
export enum RestorationWorkerErrorCode {
  InvalidRequest = 'invalid-request',
  ModelUnavailable = 'model-unavailable',
  /** A full render pinned its preview's model fingerprint and the model has changed since. */
  ModelChanged = 'model-changed',
  UnsupportedInput = 'unsupported-input',
  /** The uploaded bytes disagree with what the server described. */
  SourceMismatch = 'source-mismatch',
  Busy = 'busy',
  OutOfMemory = 'out-of-memory',
  /** Wrong frame count or size, or blank frames where the source had content (NaN output). */
  InvalidOutput = 'invalid-output',
  RuntimeFailed = 'runtime-failed',
  Timeout = 'timeout',
}

/** Why a model can or cannot run. Only `available` admits a request. */
export enum RestorationModelState {
  Available = 'available',
  Verifying = 'verifying',
  NotPinned = 'not-pinned',
  RuntimeMissing = 'runtime-missing',
  RuntimeDirty = 'runtime-dirty',
  WeightsMissing = 'weights-missing',
  WeightsMismatch = 'weights-mismatch',
  Unqualified = 'unqualified',
  LicenseUnreviewed = 'license-unreviewed',
  NoGpu = 'no-gpu',
  GpuUnqualified = 'gpu-unqualified',
  InsufficientVram = 'insufficient-vram',
}

export const RestorationModelStateSchema = z
  .enum(RestorationModelState)
  .describe('Why a restoration model can or cannot run; only available admits a request')
  .meta({ id: 'RestorationModelState' });

// ---------------------------------------------------------------------------------------
// Request and result.
// ---------------------------------------------------------------------------------------

const RestorationWorkerSourceSchema = z.object({
  width: z.int().positive().max(16_384),
  height: z.int().positive().max(16_384),
  /** Required for a video, absent for a still. */
  durationMs: z.int().positive().nullable().optional(),
  frameRate: z.string().regex(RATIONAL).nullable().optional(),
  dynamicRange: RestorationDynamicRangeSchema.nullable().optional(),
  bitDepth: z.int().min(8).max(16).nullable().optional(),
});

export const RestorationWorkerRequestSchema = z
  .object({
    protocol: z.literal(RESTORATION_PROTOCOL),
    /** Echoed in the result; an answer for another request is discarded. */
    requestId: z.string().min(1).max(200),
    mode: AssetRestorationModeSchema,
    kind: z.enum(['image', 'video']),
    /** Null: the worker's available model for the mode. A value names one model exactly. */
    modelId: z.string().min(1).max(64).nullable().optional(),
    /** A full render may pass its preview's fingerprint; a changed model is then refused. */
    modelFingerprint: z.string().regex(SHA256).nullable().optional(),
    scale: AssetRestorationUpscaleSchema,
    maxWidth: z.int().min(16).max(RESTORATION_MAX_OUTPUT_EDGE),
    maxHeight: z.int().min(16).max(RESTORATION_MAX_OUTPUT_EDGE),
    keepGrain: z.boolean(),
    seed: z.int().min(0).max(2_147_483_647),
    /** What the server measured about the upload; the worker re-probes and refuses a mismatch. */
    source: RestorationWorkerSourceSchema,
    /** Smooth motion (FL-162): each source frame becomes this many frames at this many times the rate. */
    interpolationFactor: z
      .union([z.literal(2), z.literal(4), z.literal(8)])
      .nullable()
      .optional(),
    /** Smooth motion: the last uploaded frame is the next chunk's first, sent as context and not returned. */
    trailingContextFrame: z.boolean().optional(),
  })
  .refine((request) => request.kind === 'image' || (request.source.durationMs ?? null) !== null, {
    message: 'A video request needs source.durationMs',
  })
  .refine(
    (request) =>
      request.mode === AssetRestorationMode.SmoothMotion
        ? !!request.interpolationFactor && request.scale === 1 && request.kind === 'video'
        : !request.interpolationFactor && !request.trailingContextFrame,
    { message: 'interpolationFactor is required for smooth_motion (scale 1, video) and refused otherwise' },
  );

export type RestorationWorkerRequest = z.infer<typeof RestorationWorkerRequestSchema>;

const RestorationWeightIdentitySchema = z.object({
  role: z.string(),
  sha256: z.string().regex(SHA256),
});

export const RestorationWorkerResultSchema = z.object({
  protocol: z.literal(RESTORATION_PROTOCOL),
  requestId: z.string(),
  mode: AssetRestorationModeSchema,
  model: z.object({
    id: z.string(),
    family: z.string(),
    mode: AssetRestorationModeSchema,
    revision: z.string(),
    /** Identity of exactly this model and its weights. */
    fingerprint: z.string().regex(SHA256),
    weights: z.array(RestorationWeightIdentitySchema),
    qualificationId: z.string(),
  }),
  output: z.object({
    width: z.int().positive(),
    height: z.int().positive(),
    frameRate: z.string().nullable(),
    frameCount: z.int().positive(),
    durationMs: z.int().nonnegative().nullable(),
    container: z.enum(['mp4', 'png']),
    codec: z.string(),
    dynamicRange: RestorationDynamicRangeSchema,
    bitDepth: z.int(),
    /** `transcoded` when a source codec cannot live in MP4 (PCM, for example) and became AAC. */
    audio: z.enum(['copied', 'transcoded', 'none']),
    bytes: z.int().nonnegative(),
    sha256: z.string().regex(SHA256),
  }),
  timing: z.object({
    decodeMs: z.int().nonnegative(),
    runtimeMs: z.int().nonnegative(),
    encodeMs: z.int().nonnegative(),
    totalMs: z.int().nonnegative(),
    /** Measured frames restored per second of runtime. */
    framesPerSecond: z.number().meta({ format: 'double' }).nonnegative(),
  }),
  /** Device-wide peak GPU memory while the runtime ran, or null when it was not sampled. */
  peakVramBytes: z.int().nonnegative().nullable(),
  seed: z.int(),
  warnings: z.array(z.string()),
});

export type RestorationWorkerResult = z.infer<typeof RestorationWorkerResultSchema>;

export const RestorationWorkerErrorSchema = z.object({
  code: z.enum(RestorationWorkerErrorCode),
  message: z.string(),
  modelId: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------------------
// Capability report.
// ---------------------------------------------------------------------------------------

const RestorationMeasuredThroughputSchema = z
  .object({
    gpu: z.string().describe('GPU the measurement was made on, as nvidia-smi names it'),
    inputWidth: z.int(),
    inputHeight: z.int(),
    frames: z.int(),
    framesPerSecond: z.number().meta({ format: 'double' }).describe('Measured frames restored per second'),
    peakVramBytes: z.number().meta({ format: 'double' }).describe('Measured peak GPU memory'),
  })
  .meta({ id: 'RestorationMeasuredThroughputDto' });

export type RestorationMeasuredThroughput = z.infer<typeof RestorationMeasuredThroughputSchema>;

const RestorationModelCapabilitySchema = z
  .object({
    id: z.string(),
    family: z.string().describe('Model family, for example realbasicvsr or seedvr2'),
    mode: AssetRestorationModeSchema,
    displayName: z.string(),
    revision: z.string().describe('Pinned upstream commit'),
    fingerprint: z
      .string()
      .nullable()
      .describe('Identity of the model and its verified weights, or null until the weights are verified'),
    state: RestorationModelStateSchema,
    reasons: z.array(z.string()).describe('Every reason the model is not available; empty when it is'),
    nativeScale: z.int().nullable().describe('Fixed enlargement the model restores at, or null'),
    maxInputLongEdge: z.int().describe('Largest source long edge the model is qualified for'),
    maxFrames: z.int().describe('Largest number of frames one inference may restore'),
    dynamicRanges: z.array(RestorationDynamicRangeSchema).describe('Source dynamic ranges the model accepts'),
    measured: z
      .array(RestorationMeasuredThroughputSchema)
      .describe('Throughput measured during qualification; estimates come from these'),
    qualificationId: z.string().nullable().describe('Qualification record covering this model, or null'),
  })
  .meta({ id: 'RestorationModelCapabilityDto' });

export type RestorationModelCapability = z.infer<typeof RestorationModelCapabilitySchema>;

const RestorationGpuSchema = z
  .object({
    name: z.string(),
    memoryTotalBytes: z.number().meta({ format: 'double' }),
    driverVersion: z.string(),
  })
  .meta({ id: 'RestorationGpuDto' });

/** The worker's own report (`GET /restoration/models`). Unknown workload names are dropped. */
export const RestorationCapabilityReportSchema = z.object({
  protocol: z.literal(RESTORATION_PROTOCOL),
  workloads: z.array(z.string()),
  models: z.array(RestorationModelCapabilitySchema),
  gpus: z.array(RestorationGpuSchema),
  configurationProblems: z.array(z.string()),
  checkedAt: z.string(),
});

export type RestorationCapabilityReport = Omit<z.infer<typeof RestorationCapabilityReportSchema>, 'workloads'> & {
  workloads: MlWorkload[];
};

const MlRestorationModelsResponseSchema = z
  .object({
    destinationId: z.uuidv4(),
    reachable: z.boolean().describe('Whether the destination answered with a restoration report'),
    error: z.string().nullable().describe('Why no report could be read, or null'),
    workloads: z
      .array(MlWorkloadSchema)
      .describe('Restoration workloads the destination serves now; empty unless a model is available'),
    models: z.array(RestorationModelCapabilitySchema),
    gpus: z.array(RestorationGpuSchema),
    configurationProblems: z
      .array(z.string())
      .describe('Problems reading the model manifest or qualification evidence on the destination'),
    checkedAt: z.string().nullable().describe('When the destination last verified its models, or null'),
  })
  .meta({ id: 'MlRestorationModelsResponseDto' });

export class MlRestorationModelsResponseDto extends createZodDto(MlRestorationModelsResponseSchema) {}
export class RestorationModelCapabilityDto extends createZodDto(RestorationModelCapabilitySchema) {}
```

## Restoration error status map

`busy` also returns Retry-After:30. `model-changed` requires a fresh preview/model binding. The exact error-code → status map is:

[machine-learning/immich_ml/video_restoration/models.py:109–120](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/machine-learning/immich_ml/video_restoration/models.py#L109-L120)

```python
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

```

## Render-worker operation/model index

Worker base `/api/render-workers` is HomeNetworkOnly. Admission uses enrollment secret and conformance evidence; all later calls use `x-frameleaf-worker-session`. Body claimToken is required where the DTO declares it. Artifact binary calls additionally take `x-render-claim-token`; inputs use a path grant bound to operation/session/claim. Returned `accepted:false` is an authorization/lease refusal, even with HTTP success.

| Worker suffix                                      | Request model/carrier                                    | Response                                        |
| -------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| POST admission                                     | RenderWorkerAdmissionDto                                 | 201 RenderWorkerSessionDto                      |
| POST claims                                        | RenderWorkerClaimRequestDto                              | RenderWorkerClaimDto or 204                     |
| POST operations/:id/heartbeat                      | RenderWorkerHeartbeatDto                                 | RenderWorkerHeartbeatResponseDto                |
| POST operations/:id/progress                       | RenderWorkerProgressDto                                  | RenderWorkerWriteResultDto                      |
| POST operations/:id/checkpoints                    | RenderWorkerCheckpointPlanDto                            | RenderWorkerWriteResultDto                      |
| POST operations/:id/checkpoints/:sequence/complete | RenderWorkerCheckpointCompleteDto                        | RenderWorkerWriteResultDto                      |
| POST operations/:id/validate                       | RenderWorkerCompleteDto                                  | RenderWorkerWriteResultDto                      |
| POST operations/:id/complete                       | RenderWorkerCompleteDto                                  | RenderWorkerWriteResultDto                      |
| POST operations/:id/fail                           | RenderWorkerFailDto                                      | RenderWorkerWriteResultDto                      |
| POST operations/:id/cancel-ack                     | RenderWorkerCancelAckDto                                 | RenderWorkerWriteResultDto                      |
| POST operations/:id/stream                         | RenderWorkerStreamSignalRequestDto                       | RenderWorkerStreamSignalDto                     |
| POST operations/:id/stream/offer                   | RenderWorkerStreamOfferDto                               | RenderWorkerWriteResultDto                      |
| GET remote-references                              | session header                                           | RenderWorkerRemoteReferenceDto[]                |
| POST remote-references/:id/acknowledge             | session header/path ID                                   | RenderWorkerWriteResultDto                      |
| PUT operations/:id/artifacts/:sequence             | raw bytes + RenderWorkerArtifactDto query + claim header | RenderWorkerWriteResultDto                      |
| GET operations/:id/artifacts/:sequence             | RenderWorkerArtifactReadDto query + claim header         | octet-stream; Digest:sha-256=\<base64\>, no-store |
| GET operations/:id/inputs/:grant                   | OperationInputParamDto path + session header             | binary input                                    |

Admin models below cover identity creation/update/listing, limits, audit, compatibility and revocation. The accompanying operation reference supplies every administrator route. `snapshot` and `settings` are arbitrary JSON object schemas at this HTTP boundary; their operation-kind-specific semantics are not a single invented closed wire model.

[server/src/controllers/render-worker.controller.ts:234–541](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/render-worker.controller.ts#L234-L541)

## Render-worker complete DTO constraints

Exact declarations include all request/response models, helper fields and class-to-schema names. `BigIntString` is a **decimal string**, never a JSON number. Important service checks are stronger than these schemas: Studio export completion requires resultAssetId=null and the verified whole-export checkpoint; the schema permits artifactSequence only 0. Legacy output paths are constrained again by service publication; exposing a path field here is restricted worker protocol, not an invitation for user API path writes.

[server/src/dtos/render-worker.dto.ts:1–427](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/dtos/render-worker.dto.ts#L1-L427)

```ts
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MediaOperationCheckpointDto } from 'src/dtos/media-operation.dto.js';
import {
  MediaOperationDestinationSchema,
  MediaOperationKindSchema,
  MediaOperationStatus,
  RenderWorkerAuditEventSchema,
  RenderWorkerRefusalReasonSchema,
  RenderWorkerStatusSchema,
  StudioExportRemoteReasonSchema,
} from 'src/enum.js';

const JsonObjectSchema = z.record(z.string(), z.unknown());

/** Bigint columns cross the wire as decimal strings, the way `MediaOperationDto` already does it. */
const BigIntString = z.string().regex(/^\d+$/, 'must be a non-negative integer string');

/* ------------------------------------------------------------------ */
/* Administrator: identities                                            */
/* ------------------------------------------------------------------ */

/**
 * A worker identity as the administrator sees it.
 *
 * Deliberately absent: the enrolment secret and any session credential. The secret is shown once,
 * on creation, in `RenderWorkerCreateResponseDto`; a session is only ever shown to the worker it
 * was issued to.
 */
const RenderWorkerSchema = z
  .object({
    id: z.uuidv7().describe('Render worker ID'),
    name: z.string().describe('What the administrator calls this worker'),
    destination: MediaOperationDestinationSchema,
    status: RenderWorkerStatusSchema,
    kinds: z.array(MediaOperationKindSchema).describe('Operation kinds this worker may claim'),
    engineDigest: z.string().nullable().describe('Engine and patch digest the worker must keep reporting'),
    conformanceMaxAgeMs: z.int().describe('Oldest conformance evidence admission accepts, in milliseconds'),
    maxConcurrentOperations: z.int().describe('Operations this worker may hold at once'),
    maxWallClockMs: z.string().nullable().describe('Longest one operation may run here, in milliseconds'),
    maxOutputBytes: z.string().nullable().describe('Most output bytes one operation may produce here'),
    gpuMemoryBytes: z.string().nullable().describe('GPU memory the worker was qualified with, in bytes'),
    activeOperations: z.int().describe('Operations the worker currently holds'),
    lastAdmittedAt: z.string().meta({ format: 'date-time' }).nullable(),
    lastSeenAt: z.string().meta({ format: 'date-time' }).nullable(),
    revokedAt: z.string().meta({ format: 'date-time' }).nullable(),
    createdAt: z.string().meta({ format: 'date-time' }),
    updatedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'RenderWorkerDto' });

const RenderWorkerLimitFieldsSchema = {
  maxConcurrentOperations: z.int().min(1).max(64).optional(),
  maxWallClockMs: BigIntString.nullable().optional(),
  maxOutputBytes: BigIntString.nullable().optional(),
};

const RenderWorkerCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    destination: MediaOperationDestinationSchema,
    kinds: z.array(MediaOperationKindSchema).min(1).describe('Operation kinds this worker may claim'),
    engineDigest: z.string().trim().min(1).max(200).nullable().optional(),
    conformanceMaxAgeMs: z.int().min(60_000).optional(),
    gpuMemoryBytes: BigIntString.nullable().optional(),
    ...RenderWorkerLimitFieldsSchema,
  })
  .meta({ id: 'RenderWorkerCreateDto' });

/** The one time the enrolment secret is visible. It is stored hashed and cannot be recovered. */
const RenderWorkerCreateResponseSchema = z
  .object({
    worker: RenderWorkerSchema,
    enrolmentSecret: z.string().describe('Shown once. Give it to the worker; the server keeps only its hash'),
  })
  .meta({ id: 'RenderWorkerCreateResponseDto' });

const RenderWorkerUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    kinds: z.array(MediaOperationKindSchema).min(1).optional(),
    engineDigest: z.string().trim().min(1).max(200).nullable().optional(),
    conformanceMaxAgeMs: z.int().min(60_000).optional(),
    gpuMemoryBytes: BigIntString.nullable().optional(),
    ...RenderWorkerLimitFieldsSchema,
  })
  .meta({ id: 'RenderWorkerUpdateDto' });

/* ------------------------------------------------------------------ */
/* Administrator: limits and audit                                      */
/* ------------------------------------------------------------------ */

const RenderWorkerLimitSchema = z
  .object({
    subject: z.string().describe('`instance` for the default, otherwise a user ID'),
    userId: z.uuidv4().nullable(),
    maxConcurrentOperations: z.int().describe('Operations one account may have claimed at once'),
    maxWallClockMs: z.string().nullable(),
    maxOutputBytes: z.string().nullable(),
    updatedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'RenderWorkerLimitDto' });

const RenderWorkerLimitsResponseSchema = z
  .object({
    instance: RenderWorkerLimitSchema,
    users: z.array(RenderWorkerLimitSchema),
  })
  .meta({ id: 'RenderWorkerLimitsResponseDto' });

const RenderWorkerLimitUpdateSchema = z
  .object({
    userId: z.uuidv4().nullable().optional().describe('Omit or null for the instance default'),
    maxConcurrentOperations: z.int().min(0).max(64),
    maxWallClockMs: BigIntString.nullable(),
    maxOutputBytes: BigIntString.nullable(),
  })
  .meta({ id: 'RenderWorkerLimitUpdateDto' });

const RenderWorkerAuditSchema = z
  .object({
    id: z.uuidv7(),
    workerId: z.uuidv7().nullable(),
    event: RenderWorkerAuditEventSchema,
    reason: RenderWorkerRefusalReasonSchema.nullable(),
    operationId: z.uuidv7().nullable(),
    actorId: z.uuidv4().nullable().describe('The administrator who acted, when one did'),
    detail: JsonObjectSchema.nullable().describe('Operator detail. Never a secret, never a path'),
    createdAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'RenderWorkerAuditDto' });

const RenderWorkerAuditSearchSchema = z
  .object({
    workerId: z.uuidv7().optional(),
    take: z.coerce.number().int().min(1).max(500).default(100).optional(),
  })
  .meta({ id: 'RenderWorkerAuditSearchDto' });

/* ------------------------------------------------------------------ */
/* Worker: admission                                                    */
/* ------------------------------------------------------------------ */

/**
 * What a worker presents to be admitted. The secret is compared by digest; the rest is the
 * evidence admission binds the session to. Nothing here is stored in the clear.
 */
const RenderWorkerAdmissionSchema = z
  .object({
    workerId: z.uuidv7(),
    enrolmentSecret: z.string().min(16),
    engineDigest: z.string().trim().min(1).max(200).describe('Digest of the engine and patches actually loaded'),
    conformanceReportedAt: z.string().meta({ format: 'date-time' }).describe('When the conformance check ran'),
    softwareRenderer: z.boolean().describe('True when the renderer is a software or fallback device'),
    gpuMemoryBytes: BigIntString.nullable().describe('GPU memory measured by the conformance check'),
    codecs: z.array(z.string().max(60)).max(64).optional().describe('Encoder and decoder names the check verified'),
    colorPrecision: z
      .object({
        maxBitDepth: z.int().min(8).max(16).describe('Highest bit depth the check rendered and verified'),
        hdr10: z.boolean().describe('The check verified HDR10 (PQ, BT.2020) output'),
        dolbyVision: z.boolean().describe('The check verified Dolby Vision output'),
      })
      .optional()
      .describe('Colour precision the conformance check verified; absent means 8-bit SDR only (FL-42)'),
    formats: z
      .array(z.string().max(30))
      .max(32)
      .optional()
      .describe('Containers the check verified writing, such as `mp4`, `webm` or `mov`'),
  })
  .meta({ id: 'RenderWorkerAdmissionDto' });

const RenderWorkerSessionSchema = z
  .object({
    workerId: z.uuidv7(),
    sessionToken: z.string().describe('Present as the x-frameleaf-worker-session header on every worker call'),
    expiresAt: z.string().meta({ format: 'date-time' }),
    scopes: z.array(MediaOperationKindSchema),
    leaseMs: z.int().describe('How long a claim lasts without a heartbeat'),
    heartbeatIntervalMs: z.int().describe('How often the worker should heartbeat a held claim'),
  })
  .meta({ id: 'RenderWorkerSessionDto' });

/* ------------------------------------------------------------------ */
/* Worker: claims                                                       */
/* ------------------------------------------------------------------ */

const RenderWorkerClaimRequestSchema = z
  .object({
    kinds: z.array(MediaOperationKindSchema).min(1).optional().describe('Narrow the claim to these kinds'),
  })
  .meta({ id: 'RenderWorkerClaimRequestDto' });

const RenderWorkerInputGrantSchema = z
  .object({
    inputId: z.string().describe('FL-90 resource key, or `source` for a single-asset workload'),
    kind: z.string().describe('Resource class: library-asset, edited-master, font, lut, …'),
    resourceId: z.string().describe('Asset or resource id. Never a path'),
    checksum: z.string().nullable().describe('Digest the manifest was resolved against, when known'),
    url: z.string().describe('Relative URL, valid for this claim only and only until expiresAt'),
    expiresAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'RenderWorkerInputGrantDto' });

const RenderWorkerClaimLimitsSchema = z
  .object({
    maxWallClockMs: z.string().nullable(),
    maxOutputBytes: z.string().nullable(),
  })
  .meta({ id: 'RenderWorkerClaimLimitsDto' });

/**
 * What a worker is handed when it claims. There is no owner, no label and no asset path here:
 * the worker gets the immutable snapshot, the checkpoints it may resume from and grants for the
 * inputs the authorized manifest allows.
 */
const RenderWorkerClaimSchema = z
  .object({
    operationId: z.uuidv7(),
    kind: MediaOperationKindSchema,
    claimToken: z.uuid().describe('Required on every write to this operation'),
    leaseMs: z.int(),
    projectId: z.string().nullable(),
    revisionId: z.string().nullable(),
    snapshot: JsonObjectSchema,
    settings: JsonObjectSchema,
    attempt: z.int(),
    checkpoints: z.array(MediaOperationCheckpointDto.schema),
    artifactInputDigest: z
      .string()
      .regex(/^[a-f\d]{64}$/)
      .optional()
      .describe('Server source/revision binding required by whole-export checkpoint plans'),
    inputs: z.array(RenderWorkerInputGrantSchema),
    limits: RenderWorkerClaimLimitsSchema,
  })
  .meta({ id: 'RenderWorkerClaimDto' });

const ClaimTokenSchema = z.uuid().describe('The claim token this operation was handed out with');

const RenderWorkerHeartbeatSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    outputBytes: BigIntString.optional().describe('Total output bytes produced so far'),
  })
  .meta({ id: 'RenderWorkerHeartbeatDto' });

const RenderWorkerHeartbeatResponseSchema = z
  .object({
    leaseExtended: z.boolean(),
    leaseMs: z.int(),
    cancelRequested: z.boolean().describe('The owner asked to stop; acknowledge with cancel-ack'),
    pauseRequested: z
      .boolean()
      .describe('The owner paused the job and its claim has been handed back; stop without reporting a failure'),
    refusal: RenderWorkerRefusalReasonSchema.nullable().describe('Set when a limit stopped the operation'),
  })
  .meta({ id: 'RenderWorkerHeartbeatResponseDto' });

const RenderWorkerProgressSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    status: z.enum([MediaOperationStatus.Preparing, MediaOperationStatus.Rendering]),
    processedUnits: z.int().min(0),
    totalUnits: z.int().min(0).nullable(),
    outputBytes: BigIntString.optional(),
  })
  .meta({ id: 'RenderWorkerProgressDto' });

const RenderWorkerCheckpointPlanSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    sequence: z.int().min(0),
    chunkKey: z.string().min(1),
    inputDigest: z.string().min(1),
    historyDigest: z.string().min(1),
    configDigest: z.string().min(1),
    seed: z.string().nullable(),
    timebase: z.string().regex(/^\d+\/\d+$/, 'rational timebase, e.g. 30000/1001'),
    startTicks: BigIntString,
    endTicks: BigIntString,
    prerollTicks: BigIntString.optional(),
    requiresSequentialContext: z.boolean().optional(),
  })
  .meta({ id: 'RenderWorkerCheckpointPlanDto' });

const RenderWorkerArtifactSchema = z
  .object({
    chunkKey: z.string().min(1).max(256),
    checksum: z.string().regex(/^[\da-f]{64}$/i, 'SHA-256 hex digest'),
    sizeInBytes: BigIntString,
  })
  .meta({ id: 'RenderWorkerArtifactDto' });

const RenderWorkerArtifactReadSchema = RenderWorkerArtifactSchema.pick({ chunkKey: true }).meta({
  id: 'RenderWorkerArtifactReadDto',
});

const RenderWorkerCheckpointCompleteSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    chunkKey: z.string().min(1).describe('Must match the planned chunk; a re-planned chunk cannot be completed'),
    outputPath: z.string().min(1),
    outputChecksum: z.string().regex(/^[\da-f]+$/i, 'hex digest'),
    sizeInBytes: BigIntString,
  })
  .meta({ id: 'RenderWorkerCheckpointCompleteDto' });

/**
 * The file a Studio export render produced (FL-106). It must be inside the directory the claim
 * named for this render; publication hashes it again and never trusts the worker's word alone.
 */
const RenderWorkerOutputSchema = z
  .object({
    path: z.string().min(1).max(4096).describe('Absolute path inside the render directory the claim named'),
    checksum: z
      .string()
      .regex(/^[\da-f]{64}$/i, 'SHA-256 hex digest')
      .describe('SHA-256 of the whole file'),
    sizeInBytes: BigIntString,
    contentType: z.string().min(1).max(100).describe('`video/mp4`, `video/webm` or `video/quicktime`'),
    remoteRef: z
      .string()
      .min(1)
      .max(512)
      .nullable()
      .optional()
      .describe('What the worker calls a copy it kept; it is asked to delete it until it acknowledges'),
  })
  .meta({ id: 'RenderWorkerOutputDto' });

const RenderWorkerCompleteSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    resultAssetId: z
      .uuidv4()
      .nullable()
      .describe('Must be null for a Studio export: its result is adopted by publication, never named by a worker'),
    output: RenderWorkerOutputSchema.optional().describe('Legacy non-export render output'),
    artifactSequence: z
      .int()
      .min(0)
      .max(0)
      .optional()
      .describe('Server-verified whole-export checkpoint; required for Studio exports'),
  })
  .meta({ id: 'RenderWorkerCompleteDto' });

const RenderWorkerFailSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    error: z.string().max(4000),
    errorCode: z.string().min(1).max(80),
  })
  .meta({ id: 'RenderWorkerFailDto' });

const RenderWorkerCancelAckSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    released: z.boolean().describe('True when remote resources are confirmed gone'),
  })
  .meta({ id: 'RenderWorkerCancelAckDto' });

/** Something this worker holds for a Studio export that it must stop or delete (FL-106). */
const RenderWorkerRemoteReferenceSchema = z
  .object({
    id: z.uuidv7(),
    operationId: z.uuidv7().describe('The render job'),
    reason: StudioExportRemoteReasonSchema,
    remoteRef: z.string().nullable().describe('The copy to delete, for a `delete` reference'),
    requestedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'RenderWorkerRemoteReferenceDto' });

/** The answer to every guarded write. `accepted: false` means the claim no longer authorizes it. */
const RenderWorkerWriteResultSchema = z
  .object({
    accepted: z.boolean(),
    refusal: RenderWorkerRefusalReasonSchema.nullable(),
  })
  .meta({ id: 'RenderWorkerWriteResultDto' });

export class RenderWorkerDto extends createZodDto(RenderWorkerSchema) {}
export class RenderWorkerCreateDto extends createZodDto(RenderWorkerCreateSchema) {}
export class RenderWorkerCreateResponseDto extends createZodDto(RenderWorkerCreateResponseSchema) {}
export class RenderWorkerUpdateDto extends createZodDto(RenderWorkerUpdateSchema) {}
export class RenderWorkerLimitDto extends createZodDto(RenderWorkerLimitSchema) {}
export class RenderWorkerLimitsResponseDto extends createZodDto(RenderWorkerLimitsResponseSchema) {}
export class RenderWorkerLimitUpdateDto extends createZodDto(RenderWorkerLimitUpdateSchema) {}
export class RenderWorkerAuditDto extends createZodDto(RenderWorkerAuditSchema) {}
export class RenderWorkerAuditSearchDto extends createZodDto(RenderWorkerAuditSearchSchema) {}
export class RenderWorkerAdmissionDto extends createZodDto(RenderWorkerAdmissionSchema) {}
export class RenderWorkerSessionDto extends createZodDto(RenderWorkerSessionSchema) {}
export class RenderWorkerClaimRequestDto extends createZodDto(RenderWorkerClaimRequestSchema) {}
export class RenderWorkerInputGrantDto extends createZodDto(RenderWorkerInputGrantSchema) {}
export class RenderWorkerClaimLimitsDto extends createZodDto(RenderWorkerClaimLimitsSchema) {}
export class RenderWorkerClaimDto extends createZodDto(RenderWorkerClaimSchema) {}
export class RenderWorkerHeartbeatDto extends createZodDto(RenderWorkerHeartbeatSchema) {}
export class RenderWorkerHeartbeatResponseDto extends createZodDto(RenderWorkerHeartbeatResponseSchema) {}
export class RenderWorkerProgressDto extends createZodDto(RenderWorkerProgressSchema) {}
export class RenderWorkerCheckpointPlanDto extends createZodDto(RenderWorkerCheckpointPlanSchema) {}
export class RenderWorkerCheckpointCompleteDto extends createZodDto(RenderWorkerCheckpointCompleteSchema) {}
export class RenderWorkerCompleteDto extends createZodDto(RenderWorkerCompleteSchema) {}
export class RenderWorkerOutputDto extends createZodDto(RenderWorkerOutputSchema) {}
export class RenderWorkerRemoteReferenceDto extends createZodDto(RenderWorkerRemoteReferenceSchema) {}
export class RenderWorkerFailDto extends createZodDto(RenderWorkerFailSchema) {}
export class RenderWorkerCancelAckDto extends createZodDto(RenderWorkerCancelAckSchema) {}
export class RenderWorkerWriteResultDto extends createZodDto(RenderWorkerWriteResultSchema) {}

/**
 * FL-71 (CC-9): which render kinds have a qualified GPU worker right now, for the Overview's "GPU
 * Studio" and "Check worker compatibility" (CommandCenter.jsx:1800-1812, 1911-1914). A kind is
 * qualified while a live, unrevoked session carrying fresh conformance on its worker's engine digest
 * is scoped to it (`isQualifiedRenderSession`).
 */
const RenderWorkerCompatibilityResponseSchema = z
  .object({
    qualified: z.array(MediaOperationKindSchema).describe('Render kinds a qualified worker can take now'),
    unavailable: z.array(MediaOperationKindSchema).describe('Render kinds no qualified worker can take now'),
  })
  .meta({ id: 'RenderWorkerCompatibilityResponseDto' });

export class RenderWorkerCompatibilityResponseDto extends createZodDto(RenderWorkerCompatibilityResponseSchema) {}

export class RenderWorkerArtifactDto extends createZodDto(RenderWorkerArtifactSchema) {}

export class RenderWorkerArtifactReadDto extends createZodDto(RenderWorkerArtifactReadSchema) {}
```

## Studio export settings and declared worker contract

`StudioExportCreateDto.quality` accepts `low`, `medium`, `high` or `ultra`; omission stores `high`. Quality is independent of format, color, resolution and audio. `StudioExportSettingsDto.quality` remains optional for older readbacks. The generated DTO models include optional `range` and `mastering`; settings retain the choices fixed at submission. [server/src/dtos/studio-export.dto.ts:44–146](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/dtos/studio-export.dto.ts#L44-L146) [server/src/services/studio-export.service.ts:332–351](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/services/studio-export.service.ts#L332-L351)

`range: {inPoint, outPoint}` selects main-timeline frames: `inPoint` is included, `outPoint` is excluded, and omission exports the whole timeline. Bounds must be safe integers with `0 <= inPoint < outPoint`, within a non-empty timeline with an exact project cadence. Nested compositions are refused. Ranges require the recorded output cadence decision to be `convert`; timestamp passthrough is unsupported. The worker contract records the selected bounds and rational cadence, and output starts at zero. Audio expectations consider only audible items overlapping that range. A timing refusal is 409 `studio_export_timing_unknown`. [server/src/utils/studio-export-contract.ts:108–145](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/studio-export-contract.ts#L108-L145) [server/src/utils/studio-export-contract.ts:172–191](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/studio-export-contract.ts#L172-L191) [server/src/services/studio-export.service.ts:415–443](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/services/studio-export.service.ts#L415-L443)

PQ output (`smpte2084`, including HDR10 or preserved PQ) requires an explicit `mastering: {primaries: "bt2020", maxNits, minNits}`. The strict schema fixes BT.2020 primaries and D65 white; both luminances are at most 10000 nits and use 0.0001-nit increments, with `maxNits > minNits >= 0`. Source content-light metadata and preview defaults do not supply this authority. A supplied mastering profile is refused for HLG/SDR. A mastering refusal is 409 `studio_export_mastering_unknown`. Existing Dolby rights and worker-qualification gates still apply. [server/src/utils/studio-export-contract.ts:55–70](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/studio-export-contract.ts#L55-L70) [server/src/utils/studio-export-contract.ts:367–382](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/studio-export-contract.ts#L367-L382) [server/src/services/studio-export.service.ts:294–313](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/services/studio-export.service.ts#L294-L313) [server/src/services/studio-export.service.ts:435–440](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/services/studio-export.service.ts#L435-L440)

The export snapshot sent to the worker contains the declared timing and contract below. Publication requires settings and contract range bounds to agree, exact constant-cadence packet evidence for the selected frame count and zero-based presentation span, and matching PQ mastering-display side data with exact rational primaries, white point and luminances. Missing or mismatched evidence refuses publication. The mastering profile also enters the worker artifact input digest. [server/src/services/studio-export.service.ts:1105–1149](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/services/studio-export.service.ts#L1105-L1149) [server/src/utils/studio-export-contract.ts:410–449](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/studio-export-contract.ts#L410-L449) [server/src/utils/studio-export-contract.ts:499–528](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/studio-export-contract.ts#L499-L528) [server/src/services/render-worker.service.ts:252–263](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/services/render-worker.service.ts#L252-L263)

[server/src/utils/studio-export-contract.ts:55–98](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/studio-export-contract.ts#L55-L98)

```ts
export const STUDIO_EXPORT_AUDIO = ['preserve', 'stereo'] as const;
export type StudioExportAudio = (typeof STUDIO_EXPORT_AUDIO)[number];
export type StudioExportRange = { inPoint: number; outPoint: number };

/** Explicit export authority, never a source's content-light values or a preview assumption. */
export const StudioExportMasteringSchema = z
  .object({
    primaries: z.literal('bt2020').describe('Declared BT.2020 mastering display primaries and D65 white point'),
    maxNits: z.number().positive().max(10_000).multipleOf(0.0001).meta({ format: 'double' }),
    minNits: z.number().nonnegative().max(10_000).multipleOf(0.0001).meta({ format: 'double' }),
  })
  .strict()
  .refine((value) => value.maxNits > value.minNits, 'Mastering maximum must exceed its minimum')
  .meta({ id: 'StudioExportMastering' });
export type StudioExportMastering = z.infer<typeof StudioExportMasteringSchema>;
export class StudioExportMasteringError extends Error {}

export type StudioExportTiming = {
  /** The project cadence the graph declares, `num/den`. */
  cadence: string;
  decision: { mode: OutputCadenceMode; cadence: string | null; reason: string };
  /** Seconds per tick of the output grid every chunk boundary is expressed in. */
  timeBase: string;
  sources: StudioSourceTiming[];
};

export type StudioExportContract = {
  /** Main-timeline frame selection; the output is rebased to zero at this exact cadence. */
  range?: StudioExportRange & { cadence: string };
  video: {
    minBitDepth: 8 | 10;
    transfer: 'smpte2084' | 'arib-std-b67' | null;
    /** Absent only on HLG/SDR or contracts written before explicit PQ mastering existed. */
    mastering?: StudioExportMastering;
  };
  audio: {
    policy: StudioExportAudio;
    channels: number | null;
    channelLayout: string | null;
    sampleRate: number | null;
  } | null;
};

type GraphItem = Record<string, unknown>;
```

`StudioExportCreateDto.subtitleMode` optionally accepts `burn` or `off`; omission uses the native `burn` default. The server stores the field only when explicitly supplied, and older `StudioExportSettingsDto` readbacks may omit it. `off` omits subtitle captions while preserving ordinary title overlays. This setting does not change export admission or PQ mastering requirements. [server/src/dtos/studio-export.dto.ts:46–122](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/dtos/studio-export.dto.ts#L46-L122) [server/src/utils/studio-export.ts:61–65](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/studio-export.ts#L61-L65) [server/src/services/studio-export.service.ts:338–347](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/services/studio-export.service.ts#L338-L347)

The Studio dialog starts with blank mastering display limits. HDR10 requires a profile; Preserve offers an explicit PQ declaration because an HDR source flag does not distinguish PQ from HLG. Turning the declaration off omits the profile, and reopening clears it. The host forwards the chosen profile; the server still decides from source transfer and worker qualification. [studio/render-worker-claim.md:114–138](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/studio/render-worker-claim.md#L114-L138)

## Render-worker enum dependencies

All enum values imported by these models are listed below. Schema acceptance of a MediaOperationKind does not mean every worker may claim it; admitted scopes and service eligibility decide that.

[server/src/enum.ts:1301–1418](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/enum.ts#L1301-L1418)

```ts
export enum MediaOperationKind {
  /** A Studio project render to a finished file. */
  StudioExport = 'studio_export',
  /** A short Studio preview render; same graph, bounded range. */
  StudioPreview = 'studio_preview',
  /** Internal local source-level reversal; not a timeline clip command. */
  StudioReverseConform = 'studio_reverse_conform',
  /**
   * A bounded WebRTC playback session of a stored Studio revision (FL-96): the worker holding the
   * claim streams to the browser that opened it, signalled and authorised through the server. It
   * lives as long as its lease, its keepalive and its bound allow, and never produces a file.
   */
  StudioPreviewStream = 'studio_preview_stream',
  /** A video restoration render. */
  Restoration = 'restoration',
  /** The five-second restoration motion preview a full render must inherit from. */
  RestorationPreview = 'restoration_preview',
  /** A still-image edit recipe render. */
  QuickEdit = 'quick_edit',
  /**
   * A library bulk operation over a frozen set of assets (FL-32). The server applies the action in
   * batches through the same services a single request would use, so it survives the browser.
   */
  Bulk = 'bulk',
  /**
   * A portable Studio project bundle written for download (FL-91): the project document, a
   * manifest with digests, and either references to or copies of the sources it uses.
   */
  StudioBundleExport = 'studio_bundle_export',
  /** A portable Studio project bundle read back into a new project of the importer's (FL-91). */
  StudioBundleImport = 'studio_bundle_import',
  /**
   * An enrichment plan over a frozen set of assets (FL-59): the chosen stages (descriptions, the
   * Locked-content check, reusable video frames, the moment index, optional moment captions) run
   * asset by asset on the destinations pinned at submit, with a per-asset state for every stage.
   */
  EnrichmentPlan = 'enrichment_plan',
  /**
   * Library Care (FL-69): an owner's media health scan, or a search of chosen locations for the
   * originals of missing or damaged media. It records a resume cursor after every batch, so it can
   * pause, survive a restart and carry on where it stopped.
   */
  MediaHealth = 'media_health',
  /**
   * One run of an iCloud Photos connection (FL-68): inventory, transfers and reconciliation. The
   * connection's own tables are its checkpoints, so a claim resumes wherever the last one stopped.
   */
  ICloudSync = 'icloud_sync',
  /**
   * A Google Photos import step (FL-65): scanning staged Takeout sources, or importing the reviewed
   * items into the owner's library. The import it works on is named in the snapshot; every step
   * records what it has done per file, so a resumed or retried run carries on without repeating it.
   */
  TakeoutImport = 'takeout_import',
  /**
   * Physical deduplication (FL-73): an administrator's reviewed plan applied copy by copy. The
   * snapshot freezes exactly the copies the reviewed plan listed with their checksum and reference
   * evidence; every copy is checked again before its file is shared, and the job records each one,
   * so it can pause, survive a restart and carry on without applying anything twice.
   */
  PhysicalDeduplication = 'physical_deduplication',
  /**
   * An external library scan (FL-78): checks the library's import folders are reachable, imports new
   * files, then checks every indexed item against its folder. It records its phase and cursor after
   * every batch, so it can pause, survive a restart and carry on; an unreachable or emptied folder
   * fails the scan instead of marking the library's items missing.
   */
  LibraryScan = 'library_scan',
  /**
   * A preservation package written from a frozen selection of the owner's originals (FL-74):
   * independent copies with checksums, metadata sidecars, albums, people, tags and edit recipes.
   */
  PreservationExport = 'preservation_export',
  /** A preservation package's files checked against its manifest, item by item (FL-74). */
  PreservationVerify = 'preservation_verify',
  /**
   * A package read for restoration (FL-74): verified and compared with the library, item by item,
   * so the owner can review conflicts. Nothing in the library is written.
   */
  PreservationReview = 'preservation_review',
  /** A reviewed package restored into the owner's library, never over an existing original (FL-74). */
  PreservationRestore = 'preservation_restore',
  /**
   * Publication of a validated Studio export (FL-106): the rendered file is checked against the
   * checksum its render reported, every source is checked again for the owner's current access,
   * the union of the sources' Locked and sensitive evidence is installed and only then does the
   * result become a new version, in one transaction. Runs on this server's own workers, never on a
   * render worker, and gets the one automatic retry every job gets.
   */
  StudioExportPublish = 'studio_export_publish',
  /**
   * FL-163 (`CLD-203`): one Frameleaf Cloud description batch, a frozen set of one owner's photos sent as
   * one cloud job. The snapshot pins the destination, model, pack key and idempotency key; the result
   * records the estimate, the cloud job and every photo's input, and the job is polled until it ends.
   */
  CloudDescriptionBatch = 'cloud_description_batch',
  /**
   * FL-162 (`CLD-202`): a Frameleaf Cloud restoration, upscaling or Smooth motion job for one asset,
   * preview or full. The snapshot pins the prepared inputs, model, request, estimate and consent; the
   * result records the cloud job, so a restart resumes it by its id and never submits it twice.
   */
  CloudMlJob = 'cloud_ml_job',
  /**
   * A cloud backup run (FL-160): the database dump, then every original, sidecar and profile image by
   * SHA-256 into the claimed bucket (each unique file uploaded once), then the run's manifest. It
   * records its cursor every 25 assets, so it can pause, survive a restart and resume the same manifest.
   */
  CloudBackup = 'cloud_backup',
  /**
   * A restore from a cloud backup manifest (FL-164): files to `<media>/frameleaf/restore/<id>` for Library
   * Care, one asset back to its place, the database dump into `<media>/backups` for the maintenance
   * restore, or the whole library. Every object is fetched with the bucket key (SSE-C) and checked against
   * its SHA-256 before it is written; a mismatch stops the restore with a report.
   */
  CloudRestore = 'cloud_restore',
  BuddyBackup = 'buddy_backup',
  BuddyRestore = 'buddy_restore',
}
```

[server/src/enum.ts:1705–1719](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/enum.ts#L1705-L1719)

```ts
export enum MediaOperationStatus {
  Queued = 'queued',
  Preparing = 'preparing',
  Rendering = 'rendering',
  Validating = 'validating',
  Completed = 'completed',
  Cancelling = 'cancelling',
  Cancelled = 'cancelled',
  Failed = 'failed',
  /**
   * Held by its owner (FL-104, owner request September 23, 2026). No worker claims a paused job;
   * resuming puts it back in the queue and the next claim carries on from its checkpoints.
   */
  Paused = 'paused',
}
```

[server/src/enum.ts:1730–1737](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/enum.ts#L1730-L1737)

```ts
export enum MediaOperationDestination {
  /** This server's own hardware. */
  Local = 'local',
  /** A qualified worker on the home network. */
  Lan = 'lan',
  /** Frameleaf Cloud (FL-159). Chosen by the person, never as a fallback. */
  FrameleafCloud = 'frameleaf-cloud',
}
```

[server/src/enum.ts:1745–1752](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/enum.ts#L1745-L1752)

```ts
export enum MediaOperationCheckpointState {
  /** Claimed or planned, not yet proven. */
  Pending = 'pending',
  /** Rendered and validated; reusable when every digest still matches. */
  Complete = 'complete',
  /** Known not to describe the current inputs; never reusable. */
  Invalid = 'invalid',
}
```

[server/src/enum.ts:1814–1817](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/enum.ts#L1814-L1817)

```ts
export enum RenderWorkerStatus {
  Active = 'active',
  Revoked = 'revoked',
}
```

[server/src/enum.ts:1825–1845](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/enum.ts#L1825-L1845)

```ts
export enum RenderWorkerAuditEvent {
  /** An administrator created the identity. */
  Enrolled = 'enrolled',
  /** A worker presented a valid enrolment secret and fresh evidence and received a session. */
  Admitted = 'admitted',
  /** Admission was refused; `reason` says why. */
  Refused = 'refused',
  /** A claim was refused at admission time by a worker, user or hardware limit. */
  ClaimRefused = 'claim_refused',
  /** A running operation was stopped because it exceeded a limit. */
  LimitExceeded = 'limit_exceeded',
  /** An administrator revoked the worker; every session it held is dead. */
  Revoked = 'revoked',
  /** An administrator changed the worker's limits or scopes. */
  Updated = 'updated',
  /**
   * FL-95: the worker reported that its GPU was lost mid-job. Every session it held is revoked, so
   * it must present fresh conformance evidence before it is given anything again.
   */
  DeviceLost = 'device_lost',
}
```

[server/src/enum.ts:1856–1891](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/enum.ts#L1856-L1891)

```ts
export enum RenderWorkerRefusalReason {
  InvalidCredential = 'invalid_credential',
  WorkerRevoked = 'worker_revoked',
  SessionExpired = 'session_expired',
  /** The conformance evidence is older than the worker's configured maximum age. */
  ConformanceStale = 'conformance_stale',
  /** The evidence has been presented before; a replayed report is not fresh evidence. */
  ConformanceReplayed = 'conformance_replayed',
  /** The engine or patch digest the worker reports is not the one it was enrolled with. */
  EngineDigestMismatch = 'engine_digest_mismatch',
  /** A software or fallback renderer was reported where a GPU is required. */
  SoftwareRenderer = 'software_renderer',
  /** The worker's destination is not the destination the operation was submitted to. */
  DestinationMismatch = 'destination_mismatch',
  /** The operation names a worker and this is not it. */
  WorkerMismatch = 'worker_mismatch',
  /** The operation kind is outside the worker's admitted scopes. */
  ScopeExceeded = 'scope_exceeded',
  /** The worker already holds as many operations as it is allowed. */
  WorkerConcurrency = 'worker_concurrency_exceeded',
  /** The operation's owner already has as many operations running as they are allowed. */
  UserConcurrency = 'user_concurrency_exceeded',
  /** The operation needs more GPU memory than the worker was admitted with. */
  GpuMemoryInsufficient = 'gpu_memory_insufficient',
  WallClockExceeded = 'wall_clock_exceeded',
  OutputBytesExceeded = 'output_bytes_exceeded',
  /** The chosen destination reports itself unavailable. */
  DestinationUnavailable = 'destination_unavailable',
  /** FL-90 refused at least one graph resource; a render needs a complete manifest. */
  ManifestIncomplete = 'manifest_incomplete',
  /**
   * FL-95: the operation's output needs an encoder or a container the session's conformance check
   * did not verify.
   */
  CodecUnsupported = 'codec_unsupported',
}
```

[server/src/enum.ts:3026–3035](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/enum.ts#L3026-L3035)

```ts
export enum StudioExportRemoteReason {
  /**
   * A render was handed to a remote worker. Recorded when it is claimed, so the obligation exists
   * before anything can go wrong; acknowledged when the render finishes or the worker confirms a
   * cancel released everything. Until then the remote job must be stopped if it is still running.
   */
  Cancel = 'cancel',
  /** The remote copy of the output is no longer needed (published, failed or cancelled). */
  Delete = 'delete',
}
```

## Checkpoint, path and preview-stream dependencies

CheckpointParamDto coerces sequence to a nonnegative integer; operation ID is UUIDv7; input grant length is 1–8192. PreviewTimeSchema carries numerator/denominator as safe integer decimal strings and denominator \>0. SDP length ceiling is 65536. Stream close reasons: closed, superseded, revoked, stale-revision, expired, worker-lost, failed. Browser/worker signaling is non-trickle ICE; session descriptions are complete. The active streaming keepalive in source is product behavior, distinct from agents polling external CI state.

[server/src/controllers/render-worker.controller.ts:65–76](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/render-worker.controller.ts#L65-L76)

```ts
  id: z.uuidv7(),
  grant: z.string().min(1).max(8192),
});
class OperationInputParamDto extends createZodDto(OperationInputParamSchema) {}

const CheckpointParamSchema = z.object({
  id: z.uuidv7(),
  sequence: z.coerce.number().int().min(0),
});
class CheckpointParamDto extends createZodDto(CheckpointParamSchema) {}

const history = () => new HistoryBuilder().added('v3.0.0').alpha('v3.0.0');
```

[server/src/dtos/media-operation.dto.ts:42–55](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/dtos/media-operation.dto.ts#L42-L55)

```ts
const MediaOperationCheckpointSchema = z
  .object({
    id: z.uuidv7().describe('Checkpoint ID'),
    sequence: z.int().describe('Chunk order within the render'),
    state: MediaOperationCheckpointStateSchema,
    chunkKey: z.string().describe('Digest over every input to this chunk; the reuse key'),
    timebase: z.string().describe('Rational timebase for the tick range, e.g. 30000/1001'),
    startTicks: z.string().describe('Chunk start, in ticks of the timebase'),
    endTicks: z.string().describe('Chunk end, in ticks of the timebase'),
    requiresSequentialContext: z.boolean().describe('A render may not start inside this chunk'),
    sizeInBytes: z.string().nullable(),
    completedAt: z.string().meta({ format: 'date-time' }).nullable(),
  })
  .meta({ id: 'MediaOperationCheckpointDto' });
```

[server/src/dtos/studio-preview.dto.ts:13–26](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/dtos/studio-preview.dto.ts#L13-L26)

```ts
const safeIntegerString = (label: string) =>
  z
    .string()
    .regex(/^-?\d{1,16}$/)
    .refine((value) => Number.isSafeInteger(Number(value)), { message: `${label} must be a safe integer` });

export const PreviewTimeSchema = z
  .object({
    numerator: safeIntegerString('numerator').describe('Time numerator, in seconds over the denominator'),
    denominator: safeIntegerString('denominator')
      .refine((value) => Number(value) > 0, { message: 'denominator must be positive' })
      .describe('Time denominator; must be positive'),
  })
  .meta({ id: 'StudioPreviewTimeDto' });
```

[server/src/dtos/studio-preview-stream.dto.ts:13–113](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/dtos/studio-preview-stream.dto.ts#L13-L113)

```ts
const SdpSchema = z.string().min(1).max(STREAM_MAX_SDP_BYTES).describe('A complete session description (SDP)');

const StreamStateSchema = z
  .enum(['queued', 'negotiating', 'offered', 'answered', 'closed'])
  .describe('Where the session is')
  .meta({ id: 'StudioPreviewStreamState' });

const StreamCloseReasonSchema = z
  .enum(STREAM_CLOSE_REASONS)
  .describe('Why a closed session closed')
  .meta({ id: 'StudioPreviewStreamCloseReason' });

const StreamBoundsSchema = z
  .object({
    maxBitrateKbps: z.int().describe('Bitrate the worker may not exceed; the server writes it into the relayed answer'),
    maxWidth: z.int(),
    maxHeight: z.int(),
    maxFrameRate: z.int(),
    maxDurationSeconds: z.int().describe('The session closes after this long; playing on opens a new one'),
  })
  .meta({ id: 'StudioPreviewStreamBoundsDto' });

/** Open a playback session of the project's current stored revision, starting at `time`. */
const StudioPreviewStreamOpenSchema = z
  .object({
    projectId: z.uuidv7().describe('Studio project to play'),
    revision: z.int().min(1).describe('Stored project revision to play; a superseded revision is refused'),
    time: PreviewTimeSchema,
    quality: StudioPreviewQualitySchema,
    viewportWidth: z.coerce.number().int().min(PREVIEW_MIN_VIEWPORT).max(PREVIEW_MAX_VIEWPORT),
    viewportHeight: z.coerce.number().int().min(PREVIEW_MIN_VIEWPORT).max(PREVIEW_MAX_VIEWPORT),
  })
  .meta({ id: 'StudioPreviewStreamOpenDto' });

/**
 * One playback session, as the browser that opened it sees it. Polling it is the keepalive, and
 * each poll re-checks project access and the stored head.
 */
const StudioPreviewStreamSchema = z
  .object({
    id: z.uuidv7().describe('Stream session ID'),
    projectId: z.string(),
    revision: z.int().min(1).describe('The stored project revision this session plays'),
    state: StreamStateSchema,
    closeReason: StreamCloseReasonSchema.nullable(),
    currentRevision: z.int().min(0).nullable().describe('The stored head, when the session closed as stale'),
    negotiation: z.int().min(0).describe('The offer/answer round; an answer must name it'),
    offer: SdpSchema.nullable().describe("The worker's offer for this round, while it waits for an answer"),
    start: PreviewTimeSchema.describe('Where playback starts'),
    bounds: StreamBoundsSchema,
    keepaliveMs: z.int().describe('Poll at least this often, or the session is closed'),
    expiresAt: z.string().meta({ format: 'date-time' }).describe('The hard end of this session'),
  })
  .meta({ id: 'StudioPreviewStreamDto' });

const StudioPreviewStreamAnswerSchema = z
  .object({
    negotiation: z.int().min(0).describe('The round this answer answers'),
    sdp: SdpSchema,
  })
  .meta({ id: 'StudioPreviewStreamAnswerDto' });

/* Worker side ------------------------------------------------------------------------------------ */

const ClaimTokenSchema = z.uuid().describe('The claim token this operation was handed out with');

const RenderWorkerStreamSignalRequestSchema = z
  .object({ claimToken: ClaimTokenSchema })
  .meta({ id: 'RenderWorkerStreamSignalRequestDto' });

/**
 * What the worker holding a session must do now. `close` means stop sending and acknowledge the
 * cancel; while it is false the worker polls this at least every two seconds.
 */
const RenderWorkerStreamSignalSchema = z
  .object({
    close: z.boolean(),
    closeReason: StreamCloseReasonSchema.nullable(),
    revision: z.int().min(1),
    negotiation: z.int().min(0).describe('The round to offer on'),
    offerNeeded: z.boolean().describe('No offer from this claim for this round yet: create one (with an ICE restart)'),
    answer: SdpSchema.nullable().describe("The browser's answer, with the server's bitrate bound written in"),
    start: PreviewTimeSchema,
    bounds: StreamBoundsSchema,
  })
  .meta({ id: 'RenderWorkerStreamSignalDto' });

const RenderWorkerStreamOfferSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    negotiation: z.int().min(0),
    sdp: SdpSchema,
  })
  .meta({ id: 'RenderWorkerStreamOfferDto' });

export class StudioPreviewStreamOpenDto extends createZodDto(StudioPreviewStreamOpenSchema) {}
export class StudioPreviewStreamDto extends createZodDto(StudioPreviewStreamSchema) {}
export class StudioPreviewStreamAnswerDto extends createZodDto(StudioPreviewStreamAnswerSchema) {}
export class RenderWorkerStreamSignalRequestDto extends createZodDto(RenderWorkerStreamSignalRequestSchema) {}
export class RenderWorkerStreamSignalDto extends createZodDto(RenderWorkerStreamSignalSchema) {}
export class RenderWorkerStreamOfferDto extends createZodDto(RenderWorkerStreamOfferSchema) {}
```

## Buddy peer wire models

Base `/api/buddy/v1/vaults/:vaultId`. Request JSON content type is application/vnd.frameleaf.buddy+json; object bytes use application/octet-stream. Grant and DPoP constraints are copied below, separate from user sessions. Success JSON is `{data,proof}`; do not treat the signed envelope as the bare data model.

| Suffix            | Body                              | Signed response data                            |
| ----------------- | --------------------------------- | ----------------------------------------------- |
| GET handshake     | none                              | `{version:1,vaultId:string,blockBytes:8388608}` |
| POST inventory    | `{ids:string[]}` (strict; ≤100)   | BuddyReceipt[]; missing IDs omitted             |
| POST reservations | BuddyReceipt                      | `{ok:true}`                                     |
| PUT objects/:id   | encrypted binary (≤8388636 bytes) | BuddyReceipt                                    |
| GET objects/:id   | none                              | binary plus Buddy-Proof over BuddyReceipt       |
| GET snapshots     | none                              | `{id,sequence,createdAt,keyVersion}`[]          |
| GET snapshots/:id | none                              | BuddySignedSnapshot                             |
| POST snapshots    | BuddySignedSnapshot               | `{snapshotId,digest}`                           |

Receipt constraints: only id/bytes/digest fields; id and digest lowercase 64 hex; bytes safe integer from 28 through 8388636. Snapshot envelope only snapshot/signature fields; snapshot only the declared fields. Sequence/keyVersion safe integer ≥1, previous null or lowercase UUID, valid parseable createdAt/retainUntil, manifest 1–128 IDs, objects ≤1000000, no duplicate receipt IDs; each manifest ID must occur among objects. Signature is 86-character unpadded base64url Ed25519 signature over JSON.stringify(snapshot), validated against the pinned source Ed25519 key. These runtime validation constraints supplement the TypeScript type declarations below.

[server/src/utils/buddy-backup-vault.ts:109–143](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/buddy-backup-vault.ts#L109-L143) [server/src/utils/buddy-backup-vault.ts:307–359](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/buddy-backup-vault.ts#L307-L359) [server/src/controllers/buddy-backup-peer.controller.ts:11–170](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/buddy-backup-peer.controller.ts#L11-L170)
[server/src/utils/buddy-backup-vault.ts:8–27](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/buddy-backup-vault.ts#L8-L27)

```ts
export type BuddyReceipt = { id: string; bytes: number; digest: string };
export type BuddyCapacity = { quotaBytes: number; freeBytes: number; totalBytes: number };
export type BuddySnapshot = {
  version: 1;
  vaultId: string;
  id: string;
  sequence: number;
  previous: string | null;
  createdAt: string;
  retainUntil: string;
  keyVersion: number;
  manifest: string[];
  objects: BuddyReceipt[];
};
export type BuddySignedSnapshot = { snapshot: BuddySnapshot; signature: string };
export type BuddySnapshotSummary = Pick<
  BuddySnapshot,
  'id' | 'sequence' | 'previous' | 'createdAt' | 'retainUntil' | 'keyVersion'
>;
type BuddyPublicKey = { kty: 'OKP'; crv: 'Ed25519'; x: string };
```

[server/src/utils/buddy-backup-crypto.ts:12–18](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/buddy-backup-crypto.ts#L12-L18)

```ts
export const BUDDY_BLOCK_BYTES = 8 * 1024 * 1024;
export const BUDDY_SEALED_OVERHEAD = 28;
export const BUDDY_ID = /^[\da-f]{64}$/;
export const BUDDY_UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

export type BuddyBlockContext = { vaultId: string; id: string; keyVersion: number };
export type BuddyKeyring = { version: 1; vaultId: string; current: number; keys: Record<string, string> };
```

## Buddy Cloud grant and request-proof schemas

The first snippet is the locally pinned Cloud contract copy: all request/response schemas, grant/key types and bounds used by the Buddy transport. The second snippet supplies strict DPoP header/claim schemas; final proof verification additionally checks binding, method/URI (query/fragment excluded), ≤60-second timestamp drift, nonce replay admission, and SHA-256 token hash.

[server/src/utils/frameleaf-buddy.ts:1–159](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/frameleaf-buddy.ts#L1-L159)

```ts
// Wire contracts from Frameleaf/frameleaf-cloud packages/contracts/src/buddy (Apache-2.0), commit 7f094c00.
import { z } from 'zod';
import { RemoteConnectionSchema as Connection } from 'src/dtos/frameleaf-remote-access.dto.js';
import { relayTokenResponseSchema as RelayTokenResponse } from 'src/utils/frameleaf-relay.js';

const RelayConfirmationKey = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const BUDDY_VERSION = 1;
export const BUDDY_GRANT_TYPE = 'buddy-grant+jwt';
export const BUDDY_GRANT_LIFETIME_SEC = 300;
export const BuddyVersion = z.literal(BUDDY_VERSION).meta({ format: 'double' });
export const BuddyRetention = z.strictObject({
  days: z.literal(30).meta({ format: 'double' }),
  monthly: z.literal(12).meta({ format: 'double' }),
});
export const BuddyScope = z.enum(['read', 'write']);
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const quota = bytes.min(10 * 1024 ** 3);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const BuddyAction = z.strictObject({ version: BuddyVersion });
export const BuddyInviteRequest = z.strictObject({
  version: BuddyVersion,
  instanceId: z.uuid(),
  targetAccountId: z.uuid(),
  quotaBytes: quota,
  retention: BuddyRetention,
});
export type BuddyInviteRequest = z.infer<typeof BuddyInviteRequest>;
export const BuddyInviteResponse = z.strictObject({
  version: BuddyVersion,
  invitationId: z.uuid(),
  token,
  expiresAt: z.iso.datetime(),
});
export const BuddyAcceptRequest = z.strictObject({
  version: BuddyVersion,
  token,
  instanceId: z.uuid(),
  quotaBytes: quota,
  retention: BuddyRetention,
});
export type BuddyAcceptRequest = z.infer<typeof BuddyAcceptRequest>;
export const BuddyVault = z.strictObject({
  vaultId: z.uuid(),
  sourceInstanceId: z.uuid(),
  destinationInstanceId: z.uuid(),
  sourceKey: RelayConfirmationKey,
  destinationKey: RelayConfirmationKey,
  quotaBytes: quota,
  retention: BuddyRetention,
});
export type BuddyVault = z.infer<typeof BuddyVault>;
export const BuddyPairing = z
  .strictObject({
    version: BuddyVersion,
    pairId: z.uuid(),
    state: z.enum(['pending', 'active', 'ended', 'blocked']),
    readUntil: z.iso.datetime().nullable(),
    vaults: z.array(BuddyVault).length(2),
  })
  .refine((p) => {
    const [a, b] = p.vaults;
    return Boolean(
      a &&
      b &&
      a.vaultId !== b.vaultId &&
      a.sourceInstanceId !== a.destinationInstanceId &&
      a.sourceInstanceId === b.destinationInstanceId &&
      a.destinationInstanceId === b.sourceInstanceId &&
      a.sourceKey.x === b.destinationKey.x &&
      a.destinationKey.x === b.sourceKey.x &&
      (p.state === 'ended') === (p.readUntil !== null),
    );
  }, 'a pairing must contain reciprocal independent vaults');
export type BuddyPairing = z.infer<typeof BuddyPairing>;
export const BuddyPairingList = z.strictObject({ version: BuddyVersion, pairings: z.array(BuddyPairing) });
export const BuddyGrantRequest = z.strictObject({
  version: BuddyVersion,
  pairId: z.uuid(),
  vaultId: z.uuid(),
  scope: BuddyScope,
});
export type BuddyGrantRequest = z.infer<typeof BuddyGrantRequest>;
export const BuddyGrantHeader = z.strictObject({
  alg: z.literal('EdDSA'),
  typ: z.literal(BUDDY_GRANT_TYPE),
  kid: z.string().min(1).max(128),
});
export const BuddyGrantClaims = z
  .strictObject({
    version: BuddyVersion,
    iss: z.url(),
    aud: z.literal('frameleaf-buddy'),
    sub: z.uuid(),
    jti: z.uuid(),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    pairId: z.uuid(),
    sourceInstanceId: z.uuid(),
    destinationInstanceId: z.uuid(),
    vaultId: z.uuid(),
    scope: BuddyScope,
    cnf: z.strictObject({ jkt: token, jwk: RelayConfirmationKey }),
    destinationKey: RelayConfirmationKey,
  })
  .refine(
    (c) =>
      c.exp > c.iat &&
      c.exp - c.iat <= BUDDY_GRANT_LIFETIME_SEC &&
      c.sub === c.sourceInstanceId &&
      c.sourceInstanceId !== c.destinationInstanceId,
    'invalid grant lifetime or subject',
  );
export type BuddyGrantClaims = z.infer<typeof BuddyGrantClaims>;
export const BuddyGrantResponse = z.strictObject({
  version: BuddyVersion,
  token: z.string().min(1).max(8192),
  expiresAt: z.iso.datetime(),
  claims: BuddyGrantClaims,
  connections: z.array(Connection),
});
export const BuddyVerifyRequest = z.strictObject({ version: BuddyVersion, token: z.string().min(1).max(8192) });
export const BuddyStatusReport = z.strictObject({
  version: BuddyVersion,
  pairId: z.uuid(),
  vaultId: z.uuid(),
  committedBytes: bytes,
  reservedBytes: bytes,
  lastCompleteAt: z.iso.datetime().nullable(),
  lastVerifiedAt: z.iso.datetime().nullable(),
  state: z.enum(['idle', 'sending', 'paused', 'quota', 'integrity']),
});
export type BuddyStatusReport = z.infer<typeof BuddyStatusReport>;
export const BuddyStatusResponse = z.strictObject({
  version: BuddyVersion,
  pairId: z.uuid(),
  reports: z.array(BuddyStatusReport).max(2),
});
export const BuddyRebindRequest = z.strictObject({
  version: BuddyVersion,
  oldInstanceId: z.uuid(),
  newInstanceId: z.uuid(),
});
export const BuddyEscrowRequest = z.strictObject({
  version: BuddyVersion,
  vaultId: z.uuid(),
  blob: z
    .string()
    .min(64)
    .max(32_768)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export const BuddyRecoveryRelayRequest = z.strictObject({ version: BuddyVersion, pairId: z.uuid(), vaultId: z.uuid() });
export type BuddyRecoveryRelayRequest = z.infer<typeof BuddyRecoveryRelayRequest>;
export const BuddyRecoveryRelayResponse = RelayTokenResponse.extend({ recoveryHost: z.string().max(253) });
```

[server/src/utils/buddy-backup-protocol.ts:18–34](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/buddy-backup-protocol.ts#L18-L34)

```ts
const publicKey = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().regex(/^[\w-]{43}$/),
});
export const BuddyJwks = z.object({
  keys: z.array(publicKey.extend({ kid: z.string(), use: z.string().optional(), alg: z.string().optional() })).max(8),
});
const proofHeader = z.strictObject({ typ: z.literal('dpop+jwt'), alg: z.literal('EdDSA'), jwk: publicKey });
const proofClaims = z.strictObject({
  jti: z.string().min(1).max(128),
  htm: z.string().max(10),
  htu: z.url().max(4096),
  iat: z.number().int(),
  ath: z.string().regex(/^[\w-]{43}$/),
  nonce: z.string().max(128).optional(),
});
```

## Buddy signed response schema

JSON envelope: `{data:T,proof:string}`. Proof JWT header is strict `{typ:"buddy-response+jwt",alg:"EdDSA"}`. Claims below are strict; destination key is the grant-pinned key, requestId is the original DPoP jti, exp equals grant.exp, digest is lowercase hex SHA-256 of JSON.stringify(data). Binary Buddy-Proof signs a receipt over the actual bytes. Commit response data is `{snapshotId: snapshot.id,digest: SHA256(JSON.stringify(snapshot))}`.

[server/src/utils/buddy-backup-protocol.ts:100–112](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/buddy-backup-protocol.ts#L100-L112)

```ts
  const header = z.strictObject({ typ: z.literal('buddy-response+jwt'), alg: z.literal('EdDSA') }).parse(jwt.header);
  const claims = z
    .strictObject({
      vaultId: z.uuid(),
      grantId: z.uuid(),
      requestId: z.uuid(),
      digest: z.string().regex(/^[a-f\d]{64}$/),
      iat: z.number().int(),
      exp: z.number().int(),
    })
    .parse(jwt.payload);
  if (
    header.alg !== 'EdDSA' ||
```

[server/src/services/buddy-backup-peer.service.ts:330–345](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/services/buddy-backup-peer.service.ts#L330-L345) [server/src/utils/buddy-backup-protocol.ts:7–15](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/buddy-backup-protocol.ts#L7-L15)

## Source image encoding model

`ImageEncodingInfo` is shared by asset responses and image-worker inspection. `dynamicRange`, `gainMap` and `reconstructionAvailable` are required; the technical detail fields are optional. `container`, `codec` and gain-map descriptions are bounded strings rather than closed capability enums. Unknown values do not imply reconstruction support. `referenceWhite` is an optional positive processing reference in cd/m²; it is not measured screen brightness. `inspectionStatus` optionally distinguishes `identified` from `failed`. The schema describes technical color encoding and does not expose capture EXIF or location. The unknown default does not invent SDR, bit depth or reference white. [server/src/dtos/image-encoding.dto.ts:3–36](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/dtos/image-encoding.dto.ts#L3-L36)

[server/src/dtos/image-encoding.dto.ts:4–36](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/dtos/image-encoding.dto.ts#L4-L36)

```ts
export const ImageEncodingSchema = z
  .object({
    dynamicRange: z.enum(['unknown', 'sdr', 'hdr']),
    container: z.string().max(40).optional(),
    codec: z.string().max(40).optional(),
    bitDepth: z.int().min(1).max(32).optional(),
    colorPrimaries: z.int().min(0).max(65_535).optional(),
    transfer: z.union([z.int().min(0).max(65_535), z.literal('adaptive')]).optional(),
    referenceWhite: z
      .number()
      .meta({ format: 'double' })
      .positive()
      .optional()
      .describe('Processing reference white in cd/m²; not measured display brightness'),
    contentHeadroom: z.number().meta({ format: 'double' }).min(1).optional(),
    gainMap: z.string().max(80).describe('Gain-map interpretation; unknown values do not imply reconstruction support'),
    reconstructionAvailable: z
      .boolean()
      .describe('Decoder can reconstruct this source; does not imply a published HDR rendition or qualified display'),
    fallbackReason: z.string().max(80).optional(),
    renderingPolicy: z.string().max(80).optional(),
    inspectionStatus: z.enum(['identified', 'failed']).optional(),
    width: z.int().positive().optional(),
    height: z.int().positive().optional(),
  })
  .meta({ id: 'ImageEncodingInfo' });

export type ImageEncodingInfo = z.infer<typeof ImageEncodingSchema>;
export const unknownImageEncoding = (): ImageEncodingInfo => ({
  dynamicRange: 'unknown',
  gainMap: 'none',
  reconstructionAvailable: false,
});
```

## Internal image-worker HDR IPC

The image worker registers `inspectImageEncoding`, `decodeHdrImage`, `encodeHdrImage` and `generateHdrRenditions` alongside the existing Sharp operations. These are child-process IPC calls through `MediaRepository`, not additional HTTP routes or Studio render-worker enrollment capabilities. Requests carry an ID, operation, argument array and pixel/byte budgets; responses distinguish readiness, progress, result and classified failure. HDR inspection accepts a source path or buffer; decode returns the declared linear surface, and encode accepts that surface and returns a buffer. Encoded input is capped at the smaller of the worker budget and 128 MiB. A native `RESOURCE_LIMIT` becomes a Sharp resource-limit failure; the native codec binding is a separate runtime dependency. [server/src/queue/sharp-operations.ts:47–80](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/queue/sharp-operations.ts#L47-L80) [server/src/queue/image-hdr.ts:29–73](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/queue/image-hdr.ts#L29-L73) [server/src/repositories/media.repository.ts:110–126](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/repositories/media.repository.ts#L110-L126)

[server/src/queue/sharp-protocol.ts:3–37](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/queue/sharp-protocol.ts#L3-L37)

```ts
export const SHARP_OPERATIONS = [
  'inspectImageEncoding',
  'decodeHdrImage',
  'encodeHdrImage',
  'generateHdrRenditions',
  'decodeImage',
  'generateImageThumbnails',
  'generateThumbnail',
  'writeCloudUpload',
  'writeStrippedStill',
  'composeImageGrid',
  'renderDevelopGeometry',
  'encodeDevelopOutput',
  'generateThumbhash',
  'normalizeDevelopArtifact',
  'decodeDevelopArtifact',
  'getImageMetadata',
  'getOrientedSize',
  'scoreThumbnailCandidate',
] as const;
export type SharpOperation = (typeof SHARP_OPERATIONS)[number];
export type SharpArguments<K extends SharpOperation> = Parameters<SharpOperations[K]>;
export type SharpResult<K extends SharpOperation> = Awaited<ReturnType<SharpOperations[K]>>;
export type SharpRequest = {
  id: number;
  operation: SharpOperation;
  args: unknown[];
  maxPixels: number;
  maxBytes: number;
};
export type SharpResponse =
  | { type: 'ready' }
  | { type: 'progress'; id: number; completed: number }
  | { type: 'result'; id: number; value: unknown }
  | { type: 'failure'; id: number; message: string; resourceLimit: boolean; decodeFailure?: boolean };
```

[server/src/queue/image-hdr.ts:7–11](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/queue/image-hdr.ts#L7-L11)

```ts
export type { ImageEncodingInfo } from 'src/dtos/image-encoding.dto.js';
import type { ImageEncodingInfo } from 'src/dtos/image-encoding.dto.js';

export type LinearHdrImage = { data: Buffer; width: number; height: number; gamut: 0 | 1 | 2; referenceWhite: 203 };
export type PairedHdrImage = LinearHdrImage & { sdr: Buffer; sdrGamut: 0 | 1 | 2 };
```

`decodeHdrImage(input, preserveSdrBaseline = false)` keeps the ordinary linear HDR path by default. Passing `true` requests a `PairedHdrImage`, adding the authored SDR baseline buffer and its `sdrGamut`. `encodeHdrImage` accepts either surface: the presence of `sdr` selects paired encoding with both SDR arguments, while an ordinary `LinearHdrImage` uses the existing encoder. The native methods and buffers remain subject to the image worker's pixel/byte budgets. This worker capability does not change the HTTP DTO or establish published HDR delivery. [server/src/queue/sharp-operations.ts:54–147](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/queue/sharp-operations.ts#L54-L147) [server/src/repositories/media.repository.ts:110–125](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/repositories/media.repository.ts#L110-L125) [server/src/queue/image-hdr.ts:10–28](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/queue/image-hdr.ts#L10-L28)

`generateHdrRenditions(input, outputs)` accepts one or two distinct `{path, size?}` output requests. An optional size is a positive safe-integer longest-edge bound; it never upscales. The worker requires inspected HDR with reconstruction support, uses a paired authored SDR baseline for gain-map JPEG sources, and resizes both surfaces over the same area-filtered footprint in linear light. It checks combined surface budgets and re-inspects each encoded result for HDR support and exact output dimensions. Each result is `{path, width, height, encoding}`. Output files use exclusive creation; failures remove only attempt files created by that call. The method refuses paths equal to the input and does not replace previously published outputs. This is internal rendition generation, with publication and delivery qualification remaining separate. [server/src/queue/sharp-operations.ts:81–149](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/queue/sharp-operations.ts#L81-L149) [server/src/queue/image-hdr-pixels.ts:6–95](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/queue/image-hdr-pixels.ts#L6-L95) [server/src/repositories/media.repository.ts:118–124](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/repositories/media.repository.ts#L118-L124)

## HTTP surfaces outside normal controller inventory

A production-source scan of server/src excluding tests found exactly **one @Controller outside server/src/controllers**: MaintenanceWorkerController. It declares 11 HTTP operations, replacing normal routes in maintenance mode. These are not 11 additive normal-server endpoints.

| Maintenance mode method/path              | Model/result                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| GET /api/server/config                    | ServerConfigDto                                                          |
| GET /api/server/ping                      | ServerPingResponse                                                       |
| GET /api/server/version                   | ServerVersionResponseDto                                                 |
| GET /api/admin/database-backups           | DatabaseBackupListResponseDto                                            |
| GET /api/admin/database-backups/:filename | binary backup                                                            |
| DELETE /api/admin/database-backups        | DatabaseBackupDeleteDto                                                  |
| POST /api/admin/database-backups/upload   | multipart file                                                           |
| GET /api/admin/maintenance/status         | MaintenanceStatusResponseDto; public projection without valid credential |
| GET /api/admin/maintenance/detect-install | MaintenanceDetectInstallResponseDto                                      |
| POST /api/admin/maintenance/login         | MaintenanceLoginDto → MaintenanceAuthDto/cookie                          |
| POST /api/admin/maintenance               | SetMaintenanceModeDto; background action                                 |

Marked maintenance routes use immich_maintenance_token cookie/JWT, not normal opaque sessions. Bootstrap configures Swagger UI/reference routes and static assets plus an HTML GET/HEAD fallback outside /api; these are framework/UI surfaces already described in the protocol guide, not operation-ID entries.

The EdgeProxyService creates an HTTP server accepting request and upgrade events **on already-admitted incoming streams**. It forwards original method/path to the API loopback endpoint with attested arrival headers, supports WebSocket upgrades and streaming/Range responses, and can narrow access to Buddy vault-only/recovery routes. EdgeDirectService wraps its accepted streams in TLS. They are entry transports for the same API, not a separate list of business endpoints.

EdgeRelayService creates an HTTP/2 server over the authenticated outbound tunnel socket. It accepts CONNECT visitor streams and one POST `/fl-tunnel/control` control stream; other method/path combinations receive 404. This temporary internal per-tunnel HTTP/2 surface is not a public mobile/server API. Its framed relay messages/stream admission use the separate relay wire contract; avoid adding `/fl-tunnel/control` to the public OpenAPI endpoint count.

Both FastAPI apps use default FastAPI configuration and therefore also provide framework documentation routes (`/openapi.json`, `/docs`, `/docs/oauth2-redirect`, `/redoc`) unless deployment policy blocks them; these are inferred FastAPI defaults, not explicitly declared business operations. Configured bearer middleware protects them. No other explicit HTTP path declarations were found in the two production ML apps; enrichment, pet recognition, NSFW, OCR and semantic mask are /predict pipelines.

[server/src/maintenance/maintenance-worker.controller.ts:38–140](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/maintenance/maintenance-worker.controller.ts#L38-L140) [server/src/app.common.ts:71–100](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/app.common.ts#L71-L100) [server/src/edge/edge-proxy.service.ts:109–144](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/edge/edge-proxy.service.ts#L109-L144) [server/src/edge/edge-proxy.service.ts:239–275](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/edge/edge-proxy.service.ts#L239-L275) [server/src/edge/edge-direct.service.ts:104–126](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/edge/edge-direct.service.ts#L104-L126) [server/src/edge/edge-relay.service.ts:505–568](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/edge/edge-relay.service.ts#L505-L568) [server/src/utils/frameleaf-relay.ts:22](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/utils/frameleaf-relay.ts#L22)

## Source limitations and known gaps

This supplement inventories server/src production controllers/direct listeners and the two ML FastAPI apps. It does not invent closed schemas for intentionally arbitrary snapshot/settings JSON, every model-specific Any output, upstream FastAPI documentation HTML, or private relay control frame payloads. The preceding guide covers the complete normal Socket.IO event map and eight Buddy paths; the generated reference covers public controller DTOs. Full operation-specific Studio graph/worker renderer binaries and Cloud job contracts have separate source authorities.
