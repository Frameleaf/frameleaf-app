"""Make a movie (FL-561): new music for a Studio movie with MusicGen small, owner decision 2026-10-26.

The server asks for `frameleaf-music` with a prompt, a length in seconds and a seed. The model is the
8-bit ONNX export of MusicGen small that the Studio engine already admits; its files come from the
model source (`frameleaf/musicgen-small/audio/*`) and are pinned by SHA-256. It runs on the CPU with
ONNX Runtime, which every Frameleaf ML image has.

How it works: the T5 text encoder reads the prompt, the decoder writes four streams of EnCodec codes
(50 frames a second) one step at a time with classifier-free guidance, and the EnCodec decoder turns
the codes into 32 kHz mono audio. MusicGen writes at most 30 seconds at once, so a longer piece is
written in windows: each new window continues from the last 20 seconds of codes, so the whole piece
is one continuous code stream decoded once, with no seams.

The answer is a stream (`stream()`): progress items while the decoder works, then the audio.
"""

from __future__ import annotations

import hashlib
import io
import wave
from collections.abc import Generator
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from frameleaf_ml.config import log, model_source_url, settings
from frameleaf_ml.models.base import MODEL_SOURCE_ORG, InferenceModel, ModelUnavailableError
from frameleaf_ml.models.constants import get_music_model_file, resolve_music_model
from frameleaf_ml.schemas import ModelFormat, ModelTask, ModelType

SAMPLE_RATE = 32_000
FRAME_RATE = 50
NUM_CODEBOOKS = 4
PAD_TOKEN = 2048
VOCAB = 2048
NUM_LAYERS = 24
NUM_HEADS = 16
HEAD_DIM = 64
# MusicGen was trained on 30-second pieces; longer music continues from the last 20 seconds.
WINDOW_FRAMES = 30 * FRAME_RATE
CONTEXT_FRAMES = 20 * FRAME_RATE
MAX_SECONDS = 180
GUIDANCE_SCALE = 3.0
TOP_K = 250
# -1 dBFS: the loudest the music is written.
PEAK = 0.891


def music_frames(duration: float) -> int:
    """EnCodec frames for `duration` seconds, at least one."""
    return max(1, round(min(duration, MAX_SECONDS) * FRAME_RATE))


def music_windows(frames: int) -> list[int]:
    """The new frames each window writes: up to 30 seconds, then 10 seconds after 20 of context."""
    windows = [min(frames, WINDOW_FRAMES)]
    while sum(windows) < frames:
        windows.append(min(frames - sum(windows), WINDOW_FRAMES - CONTEXT_FRAMES))
    return windows


def generation_steps(frames: int) -> int:
    """How many decoder steps a piece of `frames` takes: one per new frame plus the codebook delay."""
    return sum(length + NUM_CODEBOOKS - 1 for length in music_windows(frames))


def delay_pattern(context: NDArray[np.int64], frames: int) -> NDArray[np.int64]:
    """The decoder's delayed layout of a piece `frames` long whose first frames are `context`.

    Codebook `k` holds frame `t` at position `1 + t + k`; position 0 is the start token. Known positions
    hold their code or the pad token, and positions still to be written hold -1.
    """
    known = context.shape[1]
    length = frames + NUM_CODEBOOKS
    pattern = np.full((NUM_CODEBOOKS, length), -1, dtype=np.int64)
    for k in range(NUM_CODEBOOKS):
        pattern[k, : k + 1] = PAD_TOKEN
        pattern[k, 1 + k : 1 + k + known] = context[k]
        pattern[k, 1 + k + frames :] = PAD_TOKEN
    return pattern


def undelay(sequence: NDArray[np.int64], frames: int) -> NDArray[np.int64]:
    """The codes of each codebook, frame by frame, out of the delayed layout."""
    return np.stack([sequence[k, 1 + k : 1 + k + frames] for k in range(NUM_CODEBOOKS)])


