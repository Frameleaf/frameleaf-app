import asyncio
import base64
import gc
import importlib.util
import os
import secrets
import signal
import threading
import time
from contextlib import asynccontextmanager
from functools import partial
from typing import Any, AsyncGenerator, Callable
from zipfile import BadZipFile

import onnxruntime as ort
import orjson
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import PlainTextResponse, StreamingResponse
from onnxruntime.capi.onnxruntime_pybind11_state import InvalidProtobuf, NoSuchFile
from PIL.Image import Image
from pydantic import ValidationError
from starlette.formparsers import MultiPartParser
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

from frameleaf_ml import allocator
from frameleaf_ml.models import get_model_deps
from frameleaf_ml.models.base import InferenceModel, ModelUnavailableError
from frameleaf_ml.models.musicgen import MusicGenModel
from frameleaf_ml.models.transcribe import AudioFormatError, TranscribeModel, read_wav, wav_memory_bytes
from frameleaf_ml.models.transforms import decode_pil
from frameleaf_ml.models.translate import MAX_LINE_CHARS, MAX_LINES, TranslateModel
from frameleaf_ml.sessions.ort import flush_denormals

from .config import PreloadModelData, log, model_source, settings
from .env_aliases import read_env
from .hardware_report import container_report
from .inference_executor import InferenceBusy, InferenceExecutor
from .models.cache import ModelCache
from .producer_binding import BoundPredictor
from .schemas import (
    ImageDescriptionAcceleration,
    InferenceEntries,
    InferenceEntry,
    InferenceResponse,
    ModelFormat,
    ModelIdentity,
    ModelTask,
    ModelType,
    ORJSONResponse,
    PipelineRequest,
    T,
    validate_options,
)
from .transcription_memory import AudioMemoryBudget

MultiPartParser.spool_max_size = 2**26  # spools to disk if payload is 64 MiB or larger

model_cache = ModelCache(revalidate=settings.model_ttl > 0)
bound_predictor = BoundPredictor()
audio_memory_budget = AudioMemoryBudget(settings.transcription_max_memory_mb * 1024 * 1024)
thread_pool: InferenceExecutor | None = None
lock = threading.Lock()
active_requests = 0
last_called: float | None = None
# Hands the memory a burst of requests used back to the system shortly after the last one finishes.
release: asyncio.TimerHandle | None = None


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncGenerator[None, None]:
    global thread_pool
    source_url, source_setting = model_source()
    log.info(f"Downloading Frameleaf models from {source_url} ({source_setting}).")
    log.info(
        (
            "Created in-memory cache with unloading "
            f"{f'after {settings.model_ttl}s of inactivity' if settings.model_ttl > 0 else 'disabled'}."
        )
    )

    try:
        flush_denormals()  # for work that runs on the event loop's own thread
        if settings.request_threads > 0:
            # asyncio is a huge bottleneck for performance, so we use a thread pool to run blocking code
            thread_pool = InferenceExecutor(settings.request_threads, initializer=flush_denormals)
            log.info(f"Initialized request thread pool with {settings.request_threads} threads.")
        if settings.model_ttl > 0 and settings.model_ttl_poll_s > 0:
            asyncio.ensure_future(idle_shutdown_task())
        if settings.preload is not None:
            await preload_models(settings.preload)
            allocator.release()
        yield
    finally:
        # IMPORTANT ordering for actual GPU memory release:
        #   1. Quiesce the thread pool so no in-flight `predict` thread still
        #      holds a model instance via its local stack.
        #   2. Drop the cache's strong refs to model instances.
        #   3. gc.collect() to release the now-unreferenced sessions.
        #   4. torch.cuda.empty_cache() to return pinned GPU memory.
        # `log.handlers.clear()` is deferred to the end so warnings emitted
        # by the shutdown branches above are still visible to operators.
        # See ml.md Medium "Lifespan teardown doesn't release model GPU memory".
        if thread_pool is not None:
            try:
                thread_pool.shutdown(wait=True)
            except Exception as error:
                log.warning(f"Failed to shut down thread pool during shutdown: {error}")
        bound_predictor.close()
        # Drop strong references held by the cache so Torch/OpenVINO sessions
        # (which may hold multi-GB of pinned GPU memory) are eligible for GC
        # before the worker is respawned. Without this, `del model` only
        # deleted the loop variable and the cache dict kept references alive.
        try:
            model_cache.cache._cache.clear()
        except Exception as error:
            log.warning(f"Failed to clear model cache during shutdown: {error}")
        gc.collect()
        allocator.release()
        # If torch is present, also drop any cached CUDA allocator state.
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass
        except Exception as error:
            log.warning(f"Failed to empty CUDA cache during shutdown: {error}")
        # Final step — after this, log.warning is a no-op. Keep this LAST.
        log.handlers.clear()


