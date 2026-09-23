"""One restoration inference from upload to restored file (FL-114).

The pipeline checks the upload against what the server measured, refuses anything the
selected model is not qualified for (HDR, high bit depth, variable frame rate, oversized
input, too many frames), decodes frames, runs the model adapter, validates every restored
frame, resizes conventionally to the requested size and encodes a new file with the
source's exact frame rate and audio. The uploaded file is only ever read.
"""

import hashlib
import math
import time
from collections.abc import Callable
from fractions import Fraction
from pathlib import Path
from typing import Literal

from . import media
from .models import (
    RestorationAdapter,
    RestorationFailure,
    RestorationRegistry,
    RuntimeJob,
    SelectedModel,
    adapter_for,
)
from .schemas import (
    RESTORATION_PROTOCOL,
    DynamicRange,
    ModelIdentity,
    OutputDescription,
    RestorationErrorCode,
    RestorationRequest,
    RestorationResult,
    RestorationTiming,
    WeightIdentity,
)

# Allowed disagreement between the server's measured duration and the upload's.
DURATION_TOLERANCE_MS = 100
MEDIA_TIMEOUT_S = 3600.0

AdapterFactory = Callable[[SelectedModel], RestorationAdapter]


def _elapsed_ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _unsupported(message: str, model_id: str) -> RestorationFailure:
    return RestorationFailure(RestorationErrorCode.UNSUPPORTED_INPUT, message, model_id=model_id)


def check_source(
    request: RestorationRequest,
    source: media.SourceProbe,
    selected: SelectedModel,
) -> tuple[int | None, int | None, int]:
    """Refuse an upload the server mis-described or the model is not qualified for.

    Returns the segment bounds to decode and the estimated frame count.
    """
    model_id = selected.spec.id
    declared = request.source
    still = request.kind == "image"

    def mismatch(detail: str) -> RestorationFailure:
        return RestorationFailure(RestorationErrorCode.SOURCE_MISMATCH, detail, model_id=model_id)

    if (source.width, source.height) != (declared.width, declared.height):
        raise mismatch(
            f"the upload is {source.width}x{source.height}; the request described {declared.width}x{declared.height}"
        )
    frame_ms = 1000 / float(source.frame_rate)
    if not still:
        if declared.frameRate is not None and source.frame_rate != Fraction(declared.frameRate):
            raise mismatch(f"the upload runs at {source.frame_rate_text}; the request described {declared.frameRate}")
        if declared.durationMs is not None and abs(source.duration_ms - declared.durationMs) > max(
            DURATION_TOLERANCE_MS, frame_ms
        ):
            raise mismatch(f"the upload lasts {source.duration_ms} ms; the request described {declared.durationMs} ms")
    if declared.dynamicRange is not None and declared.dynamicRange != source.dynamic_range:
        raise mismatch(f"the upload is {source.dynamic_range}; the request described {declared.dynamicRange}")

    allowed = selected.capability.dynamicRanges
    if source.dynamic_range not in allowed:
        raise _unsupported(
            f"{source.dynamic_range.upper()} sources are not qualified for {model_id}; restoration is SDR-only",
            model_id,
        )
    if source.bit_depth > 8 and DynamicRange.HDR not in allowed:
        raise _unsupported(f"{source.bit_depth}-bit sources are not qualified for {model_id}", model_id)
    if source.variable_frame_rate:
        raise _unsupported("variable frame rate sources must be conformed to a constant rate first", model_id)

    long_edge = max(source.width, source.height)
    if long_edge > selected.spec.limits.maxInputLongEdge:
        raise _unsupported(
            f"the source long edge is {long_edge} px; {model_id} is qualified up to "
            f"{selected.spec.limits.maxInputLongEdge} px",
            model_id,
        )

    if still:
        return None, None, 1

    start_ms: int | None = None
    end_ms: int | None = None
    span_ms = source.duration_ms
    if request.segment is not None:
        if request.segment.endMs > source.duration_ms + frame_ms:
            raise RestorationFailure(
                RestorationErrorCode.INVALID_REQUEST,
                f"the segment ends at {request.segment.endMs} ms; the upload lasts {source.duration_ms} ms",
                model_id=model_id,
            )
        start_ms, end_ms = request.segment.startMs, request.segment.endMs
        span_ms = end_ms - start_ms

    estimated_frames = math.ceil(span_ms * float(source.frame_rate) / 1000)
    if estimated_frames > selected.spec.limits.maxFrames:
        raise _unsupported(
            f"about {estimated_frames} frames requested; {model_id} is qualified for {selected.spec.limits.maxFrames}",
            model_id,
        )
    return start_ms, end_ms, estimated_frames