def sample_top_k(logits: NDArray[np.float32], rng: np.random.Generator, top_k: int = TOP_K) -> NDArray[np.int64]:
    """One token per row, drawn from the `top_k` most likely."""
    top = np.argpartition(-logits, top_k - 1, axis=-1)[:, :top_k]
    picked = np.take_along_axis(logits, top, axis=-1).astype(np.float64)
    picked -= picked.max(axis=-1, keepdims=True)
    weights = np.exp(picked)
    weights /= weights.sum(axis=-1, keepdims=True)
    choice = np.array([rng.choice(top_k, p=row) for row in weights])
    return top[np.arange(len(top)), choice].astype(np.int64)


def to_wav(samples: NDArray[np.float32], sample_rate: int = SAMPLE_RATE) -> bytes:
    """16-bit mono PCM WAV of samples in -1..1."""
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm.tobytes())
    return buffer.getvalue()


class MusicGenModel(InferenceModel):
    depends = []
    identity = (ModelType.AUDIO, ModelTask.MUSIC)

    def __init__(self, model_name: str, **model_kwargs: Any) -> None:
        super().__init__(resolve_music_model(model_name), **model_kwargs, model_format=ModelFormat.ONNX)

    @property
    def model_path(self) -> Path:
        return self.model_dir / "decoder_model_merged.onnx"

    @property
    def cached(self) -> bool:
        source = get_music_model_file(self.model_name)
        return source is not None and all((self.cache_dir / path).is_file() for path, _ in source.files)

    def _download(self) -> None:
        source = get_music_model_file(self.model_name)
        if source is None:
            raise self._unavailable(f"{MODEL_SOURCE_ORG}/{self.model_name}", model_source_url(), "is not a music model")
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
            import onnxruntime as ort
            from tokenizers import Tokenizer
        except ImportError as error:
            raise ModelUnavailableError("This worker has no ONNX Runtime for music") from error
        log.info(f"Loading music model '{self.model_name}' on the CPU")
        options = ort.SessionOptions()
        if settings.model_intra_op_threads > 0:
            options.intra_op_num_threads = settings.model_intra_op_threads
        if settings.model_inter_op_threads > 0:
            options.inter_op_num_threads = settings.model_inter_op_threads

        def session(name: str) -> Any:
            return ort.InferenceSession(str(self.model_dir / name), options, providers=["CPUExecutionProvider"])

        return {
            "tokenizer": Tokenizer.from_file(str(self.model_dir / "tokenizer.json")),
            "text": session("text_encoder.onnx"),
            "decoder": session("decoder_model_merged.onnx"),
            "encodec": session("encodec_decode.onnx"),
        }

    def _encode(self, prompt: str) -> tuple[NDArray[np.float32], NDArray[np.int64]]:
        """The prompt's encoding and mask, doubled for guidance: the prompt, then silence."""
        parts: Any = self.session
        ids = np.array([parts["tokenizer"].encode(prompt).ids], dtype=np.int64)
        mask = np.ones_like(ids)
        (hidden,) = parts["text"].run(["last_hidden_state"], {"input_ids": ids, "attention_mask": mask})
        hidden = hidden * mask[..., None]
        return (
            np.concatenate([hidden, np.zeros_like(hidden)]).astype(np.float32),
            np.concatenate([mask, np.zeros_like(mask)]),
        )

    def _window(
        self,
        encoded: tuple[NDArray[np.float32], NDArray[np.int64]],
        context: NDArray[np.int64],
        frames: int,
        rng: np.random.Generator,
    ) -> Generator[None, None, NDArray[np.int64]]:
        """Write a piece `frames` long that starts with `context`, yielding once per decoder step, and
        return all its codes."""
        decoder: Any = self.session["decoder"]  # type: ignore[index]
        hidden, mask = encoded
        pattern = delay_pattern(context, frames)
        sequence = np.where(pattern >= 0, pattern, PAD_TOKEN)
        start = int(np.argmax((pattern < 0).any(axis=0)))
        empty = np.zeros((2, NUM_HEADS, 0, HEAD_DIM), dtype=np.float32)
        past: dict[str, NDArray[np.float32]] = {}
        for layer in range(NUM_LAYERS):
            for side in ("decoder", "encoder"):
                for kind in ("key", "value"):
                    past[f"past_key_values.{layer}.{side}.{kind}"] = empty
        names = [output.name for output in decoder.get_outputs()]
        inputs = sequence[:, :start]
        cached = False
        for position in range(start, pattern.shape[1]):
            feed = {
                "input_ids": np.concatenate([inputs, inputs]),
                "encoder_hidden_states": hidden,
                "encoder_attention_mask": mask,
                "use_cache_branch": np.array([cached]),
                **past,
            }
            outputs = dict(zip(names, decoder.run(names, feed)))
            logits = outputs["logits"][:, -1, :]
            conditional, unconditional = logits[:NUM_CODEBOOKS], logits[NUM_CODEBOOKS:]
            guided = unconditional + (conditional - unconditional) * GUIDANCE_SCALE
            tokens = sample_top_k(guided, rng)
            known = pattern[:, position]
            sequence[:, position] = np.where(known >= 0, known, tokens)
            inputs = sequence[:, position : position + 1]
            for name, value in outputs.items():
                # The cross-attention keys come from the first run only; later runs return placeholders.
                if name.startswith("present.") and (not cached or ".decoder." in name):
                    past["past_key_values." + name[len("present.") :]] = value
            cached = True
            yield
        return undelay(sequence, frames)

    def stream(self, prompt: str, duration: float, seed: int = 0, **_: Any) -> Generator[dict[str, Any], None, None]:
        """`progress` items while the codes are written (lazy: nothing runs until the first is taken,
        and nothing more after the consumer stops), then one `audio` item with the WAV bytes."""
        self.load()
        frames = music_frames(duration)
        total = generation_steps(frames)
        rng = np.random.default_rng(seed)
        encoded = self._encode(prompt)
        codes = np.zeros((NUM_CODEBOOKS, 0), dtype=np.int64)
        done = 0
        yield {"type": "progress", "done": 0, "total": total}
        for index, length in enumerate(music_windows(frames)):
            context = codes[:, -CONTEXT_FRAMES:] if index else codes
            window = self._window(encoded, context, context.shape[1] + length, rng)
            while True:
                try:
                    next(window)
                except StopIteration as finished:
                    codes = np.concatenate([codes, finished.value[:, context.shape[1] :]], axis=1)
                    break
                done += 1
                if done % 25 == 0:
                    yield {"type": "progress", "done": done, "total": total}
        audio = self._decode(codes)
        yield {"type": "progress", "done": total, "total": total}
        yield {
            "type": "audio",
            "sampleRate": SAMPLE_RATE,
            "seconds": round(len(audio) / SAMPLE_RATE, 3),
            "wav": to_wav(audio),
        }

    def _decode(self, codes: NDArray[np.int64]) -> NDArray[np.float32]:
        """The audio of the codes, brought down to a -1 dBFS peak when it would clip."""
        encodec: Any = self.session["encodec"]  # type: ignore[index]
        (audio,) = encodec.run(["audio_values"], {"audio_codes": codes[None, None, :, :]})
        samples = np.asarray(audio, dtype=np.float32).reshape(-1)
        peak = float(np.abs(samples).max()) if samples.size else 0.0
        return (samples * np.float32(PEAK / peak)).astype(np.float32) if peak > PEAK else samples

    def _predict(self, prompt: str, **options: Any) -> dict[str, Any]:
        """The whole piece at once (the stream collected)."""
        items = [item for item in self.stream(prompt, **options) if item["type"] == "audio"]
        return items[0]