async def preload_models(preload: PreloadModelData) -> None:
    log.info(
        f"Preloading models: clip:{preload.clip} facial_recognition:{preload.facial_recognition} "
        f"image_description:{preload.image_description}"
    )

    async def load_models(model_string: str, model_type: ModelType, model_task: ModelTask) -> None:
        for model_name in model_string.split(","):
            model_name = model_name.strip()
            model = await model_cache.get(model_name, model_type, model_task)
            await load(model)

    if preload.clip.textual is not None:
        await load_models(preload.clip.textual, ModelType.TEXTUAL, ModelTask.SEARCH)

    if preload.clip.visual is not None:
        await load_models(preload.clip.visual, ModelType.VISUAL, ModelTask.SEARCH)

    if preload.facial_recognition.detection is not None:
        await load_models(
            preload.facial_recognition.detection,
            ModelType.DETECTION,
            ModelTask.FACIAL_RECOGNITION,
        )

    if preload.facial_recognition.recognition is not None:
        await load_models(
            preload.facial_recognition.recognition,
            ModelType.RECOGNITION,
            ModelTask.FACIAL_RECOGNITION,
        )

    if preload.ocr.detection is not None:
        await load_models(
            preload.ocr.detection,
            ModelType.DETECTION,
            ModelTask.OCR,
        )

    if preload.ocr.recognition is not None:
        await load_models(
            preload.ocr.recognition,
            ModelType.RECOGNITION,
            ModelTask.OCR,
        )

    if preload.image_description.visual is not None:
        await load_models(
            preload.image_description.visual,
            ModelType.VISUAL,
            ModelTask.IMAGE_DESCRIPTION,
        )


async def update_state() -> AsyncGenerator[None, None]:
    global active_requests, last_called, release
    active_requests += 1
    last_called = time.time()
    if release is not None:
        release.cancel()
        release = None
    try:
        yield
    finally:
        active_requests -= 1
        if not active_requests:
            release = asyncio.get_running_loop().call_later(5, allocator.release)


def get_entries(entries: str = Form()) -> InferenceEntries:
    try:
        request: PipelineRequest = orjson.loads(entries)
        without_deps: list[InferenceEntry] = []
        with_deps: list[InferenceEntry] = []
        for task, types in request.items():
            for type, entry in types.items():
                # Validate per-task option keyspace. Unknown keys are rejected
                # to prevent schema drift / arbitrary kwargs to model constructors.
                # See ml.md High concern "external_prompt and other ML model options".
                raw_options = entry.get("options", {}) or {}
                if not isinstance(raw_options, dict):
                    raise HTTPException(422, "Invalid request format: options must be an object.")
                validated_options = validate_options(task, type, raw_options)
                parsed: InferenceEntry = {
                    "name": entry["modelName"],
                    "task": task,
                    "type": type,
                    "options": validated_options,
                }
                dep = get_model_deps(parsed["name"], type, task)
                (with_deps if dep else without_deps).append(parsed)
        return without_deps, with_deps
    except (orjson.JSONDecodeError, ValidationError, KeyError, AttributeError) as e:
        log.error(f"Invalid request format: {e}")
        raise HTTPException(422, "Invalid request format.")


app = FastAPI(lifespan=lifespan)


