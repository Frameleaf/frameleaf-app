"""Studio captions: Whisper speech to text through faster-whisper (CTranslate2), owner decision 2026-10-09.

The server sends one clip's audio as a 16 kHz mono 16-bit PCM WAV and asks for `frameleaf-transcribe`.
That name stands for the worker's own choice of model: `MACHINE_LEARNING_TRANSCRIPTION_MODEL` when an
administrator set one, otherwise whisper-large-v3-turbo on a CUDA GPU and whisper-small on a CPU. The
model files come from the model source (`frameleaf/<model>/audio/*`) and are pinned by SHA-256.

The answer is a stream (`stream()`): the detected language first, then one segment at a time with its
words, so the server can report progress and stop the work by closing the connection
(docs/docs/developer/studio-graph-protocol-v1.md, section 15.1).
"""

from __future__ import annotations

import hashlib
import io
import wave
from collections.abc import Generator
from pathlib import Path
from typing import Any, BinaryIO

import numpy as np
from numpy.typing import NDArray

from immich_ml.config import log, model_source_url, settings
from immich_ml.models.base import MODEL_SOURCE_ORG, InferenceModel, ModelUnavailableError
from immich_ml.models.constants import (
    TRANSCRIBE_MODEL_ALIAS,
    default_transcribe_model,
    get_transcribe_model_file,
)
from immich_ml.schemas import ModelFormat, ModelTask, ModelType

SAMPLE_RATE = 16_000
# Four hours of 16 kHz mono 16-bit audio; the server refuses longer clips before sending them.
MAX_SECONDS = 4 * 60 * 60


class AudioFormatError(ValueError):
    """The upload is not 16 kHz mono 16-bit PCM WAV, or is empty or too long."""


def read_wav(file: BinaryIO | bytes) -> NDArray[np.float32]:
    """Samples in -1..1 from a 16 kHz mono 16-bit PCM WAV; anything else is refused, never resampled."""
    try:
        with wave.open(io.BytesIO(file) if isinstance(file, bytes) else file, "rb") as reader:
            if reader.getnchannels() != 1 or reader.getsampwidth() != 2 or reader.getframerate() != SAMPLE_RATE:
                raise AudioFormatError("Audio must be 16 kHz mono 16-bit PCM WAV")
            frames = reader.getnframes()
            if frames <= 0:
                raise AudioFormatError("The audio is empty")
            if frames > MAX_SECONDS * SAMPLE_RATE:
                raise AudioFormatError(f"The audio is longer than {MAX_SECONDS // 3600} hours")
            data = reader.readframes(frames)
    except (wave.Error, EOFError) as error:
        raise AudioFormatError("Audio must be 16 kHz mono 16-bit PCM WAV") from error
    samples = np.frombuffer(data, dtype="<i2")
    if samples.size == 0:
        raise AudioFormatError("The audio is empty")
    return samples.astype(np.float32) / 32768.0


def cuda_device_count() -> int:
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count())
    except Exception:
        return 0


def resolve_transcribe_model(model_name: str) -> str:
    """The concrete Whisper model a request names; the alias resolves to this worker's choice."""
    if model_name != TRANSCRIBE_MODEL_ALIAS:
        return model_name
    configured = (settings.transcription_model or "").strip()
    if configured:
        return configured
    return default_transcribe_model(gpu=cuda_device_count() > 0)


class TranscribeModel(InferenceModel):
    depends = []
    identity = (ModelType.AUDIO, ModelTask.TRANSCRIBE)

    def __init__(self, model_name: str, **model_kwargs: Any) -> None:
        super().__init__(resolve_transcribe_model(model_name), **model_kwargs, model_format=ModelFormat.ONNX)

    @property
    def model_path(self) -> Path:
        return self.model_dir / "model.bin"

    @property
    def cached(self) -> bool:
        source = get_transcribe_model_file(self.model_name)
        return source is not None and all((self.cache_dir / path).is_file() for path, _ in source.files)

    def _download(self) -> None:
        source = get_transcribe_model_file(self.model_name)
        if source is None:
            # An unknown name is a missing model (503), never a generic download from the source.
            raise self._unavailable(
                f"{MODEL_SOURCE_ORG}/{self.model_name}", model_source_url(), "is not a transcription model"
            )
        repo_id = f"{MODEL_SOURCE_ORG}/{source.repo}"
        self._download_from_source(source.repo, allow_patterns=[f"{self.model_type.value}/*"])
        for path, expected in source.files:
            file = self.cache_dir / path
            if not file.is_file():
                raise self._unavailable(repo_id, model_source_url(), reason=f"has no {path}")
            digest = hashlib.sha256()
            with file.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1 << 20), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected:
                file.unlink()
                raise self._unavailable(repo_id, model_source_url(), reason=f"failed the checksum of {path}")

    def _load(self) -> Any:
        try:
            from faster_whisper import WhisperModel
        except ImportError as error:
            raise ModelUnavailableError("This worker has no Whisper runtime (faster-whisper)") from error
        if cuda_device_count() > 0:
            device, compute_type = "cuda", "float16"
        else:
            device, compute_type = "cpu", "int8"
        log.info(f"Loading Whisper model '{self.model_name}' on {device} ({compute_type})")
        return WhisperModel(
            str(self.model_dir),
            device=device,
            compute_type=compute_type,
            cpu_threads=settings.model_intra_op_threads,
            local_files_only=True,
        )

    @property
    def languages(self) -> set[str]:
        self.load()
        return set(getattr(self.session, "supported_languages", None) or [])

    def stream(
        self, audio: NDArray[np.float32], language: str | None = None, wordTimestamps: bool = True, **_: Any
    ) -> Generator[dict[str, Any], None, None]:
        """`info` first (language, duration, model), then one `segment` at a time. Lazy: no decoding
        happens until the first item is taken, and none after the consumer stops taking them."""
        self.load()
        whisper: Any = self.session
        segments, info = whisper.transcribe(
            audio,
            language=language,
            word_timestamps=wordTimestamps,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        yield {
            "type": "info",
            "model": self.model_name,
            "language": info.language,
            "languageProbability": round(float(info.language_probability), 4),
            "duration": round(float(info.duration), 3),
        }
        for segment in segments:
            words = [
                {"start": round(float(w.start), 3), "end": round(float(w.end), 3), "text": w.word}
                for w in (segment.words or [])
            ]
            yield {
                "type": "segment",
                "start": round(float(segment.start), 3),
                "end": round(float(segment.end), 3),
                "text": segment.text.strip(),
                "words": words,
            }

    def _predict(self, audio: NDArray[np.float32], **options: Any) -> dict[str, Any]:
        """The whole transcript at once (the stream collected)."""
        items = list(self.stream(audio, **options))
        info = items[0]
        return {**{k: v for k, v in info.items() if k != "type"}, "segments": items[1:]}