def restore(
    registry: RestorationRegistry,
    request: RestorationRequest,
    media_path: Path,
    work_dir: Path,
    *,
    adapter_factory: AdapterFactory = adapter_for,
) -> tuple[RestorationResult, Path]:
    """Run one request. Returns the result and the path of the new restored file inside
    ``work_dir``; the caller streams it and then removes ``work_dir``."""
    started = time.monotonic()
    selected = registry.select(request.mode, request.modelId, request.modelFingerprint)
    model_id = selected.spec.id

    still = request.kind == "image"
    try:
        source = media.probe(media_path, still=still)
    except media.MediaError as error:
        code = RestorationErrorCode.UNSUPPORTED_INPUT if error.unsupported else RestorationErrorCode.RUNTIME_FAILED
        raise RestorationFailure(code, str(error), model_id=model_id)
    start_ms, end_ms, _ = check_source(request, source, selected)
    target = media.target_geometry(source.width, source.height, request.scale, request.maxWidth, request.maxHeight)

    decode_started = time.monotonic()
    source_frames = work_dir / "source-frames"
    try:
        frame_count = media.extract_frames(
            media_path,
            source_frames,
            start_ms=start_ms,
            end_ms=end_ms,
            yuv_matrix=source.yuv_matrix,
            timeout=MEDIA_TIMEOUT_S,
        )
    except media.MediaError as error:
        raise RestorationFailure(RestorationErrorCode.RUNTIME_FAILED, str(error), model_id=model_id)
    decode_ms = _elapsed_ms(decode_started)
    if frame_count == 0:
        raise _unsupported("the segment contains no frames", model_id)
    if still and frame_count != 1:
        raise _unsupported(f"a still decoded to {frame_count} frames; send animated images as video", model_id)
    if frame_count > selected.spec.limits.maxFrames:
        raise _unsupported(f"{frame_count} frames exceed the qualified {selected.spec.limits.maxFrames}", model_id)

    job = RuntimeJob(
        work_dir=work_dir,
        source_frames=source_frames,
        frame_count=frame_count,
        frame_rate=source.frame_rate_text,
        source_size=(source.width, source.height),
        target_size=target,
        seed=request.seed,
        yuv_matrix=source.yuv_matrix,
    )
    run = adapter_factory(selected).run(job)

    try:
        media.normalize_frame_names(run.frames_dir)
        restored_size = media.validate_output_frames(
            media.list_frames(source_frames), media.list_frames(run.frames_dir), expected_size=run.expected_size
        )
    except media.MediaError as error:
        raise RestorationFailure(RestorationErrorCode.INVALID_OUTPUT, str(error), model_id=model_id)
    warnings = list(run.warnings)
    if request.keepGrain:
        warnings.append(f"{model_id} has no grain control; fine grain may be smoothed")
    if run.expected_size is None and restored_size != target:
        warnings.append(
            f"the model returned {restored_size[0]}x{restored_size[1]}; "
            f"resized conventionally to {target[0]}x{target[1]}"
        )

    encode_started = time.monotonic()
    output_path = work_dir / ("restored.png" if still else "restored.mp4")
    audio: Literal["copied", "transcoded", "none"] = "none"
    try:
        if still:
            media.encode_still_output(run.frames_dir, output_path, target=target, timeout=MEDIA_TIMEOUT_S)
        else:
            audio = media.encode_output(
                run.frames_dir,
                output_path,
                source=media_path,
                source_probe=source,
                target=target,
                start_ms=start_ms,
                end_ms=end_ms,
                timeout=MEDIA_TIMEOUT_S,
            )
        restored = media.probe(output_path, still=still)
    except media.MediaError as error:
        raise RestorationFailure(RestorationErrorCode.RUNTIME_FAILED, str(error), model_id=model_id)
    encode_ms = _elapsed_ms(encode_started)
    if audio == "transcoded":
        warnings.append(f"audio ({', '.join(source.audio_codecs)}) was transcoded to AAC because MP4 cannot carry it")

    expected_ms = 0.0 if still else frame_count * 1000 / float(source.frame_rate)
    duration_off = not still and abs(restored.duration_ms - expected_ms) > max(
        DURATION_TOLERANCE_MS, 1000 / float(source.frame_rate)
    )
    if (restored.width, restored.height) != target or duration_off:
        raise RestorationFailure(
            RestorationErrorCode.INVALID_OUTPUT,
            f"the encoded file is {restored.width}x{restored.height}, {restored.duration_ms} ms; expected "
            f"{target[0]}x{target[1]}, about {int(expected_ms)} ms",
            model_id=model_id,
        )

    capability = selected.capability
    assert capability.fingerprint is not None and capability.qualificationId is not None
    runtime_seconds = max(run.runtime_ms, 1) / 1000
    result = RestorationResult(
        protocol=RESTORATION_PROTOCOL,
        requestId=request.requestId,
        mode=request.mode,
        model=ModelIdentity(
            id=selected.spec.id,
            family=selected.spec.family,
            mode=selected.spec.mode,
            revision=selected.spec.revision,
            fingerprint=capability.fingerprint,
            weights=[WeightIdentity(role=weight.role, sha256=weight.sha256) for weight in selected.spec.weights],
            qualificationId=capability.qualificationId,
        ),
        output=OutputDescription(
            width=restored.width,
            height=restored.height,
            frameRate=None if still else source.frame_rate_text,
            frameCount=frame_count,
            durationMs=None if still else restored.duration_ms,
            container="png" if still else "mp4",
            codec="png" if still else "h264",
            dynamicRange=DynamicRange.SDR,
            bitDepth=8,
            audio=audio,
            bytes=output_path.stat().st_size,
            sha256=_file_sha256(output_path),
        ),
        timing=RestorationTiming(
            decodeMs=decode_ms,
            runtimeMs=run.runtime_ms,
            encodeMs=encode_ms,
            totalMs=_elapsed_ms(started),
            framesPerSecond=round(frame_count / runtime_seconds, 3),
        ),
        peakVramBytes=run.peak_vram_bytes,
        seed=request.seed,
        warnings=warnings,
    )
    return result, output_path