# Health endpoints stay unauthenticated so reverse-proxy probes and LAN deployments
# (the default UX) keep working unchanged. Auth only kicks in for paths that actually
# do inference, and only when FRAMELEAF_ML_AUTH_TOKEN is set in the environment.
# Normalised exempt paths — comparison strips trailing slash and lowercases.
_AUTH_EXEMPT_PATHS = frozenset({"/", "/ping"})
# Cap on the Authorization header byte length to avoid degenerate-input
# denial-of-service from arbitrary-length headers. Starlette already caps but
# making this explicit here is defensive and cheap.
_MAX_AUTH_HEADER_LENGTH = 8 * 1024


def _normalize_auth_path(path: str) -> str:
    """Lowercase + trailing-slash strip, but never strip the root '/'."""
    normalized = path.lower()
    if len(normalized) > 1 and normalized.endswith("/"):
        normalized = normalized.rstrip("/")
    return normalized


class BearerAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp, expected_token: str | None) -> None:
        super().__init__(app)
        # Encode once so compare_digest sees bytes of consistent type.
        self._expected_bytes: bytes | None = expected_token.encode("utf-8") if expected_token else None

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        # No token configured -> auth disabled; serve every request. This is the
        # default for local / same-LAN deployments — upstream Immich ships the ML
        # service without authentication. A token is only present when something
        # sets FRAMELEAF_ML_AUTH_TOKEN, e.g. a LAN worker reached through a proxy,
        # whose endpoint may be exposed beyond this host and must stay authenticated.
        if self._expected_bytes is None:
            return await call_next(request)
        # Token configured: enforce bearer auth on everything except the health
        # endpoints, which stay open so proxy health probes keep working.
        normalized_path = _normalize_auth_path(request.url.path)
        if normalized_path in _AUTH_EXEMPT_PATHS:
            return await call_next(request)
        header = request.headers.get("authorization", "")
        if len(header) > _MAX_AUTH_HEADER_LENGTH:
            return JSONResponse({"message": "Unauthorized"}, status_code=401)
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer":
            return JSONResponse({"message": "Unauthorized"}, status_code=401)
        # Constant-time comparison to prevent the matching-prefix timing leak
        # that ``token != self._expected`` exposed. ml.md High #1.
        if not secrets.compare_digest(token.encode("utf-8"), self._expected_bytes):
            return JSONResponse({"message": "Unauthorized"}, status_code=401)
        return await call_next(request)


_expected_token = read_env(os.environ, "FRAMELEAF_ML_AUTH_TOKEN").strip() or None

# Startup banner so the auth state is visible in worker logs — a single log
# line is easy to miss when gunicorn boots, so the banner mirrors other Immich
# startup output. Bearer auth is enforced only when a token is set (e.g. a LAN
# worker configured with one); otherwise the service is open, matching upstream
# Immich, which ships the ML service without authentication.
_auth_state = (
    "ENABLED  (bearer token required for /predict)"
    if _expected_token
    else "DISABLED (no token; /predict open to anything that can reach this port)"
)
log.info("=" * 64)
log.info("Frameleaf ML auth: %s", _auth_state)
log.info("  FRAMELEAF_ML_AUTH_TOKEN set = %s", "yes" if _expected_token else "no")
log.info("=" * 64)
if not _expected_token:
    log.warning(
        "FRAMELEAF_ML_AUTH_TOKEN is not set; /predict is unauthenticated. Treat the "
        "ML service URL as a trusted internal endpoint — anything able to reach "
        "this port can submit inference requests."
    )

app.add_middleware(BearerAuthMiddleware, expected_token=_expected_token)


@app.get("/")
async def root() -> ORJSONResponse:
    return ORJSONResponse({"message": "Frameleaf ML"})


@app.get("/ping")
def ping() -> PlainTextResponse:
    return PlainTextResponse("pong")


# The workloads this container serves (FL-110). The server's destination model asks every
# endpoint what it can run before admitting a request, instead of inferring capability from
# a successful /ping. This container is the ordinary /predict service: it serves the library
# workloads, plus Studio AI speech to text (`/transcribe`, Whisper, owner decision 2026-10-09) when
# its runtime is installed. Restoration needs a dedicated worker that publishes its own capabilities;
# listing it here would be a false claim.
#
# Public contract — KEEP IN SYNC WITH ``server/src/enum.ts`` (``MlWorkload``,
# ``LIBRARY_ML_WORKLOADS``) and ``MachineLearningRepository.probe``.
# "pet-recognition" (FL-58) is CLIP text encoding against the configured CLIP model, which this
# container serves whenever it serves "clip"; it is listed separately so it can be routed alone.
LIBRARY_WORKLOADS: tuple[str, ...] = ("face", "clip", "ocr", "enrichment", "pet-recognition")


def _has_transcription_runtime() -> bool:
    return importlib.util.find_spec("faster_whisper") is not None


SERVED_WORKLOADS: tuple[str, ...] = LIBRARY_WORKLOADS + (("studio-ai",) if _has_transcription_runtime() else ())
PREDICT_PROTOCOL = "predict-v1"


@app.get("/capabilities")
def capabilities() -> ORJSONResponse:
    return ORJSONResponse({"protocol": PREDICT_PROTOCOL, "workloads": list(SERVED_WORKLOADS)})


@app.get("/hardware")
def hardware() -> ORJSONResponse:
    """Report available hardware acceleration providers.

    Public contract — KEEP IN SYNC WITH ``server/src/repositories/machine-learning.repository.ts``
    (``MachineLearningHardware``) and ``server/src/enum.ts`` (``MachineLearningHardwareAcceleration``).
    ``preferredAcceleration`` is serialized as the lowercase string value of
    ``ImageDescriptionAcceleration`` (``"cuda"`` / ``"openvino"`` / ``"auto"``).
    Changing the enum requires a coordinated update on the server side and
    a corresponding Zod schema parse — adding a new variant without updating
    the server will silently break the front-end auto-detect UX.
    """
    providers = ort.get_available_providers()
    openvino_device_ids = _openvino_device_ids(providers)
    torch_cuda_available, cuda_device_count = _torch_cuda_info()
    preferred_acceleration = ImageDescriptionAcceleration.AUTO

    # The CUDA provider is compiled into the -cuda image whether or not a GPU was passed in.
    if torch_cuda_available:
        preferred_acceleration = ImageDescriptionAcceleration.CUDA
    elif "OpenVINOExecutionProvider" in providers and openvino_device_ids:
        preferred_acceleration = ImageDescriptionAcceleration.OPENVINO

    return ORJSONResponse(
        {
            "providers": providers,
            "openvinoDeviceIds": openvino_device_ids,
            "torchCudaAvailable": torch_cuda_available,
            "cudaDeviceCount": cuda_device_count,
            "preferredAcceleration": preferred_acceleration,
            # FL-159: which GPU this container reaches, through which backend (Hardware & GPU).
            "container": container_report(providers, openvino_device_ids),
        }
    )


def _openvino_device_ids(providers: list[str]) -> list[str]:
    if "OpenVINOExecutionProvider" not in providers:
        return []

    try:
        # Keep this resilient across onnxruntime versions where internals may change.
        pybind_state = getattr(getattr(ort, "capi", None), "_pybind_state", None)
        get_ids = getattr(pybind_state, "get_available_openvino_device_ids", None)
        if not callable(get_ids):
            return []
        device_ids: list[str] = get_ids()
        return device_ids
    except Exception as error:
        log.warning(f"Unable to read OpenVINO device IDs: {error}")
        return []


def _torch_cuda_info() -> tuple[bool, int]:
    try:
        import torch
    except ImportError:
        return False, 0

    if not torch.cuda.is_available():
        return False, 0

    return True, torch.cuda.device_count()


@app.exception_handler(InferenceBusy)
async def inference_busy(_: Request, __: Exception) -> JSONResponse:
    return JSONResponse({"detail": "ml_worker_busy"}, status_code=503, headers={"Retry-After": "30"})


@app.post("/predict-bound", dependencies=[Depends(update_state)])
async def predict_bound(
    binding: str = Form(), image: bytes | None = File(default=None), text: str | None = Form(default=None)
) -> ORJSONResponse:
    if (image is None) == (text is None):
        raise HTTPException(422, "Exactly one inference input required")
    try:
        result = await run(bound_predictor.predict, binding, image, text)
    except InferenceBusy:
        raise
    except Exception as error:
        raise HTTPException(409, "model_identity_unavailable") from error
    return ORJSONResponse(result)


@app.post("/predict", dependencies=[Depends(update_state)])
async def predict(
    entries: InferenceEntries = Depends(get_entries),
    image: bytes | None = File(default=None),
    text: str | None = Form(default=None),
    mask: bytes | None = File(default=None),
) -> Any:
    if image is not None:
        decoded = await run(lambda: decode_pil(image))
        if decoded.width == 0 or decoded.height == 0:
            raise HTTPException(400, "Image has zero width or height")
        inputs: Image | str = decoded
    elif text is not None:
        inputs = text
    else:
        raise HTTPException(400, "Either image or text must be provided")
    # Clean Up Remove fills (`inpaint`): a greyscale mask the same size as the image, 255 where content is removed.
    decoded_mask: Image | None = None
    if mask is not None:
        if not isinstance(inputs, Image):
            raise HTTPException(400, "A mask needs an image")
        decoded_mask = await run(lambda: decode_pil(mask))
        if decoded_mask.size != inputs.size:
            raise HTTPException(400, "The mask must be the same size as the image")
    response = await run_inference(inputs, entries, decoded_mask)
    return ORJSONResponse(response)


@app.post("/transcribe")
async def transcribe(
    entries: InferenceEntries = Depends(get_entries),
    audio: UploadFile = File(),
) -> StreamingResponse:
    """Studio captions: Whisper over one clip's audio (16 kHz mono 16-bit PCM WAV).

    The request names one entry, `{"transcribe": {"audio": {"modelName": "frameleaf-transcribe", "options":
    {"language"?, "wordTimestamps"?}}}}`. Problems found before any work starts are HTTP errors (400 bad
    audio or language, 503 no model or runtime). Otherwise the answer is newline-delimited JSON: one
    `info` line, a `segment` line per segment as it is decoded, then `done` (or `error`). Closing the
    connection stops the decoding at the next segment.
    """
    without_deps, with_deps = entries
    if with_deps or len(without_deps) != 1 or without_deps[0]["task"] != ModelTask.TRANSCRIBE:
        raise HTTPException(400, "A transcription request names exactly one transcribe entry")
    entry = without_deps[0]
    try:
        size = await run(wav_memory_bytes, audio.file)
        reservation = audio_memory_budget.reserve(size)
    except AudioFormatError as error:
        raise HTTPException(400, str(error)) from error
    global active_requests, last_called
    active_requests += 1
    last_called = time.time()
    released = False

    def release_request() -> None:
        nonlocal released
        global active_requests
        if not released:
            released = True
            active_requests -= 1
            reservation.release()

    samples = None
    try:
        samples = await reservation.run(thread_pool, read_wav, audio.file)
        model = await model_cache.get(
            entry["name"], entry["type"], entry["task"], ttl=settings.model_ttl, **entry["options"]
        )
        model = await load(model)
        assert isinstance(model, TranscribeModel)
        language = entry["options"].get("language")
        if language is not None and language not in model.languages:
            raise HTTPException(400, f"Whisper does not know the language '{language}'")
        items = model.stream(samples, **entry["options"])
        reservation.set_cleanup(items.close)
    except AudioFormatError as error:
        samples = None
        release_request()
        raise HTTPException(400, str(error)) from error
    except BaseException:
        samples = None
        release_request()
        raise

    async def body() -> AsyncGenerator[bytes, None]:
        global last_called
        try:
            while True:
                last_called = time.time()
                try:
                    item = await reservation.run(thread_pool, next, items, None)
                except Exception as error:
                    log.error(f"Transcription failed: {error}")
                    yield orjson.dumps({"type": "error", "message": "Transcription failed"}) + b"\n"
                    return
                if item is None:
                    break
                yield orjson.dumps(item) + b"\n"
            yield orjson.dumps({"type": "done"}) + b"\n"
        finally:
            release_request()

    class ReservedAudioStream(StreamingResponse):
        async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
            try:
                await super().__call__(scope, receive, send)
            finally:
                # A send failure can precede the first iteration of body().
                release_request()

    return ReservedAudioStream(body(), media_type="application/x-ndjson")


# Audio bytes per `audio` line of a music answer, before base64.
MUSIC_CHUNK_BYTES = 512 * 1024


@app.post("/music")
async def music(entries: InferenceEntries = Depends(get_entries)) -> StreamingResponse:
    """Make a movie (FL-561): new music from a prompt with MusicGen small.

    The request names one entry, `{"music": {"audio": {"modelName": "frameleaf-music", "options": {"prompt",
    "duration", "seed"?}}}}`. Problems found before any work starts are HTTP errors (422 bad options, 503
    no model). Otherwise the answer is newline-delimited JSON: `progress` lines (`done` of `total` decoder
    steps), then `info` (sample rate, seconds), the 16-bit mono WAV as base64 `audio` lines in order, then
    `done` (or `error`). Closing the connection stops the work at the next decoder step.
    """
    without_deps, with_deps = entries
    if with_deps or len(without_deps) != 1 or without_deps[0]["task"] != ModelTask.MUSIC:
        raise HTTPException(400, "A music request names exactly one music entry")
    entry = without_deps[0]
    options = dict(entry["options"])
    model = await model_cache.get(entry["name"], entry["type"], entry["task"], ttl=settings.model_ttl)
    model = await load(model)
    assert isinstance(model, MusicGenModel)
    items = model.stream(**options)

    async def body() -> AsyncGenerator[bytes, None]:
        global active_requests, last_called
        # Counted here, as for /transcribe: the stream outlives the handler.
        active_requests += 1
        try:
            while True:
                last_called = time.time()
                try:
                    item = await run(next, items, None)
                except Exception as error:
                    log.error(f"Music generation failed: {error}")
                    yield orjson.dumps({"type": "error", "message": "Music generation failed"}) + b"\n"
                    return
                if item is None:
                    break
                if item["type"] != "audio":
                    yield orjson.dumps(item) + b"\n"
                    continue
                wav: bytes = item["wav"]
                yield (
                    orjson.dumps({"type": "info", "sampleRate": item["sampleRate"], "seconds": item["seconds"]}) + b"\n"
                )
                for start in range(0, len(wav), MUSIC_CHUNK_BYTES):
                    chunk = base64.b64encode(wav[start : start + MUSIC_CHUNK_BYTES]).decode("ascii")
                    yield orjson.dumps({"type": "audio", "data": chunk}) + b"\n"
            yield orjson.dumps({"type": "done"}) + b"\n"
        finally:
            try:
                items.close()
            except ValueError:
                # Still writing in the thread pool after a disconnect; it is never advanced again.
                pass
            active_requests -= 1

    return StreamingResponse(body(), media_type="application/x-ndjson")


@app.post("/translate")
async def translate(entries: InferenceEntries = Depends(get_entries), lines: str = Form()) -> ORJSONResponse:
    """Studio captions in other languages (FL-641): caption lines translated with M2M100 418M.

    The request names one entry, `{"translate": {"textual": {"modelName": "frameleaf-translate", "options":
    {"source", "target"}}}}`, and `lines`, a JSON array of the caption lines as text. Only text is sent. The
    answer is `{"model", "translations"}`: one translation per line, in order. Problems are HTTP errors (400
    bad lines or language, 422 bad options, 503 no model or runtime).
    """
    without_deps, with_deps = entries
    if with_deps or len(without_deps) != 1 or without_deps[0]["task"] != ModelTask.TRANSLATE:
        raise HTTPException(400, "A translation request names exactly one translate entry")
    entry = without_deps[0]
    try:
        texts = orjson.loads(lines)
    except orjson.JSONDecodeError as error:
        raise HTTPException(400, "The lines must be a JSON array of text") from error
    if (
        not isinstance(texts, list)
        or len(texts) > MAX_LINES
        or not all(isinstance(text, str) and len(text) <= MAX_LINE_CHARS for text in texts)
    ):
        raise HTTPException(400, f"Send at most {MAX_LINES} lines of at most {MAX_LINE_CHARS} characters")
    options = dict(entry["options"])
    model = await model_cache.get(entry["name"], entry["type"], entry["task"], ttl=settings.model_ttl)
    model = await load(model)
    assert isinstance(model, TranslateModel)
    global active_requests, last_called
    active_requests += 1
    last_called = time.time()
    try:
        result = await run(model.predict, texts, **options)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    finally:
        active_requests -= 1
    return ORJSONResponse(result)


async def run_inference(
    payload: Image | str, entries: InferenceEntries, mask: Image | None = None
) -> InferenceResponse:
    outputs: dict[ModelIdentity, Any] = {}
    response: InferenceResponse = {}

    async def _run_inference(entry: InferenceEntry) -> None:
        model = await model_cache.get(
            entry["name"], entry["type"], entry["task"], ttl=settings.model_ttl, **entry["options"]
        )
        inputs: list[Any] = [payload]
        if entry["task"] == ModelTask.INPAINT:
            if mask is None:
                raise HTTPException(400, "Inpainting needs a mask")
            inputs.append(mask)
        for dep in model.depends:
            try:
                inputs.append(outputs[dep])
            except KeyError:
                message = f"Task {entry['task']} of type {entry['type']} depends on output of {dep}"
                raise HTTPException(400, message)
        model = await load(model)
        output = await run(model.predict, *inputs, **entry["options"])
        outputs[model.identity] = output
        response[entry["task"]] = output

    capacity = asyncio.Semaphore(max(1, settings.request_threads))

    async def admitted(entry: InferenceEntry) -> None:
        async with capacity:
            await _run_inference(entry)

    without_deps, with_deps = entries
    await asyncio.gather(*[admitted(entry) for entry in without_deps])
    if with_deps:
        await asyncio.gather(*[admitted(entry) for entry in with_deps])
    if isinstance(payload, Image):
        response["imageHeight"], response["imageWidth"] = payload.height, payload.width

    return response


async def run(func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    if thread_pool is None:
        return func(*args, **kwargs)
    partial_func = partial(func, *args, **kwargs)
    return await asyncio.get_running_loop().run_in_executor(thread_pool, partial_func)


async def load(model: InferenceModel) -> InferenceModel:
    if model.loaded:
        return model

    def _load(model: InferenceModel) -> InferenceModel:
        with lock:
            if model.loaded:
                return model
            retry_at = getattr(model, "load_retry_at", None)
            if retry_at is not None:
                if time.monotonic() < retry_at:
                    raise HTTPException(503, f"Model '{model.model_name}' is cooling down after a load failure")
                model.load_attempts = 0
                model.load_retry_at = None

            def attempt() -> InferenceModel:
                if model.load_attempts > 1:
                    model.load_retry_at = time.monotonic() + 30.0
                    raise HTTPException(500, f"Failed to load model '{model.model_name}'")
                try:
                    model.load()
                except FileNotFoundError as error:
                    if model.model_format == ModelFormat.ONNX:
                        raise
                    log.warning(
                        f"{model.model_format.upper()} is available, "
                        f"but model '{model.model_name}' does not support it.",
                        exc_info=error,
                    )
                    model.model_format = ModelFormat.ONNX
                    model.load()
                return model

            try:
                try:
                    return attempt()
                except (OSError, InvalidProtobuf, BadZipFile, NoSuchFile) as error:
                    if not settings.model_downloads:
                        model.load_retry_at = time.monotonic() + 30.0
                        raise HTTPException(
                            503, "Staged model failed to load; repair it with the model-staging command"
                        ) from error
                    log.warning(
                        f"Failed to load {model.model_type.replace('_', ' ')} model '{model.model_name}'. "
                        "Clearing cache."
                    )
                    model.clear_cache()
                    return attempt()
            except ModelUnavailableError as error:
                # A missing model is a configuration problem; clearing the cache cannot fix it.
                raise HTTPException(503, str(error)) from error
            except (OSError, InvalidProtobuf, BadZipFile, NoSuchFile):
                # Cache hits extend TTL, so failed instances need a bounded recovery window of their own.
                model.load_retry_at = time.monotonic() + 30.0
                raise

    return await run(_load, model)


async def idle_shutdown_task() -> None:
    while True:
        if (
            last_called is not None
            and not active_requests
            and not lock.locked()
            and not (thread_pool is not None and thread_pool.busy)
            and time.time() - last_called > settings.model_ttl
        ):
            log.info("Shutting down due to inactivity.")
            os.kill(os.getpid(), signal.SIGINT)
            break
        await asyncio.sleep(settings.model_ttl_poll_s)
