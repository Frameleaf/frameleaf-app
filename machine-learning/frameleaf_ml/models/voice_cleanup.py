"""Studio "Clean up voice" (FL-637): speech enhancement for one clip's sound, on the user's own hardware.

The server sends one clip's audio as a 48 kHz mono 16-bit PCM WAV and asks for `frameleaf-voice-cleanup`,
either to look at it (`mode: "analyze"`, what is in the sound) or to clean it (`mode: "clean"`).

- Wind and background noise go to DeepFilterNet3 (MIT or Apache-2.0), the ONNX export of its encoder,
  ERB-gain decoder and deep-filter decoder. Its files come from the model source
  (`frameleaf/deepfilternet3/audio/*`) and are pinned by SHA-256 in `voice-cleanup-models.json`. It runs
  on the CPU with ONNX Runtime, which every Frameleaf ML image has.
- Hum and buzz (mains at 50 or 60 Hz and its harmonics) is a set of narrow notches. Wind also gets a
  gentle low cut below the voice.
- Strength is the model's attenuation limit: Light keeps 12 dB of the noise (the room's sound stays),
  Standard keeps 24 dB, Strong has no limit (voice only).

The feature extraction matches libDF, the library the model was trained with: a 960-point STFT with a
480-sample hop and a Vorbis window at 48 kHz, 32 ERB bands of log power with a running mean, and the
first 96 bins as unit-normalised complex values. The encoder's output for a frame is the one two frames
later (its convolutions look ahead), so the outputs are moved two frames earlier; the deep filter covers
five frames, two of them ahead. That alignment was checked against the model: it gives about 13 dB more
signal-to-noise on speech in white noise than the unshifted outputs (16.5 dB from 3 dB, against 10 dB).

The answer is a stream (`stream()`): `progress` items while it works, then the cleaned WAV.
"""

from __future__ import annotations

import hashlib
import io
import json
import math
import wave
from collections.abc import Generator
from pathlib import Path
from typing import Any, BinaryIO, NamedTuple

import numpy as np
from numpy.typing import NDArray

from frameleaf_ml.config import clean_name, log, model_source_url, settings
from frameleaf_ml.models.base import MODEL_SOURCE_ORG, InferenceModel, ModelUnavailableError
from frameleaf_ml.schemas import ModelFormat, ModelTask, ModelType

SAMPLE_RATE = 48_000
# Ten minutes: cleaning holds about 48 bytes per sample, inside the default 1.5 GB audio budget. The
# server refuses longer clips before it sends them.
MAX_SECONDS = 10 * 60
FFT_SIZE = 960
HOP = 480
FREQS = FFT_SIZE // 2 + 1
NB_ERB = 32
NB_DF = 96
MIN_ERB_FREQS = 2
DF_ORDER = 5
DF_LOOKAHEAD = 2
CONV_LOOKAHEAD = 2
# libDF's running normalisation: exp(-hop / (sample rate * norm_tau)), norm_tau = 1 s.
ALPHA = math.exp(-HOP / SAMPLE_RATE)
# Frames per model run (30 s), with warm-up before and lookahead after that are run and discarded.
CHUNK_FRAMES = 3000
WARMUP_FRAMES = 300
TAIL_FRAMES = 8

NOISES = ("wind", "hum", "background", "echo")
# The attenuation limit for each strength, in dB; None is no limit.
STRENGTH_LIMIT_DB: dict[str, float | None] = {"light": 12.0, "standard": 24.0, "strong": None}
# Room echo asks the model for 6 dB more than the strength alone (the model reduces reverberation
# only as far as it reduces noise; there is no separate dereverberation model in v1).
ECHO_EXTRA_DB = 6.0
VOICE_CLEANUP_MODEL_ALIAS = "frameleaf-voice-cleanup"
DEFAULT_VOICE_CLEANUP_MODEL = "deepfilternet3"
# The analysis reads at most this much of the clip.
ANALYZE_SECONDS = 60


class VoiceModelFile(NamedTuple):
    """Where a speech-cleanup model lives on the model source: ONNX files under `audio/` in `frameleaf/<repo>`."""

    repo: str
    files: tuple[tuple[str, str], ...]


def _load_manifest() -> dict[str, VoiceModelFile]:
    raw: dict[str, Any] = json.loads(Path(__file__).with_name("voice-cleanup-models.json").read_text())
    return {
        name: VoiceModelFile(entry["repo"], tuple(sorted((path, digest) for path, digest in entry["files"].items())))
        for name, entry in raw.items()
    }


VOICE_MODELS = _load_manifest()


def resolve_voice_model(model_name: str) -> str:
    name = clean_name(model_name)
    return DEFAULT_VOICE_CLEANUP_MODEL if name == VOICE_CLEANUP_MODEL_ALIAS else name


def get_voice_model_file(model_name: str) -> VoiceModelFile | None:
    return VOICE_MODELS.get(resolve_voice_model(model_name))


class VoiceAudioError(ValueError):
    """The upload is not 48 kHz mono 16-bit PCM WAV, or is empty or too long."""


def voice_wav_frames(file: BinaryIO | bytes) -> int:
    """The number of samples in a valid 48 kHz mono 16-bit PCM WAV, without reading them."""
    stream = io.BytesIO(file) if isinstance(file, bytes) else file
    start = stream.tell()
    try:
        with wave.open(stream, "rb") as reader:
            if reader.getnchannels() != 1 or reader.getsampwidth() != 2 or reader.getframerate() != SAMPLE_RATE:
                raise VoiceAudioError("Audio must be 48 kHz mono 16-bit PCM WAV")
            frames = reader.getnframes()
    except (wave.Error, EOFError, RuntimeError) as error:
        raise VoiceAudioError("Audio must be 48 kHz mono 16-bit PCM WAV") from error
    finally:
        stream.seek(start)
    if frames <= 0:
        raise VoiceAudioError("The audio is empty")
    if frames > MAX_SECONDS * SAMPLE_RATE:
        raise VoiceAudioError(f"The audio is longer than {MAX_SECONDS // 60} minutes")
    return frames


def voice_memory_bytes(file: BinaryIO | bytes) -> int:
    """What cleaning the upload holds at once: the samples as float, their spectrum and the output."""
    return voice_wav_frames(file) * 48


def read_voice_wav(file: BinaryIO | bytes) -> NDArray[np.float32]:
    """Samples in -1..1 from a validated 48 kHz mono 16-bit PCM WAV."""
    frames = voice_wav_frames(file)
    with wave.open(io.BytesIO(file) if isinstance(file, bytes) else file, "rb") as reader:
        data = reader.readframes(frames)
    if len(data) != frames * 2:
        raise VoiceAudioError("The WAV is truncated")
    return (np.frombuffer(data, dtype="<i2").astype(np.float32) / np.float32(32768.0)).astype(np.float32)


def to_voice_wav(samples: NDArray[np.float32]) -> bytes:
    """16-bit mono 48 kHz PCM WAV of samples in -1..1."""
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(SAMPLE_RATE)
        writer.writeframes(pcm.tobytes())
    return buffer.getvalue()


# ------------------------------------------------------------------ STFT and features (libDF)


def vorbis_window(size: int = FFT_SIZE) -> NDArray[np.float32]:
    n = np.arange(size, dtype=np.float64)
    return np.sin(0.5 * np.pi * np.sin(np.pi * (n + 0.5) / size) ** 2).astype(np.float32)


_WINDOW = vorbis_window()


def stft(samples: NDArray[np.float32]) -> NDArray[np.complex64]:
    """Frames of the 960-point spectrum, hop 480, scaled like libDF (1/N). Frame `t` ends at sample
    `(t + 1) * HOP`, as in libDF's real-time analysis; `istft` puts the samples back where they were."""
    count = math.ceil(len(samples) / HOP) + 1
    padded = np.zeros((count + 1) * HOP, dtype=np.float32)
    padded[FFT_SIZE - HOP : FFT_SIZE - HOP + len(samples)] = samples
    index = np.arange(FFT_SIZE)[None, :] + HOP * np.arange(count)[:, None]
    spectrum = np.fft.rfft(padded[index] * _WINDOW, axis=-1) / FFT_SIZE
    return spectrum.astype(np.complex64)


def istft(spectrum: NDArray[np.complex64], length: int) -> NDArray[np.float32]:
    """Overlap-add of the frames back to `length` samples; the Vorbis window reconstructs exactly."""
    frames = np.fft.irfft(spectrum.astype(np.complex128) * FFT_SIZE, n=FFT_SIZE, axis=-1) * _WINDOW
    out = np.zeros((len(spectrum) + 1) * HOP, dtype=np.float64)
    for index in range(len(frames)):
        out[index * HOP : index * HOP + FFT_SIZE] += frames[index]
    start = FFT_SIZE - HOP
    return out[start : start + length].astype(np.float32)


def freq_to_erb(freq: float) -> float:
    return 9.265 * math.log1p(freq / (24.7 * 9.265))


def erb_to_freq(erb: float) -> float:
    return 24.7 * 9.265 * (math.exp(erb / 9.265) - 1.0)


def erb_widths(
    sample_rate: int = SAMPLE_RATE, fft_size: int = FFT_SIZE, bands: int = NB_ERB, min_freqs: int = MIN_ERB_FREQS
) -> list[int]:
    """How many frequency bins each ERB band holds (libDF `erb_fb`); they cover every bin once."""
    width = sample_rate / fft_size
    low, high = freq_to_erb(0.0), freq_to_erb(sample_rate / 2)
    step = (high - low) / bands
    widths = [0] * bands
    previous = 0
    over = 0
    for band in range(1, bands + 1):
        top = round(erb_to_freq(low + band * step) / width)
        count = top - previous - over
        if count < min_freqs:
            over = min_freqs - count
            count = min_freqs
        else:
            over = 0
        widths[band - 1] = count
        previous = top
    widths[-1] += 1
    extra = sum(widths) - (fft_size // 2 + 1)
    if extra > 0:
        widths[-1] -= extra
    return widths


_ERB_WIDTHS = erb_widths()
# Bin -> band, for expanding a band gain to every bin of it.
_ERB_INDEX = np.repeat(np.arange(NB_ERB), _ERB_WIDTHS)


def erb_features(spectrum: NDArray[np.complex64]) -> NDArray[np.float32]:
    """Log power per ERB band, less its running mean, over 40 (libDF `band_mean_norm_erb`)."""
    power = (spectrum.real.astype(np.float64) ** 2) + (spectrum.imag.astype(np.float64) ** 2)
    sums = np.add.reduceat(power, np.cumsum([0, *_ERB_WIDTHS[:-1]]), axis=-1)
    bands = 10.0 * np.log10(sums / np.asarray(_ERB_WIDTHS) + 1e-10)
    state = np.linspace(-60.0, -90.0, NB_ERB)
    out = np.empty_like(bands)
    for index, row in enumerate(bands):
        state = row * (1.0 - ALPHA) + state * ALPHA
        out[index] = (row - state) / 40.0
    return out.astype(np.float32)


def spec_features(spectrum: NDArray[np.complex64]) -> NDArray[np.complex64]:
    """The first 96 bins over the square root of their running mean magnitude (libDF `band_unit_norm`)."""
    low = spectrum[:, :NB_DF].astype(np.complex128)
    state = np.linspace(0.001, 0.0001, NB_DF)
    out = np.empty_like(low)
    for index, row in enumerate(low):
        state = np.abs(row) * (1.0 - ALPHA) + state * ALPHA
        out[index] = row / np.sqrt(state)
    return out.astype(np.complex64)


def deep_filter(spectrum: NDArray[np.complex64], coefs: NDArray[np.float32]) -> NDArray[np.complex64]:
    """The low bins of each frame as the sum of five neighbouring frames (two before, two after) weighed
    by the complex coefficients the model gives (`coefs`: frames x order x 96 x 2)."""
    frames = len(spectrum)
    low = spectrum[:, :NB_DF]
    before = DF_ORDER - 1 - DF_LOOKAHEAD
    padded = np.concatenate(
        [
            np.zeros((before, NB_DF), dtype=np.complex64),
            low,
            np.zeros((DF_LOOKAHEAD, NB_DF), dtype=np.complex64),
        ]
    )
    weights = coefs[..., 0] + 1j * coefs[..., 1]
    out = np.zeros((frames, NB_DF), dtype=np.complex64)
    for order in range(DF_ORDER):
        out += (padded[order : order + frames] * weights[:, order]).astype(np.complex64)
    return out


def advanced(values: NDArray[Any], frames: int) -> NDArray[Any]:
    """`values` moved `frames` earlier along the first axis; the last frames repeat the last value."""
    if frames <= 0 or len(values) == 0:
        return values
    out = np.empty_like(values)
    out[: len(values) - frames] = values[frames:]
    out[len(values) - frames :] = values[-1]
    return out


# ------------------------------------------------------------------ hum and wind (long FFT)

_LONG = 1 << 16


def low_end_gain(freqs: NDArray[np.float64], hum_hz: float | None, wind: bool) -> NDArray[np.float64]:
    """The gain for each frequency: narrow notches on the mains hum and its harmonics up to 1 kHz, and a
    gentle low cut below the voice for wind."""
    gain = np.ones_like(freqs)
    if hum_hz:
        harmonic = hum_hz
        while harmonic <= 1000.0:
            distance = np.abs(freqs - harmonic)
            # -40 dB within 1.5 Hz, raised-cosine back to 0 dB at 4 Hz.
            depth = np.clip((distance - 1.5) / 2.5, 0.0, 1.0)
            notch = 0.01 + 0.99 * (0.5 - 0.5 * np.cos(np.pi * depth))
            gain *= notch
            harmonic += hum_hz
    if wind:
        # -30 dB below 60 Hz, raised-cosine to 0 dB at 100 Hz.
        ramp = np.clip((freqs - 60.0) / 40.0, 0.0, 1.0)
        gain *= 0.03 + 0.97 * (0.5 - 0.5 * np.cos(np.pi * ramp))
    return gain


def shape_low_end(samples: NDArray[np.float32], hum_hz: float | None, wind: bool) -> NDArray[np.float32]:
    """Apply `low_end_gain` with 65536-point frames (0.7 Hz resolution) and square-root Hann windows."""
    if not hum_hz and not wind:
        return samples
    hop = _LONG // 2
    window = np.sqrt(0.5 - 0.5 * np.cos(2 * np.pi * np.arange(_LONG) / _LONG))
    count = math.ceil(len(samples) / hop) + 1
    padded = np.zeros((count + 1) * hop, dtype=np.float64)
    padded[hop : hop + len(samples)] = samples
    gain = low_end_gain(np.fft.rfftfreq(_LONG, 1.0 / SAMPLE_RATE), hum_hz, wind)
    out = np.zeros_like(padded)
    for index in range(count):
        start = index * hop
        frame = padded[start : start + _LONG] * window
        out[start : start + _LONG] += np.fft.irfft(np.fft.rfft(frame) * gain, n=_LONG) * window
    return out[hop : hop + len(samples)].astype(np.float32)


# ------------------------------------------------------------------ analysis


def _db(value: NDArray[np.float64] | float) -> Any:
    return 10.0 * np.log10(np.asarray(value) + 1e-12)


def detect_hum(samples: NDArray[np.float32]) -> float | None:
    """50 or 60 when the averaged 1 Hz spectrum has narrow peaks on that mains frequency's harmonics."""
    size = SAMPLE_RATE
    if len(samples) < size:
        return None
    window = np.hanning(size)
    frames = len(samples) // size
    power = np.zeros(size // 2 + 1)
    for index in range(frames):
        power += np.abs(np.fft.rfft(samples[index * size : (index + 1) * size] * window)) ** 2
    power /= frames
    best: tuple[float, float] | None = None
    for base in (50, 60):
        scores = []
        for k in range(1, 5):
            centre = base * k
            peak = power[centre - 1 : centre + 2].max()
            around = np.concatenate([power[centre - 8 : centre - 3], power[centre + 4 : centre + 9]])
            scores.append(float(_db(peak) - _db(np.median(around))))
        # The fundamental or its first harmonic stands out, and a second harmonic does too: a room's
        # colouring can lift one narrow band, not a mains series.
        ranked = sorted(scores, reverse=True)
        score = min(max(scores[0], scores[1]), ranked[1] + 2.0)
        if best is None or score > best[1]:
            best = (float(base), score)
    return best[0] if best and best[1] >= 12.0 else None


def analyze_noise(samples: NDArray[np.float32]) -> dict[str, Any]:
    """What is in the sound: `noises` (a subset of wind, hum, background, echo) and the hum frequency.

    A quick look, not a measurement: the card pre-ticks what it finds and the person can change it.
    """
    samples = samples[: ANALYZE_SECONDS * SAMPLE_RATE]
    found: list[str] = []
    hum = detect_hum(samples)
    frame = 960
    count = len(samples) // frame
    if count < 10:
        return {"noises": ["hum"] if hum else [], "humHz": hum}
    blocks = samples[: count * frame].astype(np.float64).reshape(count, frame)
    energy = np.mean(blocks**2, axis=1)
    level = _db(energy)
    floor = float(np.percentile(level, 10))
    peak = float(np.percentile(level, 95))
    if peak < -60.0:
        return {"noises": ["hum"] if hum else [], "humHz": hum}

    spectra = np.abs(np.fft.rfft(blocks * np.hanning(frame), axis=1)) ** 2
    freqs = np.fft.rfftfreq(frame, 1.0 / SAMPLE_RATE)
    low = spectra[:, freqs < 150.0].sum(axis=1)
    total = spectra.sum(axis=1) + 1e-12
    # Wind: rumble below 150 Hz carrying most of the energy in a good share of the loud moments.
    loud = level > floor + 6.0
    if loud.sum() >= 5 and float(np.mean((low / total)[loud] > 0.5)) >= 0.15:
        found.append("wind")
    if hum:
        found.append("hum")
    # Background noise: a noise floor that never drops away between words.
    if floor > -60.0 and peak - floor < 40.0:
        found.append("background")
    if has_echo(samples, peak):
        found.append("echo")
    return {"noises": [noise for noise in NOISES if noise in found], "humHz": hum}


def has_echo(samples: NDArray[np.float32], peak: float) -> bool:
    """Room echo: after the voice stops, the sound fades away slowly instead of stopping.

    In each pause after speech (10 ms steps), dry speech is 40 dB down within 60 ms, and steady noise
    drops to its level and stays there. An echoing room is still within 30 dB of the voice 60 to 100 ms
    into the pause, and still falling 100 ms later.
    """
    envelope = _db(np.mean(samples[: (len(samples) // 480) * 480].astype(np.float64).reshape(-1, 480) ** 2, axis=1))
    speech = peak - 20.0
    echoes = 0
    pauses = 0
    for index in range(len(envelope) - 21):
        if envelope[index] < speech or envelope[index + 1] >= speech:
            continue
        gap = envelope[index + 1 : index + 21]
        if gap.max() >= speech:
            continue
        pauses += 1
        early = float(gap[6:10].mean())
        if early > envelope[index] - 30.0 and early - float(gap[16:20].mean()) > 3.0:
            echoes += 1
    return pauses >= 2 and echoes * 2 > pauses


# ------------------------------------------------------------------ the model


def attenuation_limit(strength: str, noises: list[str]) -> float | None:
    """The attenuation limit in dB for the strength; Room echo asks for a little more."""
    limit = STRENGTH_LIMIT_DB[strength]
    if limit is not None and "echo" in noises:
        limit += ECHO_EXTRA_DB
    return limit


class VoiceCleanupModel(InferenceModel):
    depends = []
    identity = (ModelType.AUDIO, ModelTask.VOICE_CLEANUP)

    def __init__(self, model_name: str, **model_kwargs: Any) -> None:
        super().__init__(resolve_voice_model(model_name), **model_kwargs, model_format=ModelFormat.ONNX)

    @property
    def model_path(self) -> Path:
        return self.model_dir / "enc.onnx"

    @property
    def cached(self) -> bool:
        source = get_voice_model_file(self.model_name)
        return source is not None and all((self.cache_dir / path).is_file() for path, _ in source.files)

    def _download(self) -> None:
        source = get_voice_model_file(self.model_name)
        if source is None:
            raise self._unavailable(
                f"{MODEL_SOURCE_ORG}/{self.model_name}", model_source_url(), "is not a voice clean-up model"
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
            import onnxruntime as ort
        except ImportError as error:
            raise ModelUnavailableError("This worker has no ONNX Runtime for voice clean-up") from error
        log.info(f"Loading voice clean-up model '{self.model_name}' on the CPU")
        options = ort.SessionOptions()
        if settings.model_intra_op_threads > 0:
            options.intra_op_num_threads = settings.model_intra_op_threads
        if settings.model_inter_op_threads > 0:
            options.inter_op_num_threads = settings.model_inter_op_threads

        def session(name: str) -> Any:
            return ort.InferenceSession(str(self.model_dir / name), options, providers=["CPUExecutionProvider"])

        return {"enc": session("enc.onnx"), "erb_dec": session("erb_dec.onnx"), "df_dec": session("df_dec.onnx")}

    def _run(
        self, erb: NDArray[np.float32], spec: NDArray[np.complex64]
    ) -> tuple[NDArray[np.float32], NDArray[np.float32]]:
        """The ERB gains (frames x 32) and deep-filter coefficients (frames x order x 96 x 2) for a run of
        frames, aligned to the frames they apply to."""
        parts: Any = self.session
        feat_erb = erb[None, None, :, :].astype(np.float32)
        feat_spec = np.stack([spec.real, spec.imag])[None].astype(np.float32)
        e0, e1, e2, e3, emb, c0, _ = parts["enc"].run(None, {"feat_erb": feat_erb, "feat_spec": feat_spec})
        (mask,) = parts["erb_dec"].run(["m"], {"emb": emb, "e3": e3, "e2": e2, "e1": e1, "e0": e0})
        coefs = parts["df_dec"].run(None, {"emb": emb, "c0": c0})[0]
        frames = erb.shape[0]
        gains = np.asarray(mask, dtype=np.float32).reshape(frames, NB_ERB)
        weights = np.asarray(coefs, dtype=np.float32).reshape(frames, NB_DF, DF_ORDER, 2).transpose(0, 2, 1, 3)
        return advanced(gains, CONV_LOOKAHEAD), advanced(weights, CONV_LOOKAHEAD)

    def enhance(self, spectrum: NDArray[np.complex64]) -> Generator[int, None, NDArray[np.complex64]]:
        """The model's clean spectrum, in runs of 30 s; yields the frames done after each run."""
        frames = len(spectrum)
        erb = erb_features(spectrum)
        spec = spec_features(spectrum)
        out = np.empty_like(spectrum)
        for start in range(0, frames, CHUNK_FRAMES):
            end = min(frames, start + CHUNK_FRAMES)
            first = max(0, start - WARMUP_FRAMES)
            last = min(frames, end + TAIL_FRAMES)
            gains, weights = self._run(erb[first:last], spec[first:last])
            part = spectrum[first:last]
            cleaned = part * gains[:, _ERB_INDEX]
            cleaned[:, :NB_DF] = deep_filter(part, weights)
            out[start:end] = cleaned[start - first : end - first]
            yield end
        return out

    def stream(
        self,
        audio: NDArray[np.float32],
        mode: str = "clean",
        strength: str = "standard",
        noises: list[str] | None = None,
        humHz: float | None = None,
        **_: Any,
    ) -> Generator[dict[str, Any], None, None]:
        """For `analyze`, one `analysis` item. For `clean`, `progress` items, then one `audio` item with
        the WAV. Lazy: nothing runs until the first item is taken, nothing more once the consumer stops."""
        if mode == "analyze":
            yield {"type": "analysis", **analyze_noise(audio)}
            return
        chosen = [noise for noise in NOISES if noise in (noises or [])]
        hum = (humHz or detect_hum(audio) or 50.0) if "hum" in chosen else None
        model_noises = {"wind", "background", "echo"} & set(chosen)
        frames = math.ceil(len(audio) / HOP) + 1
        total = frames + 1
        yield {"type": "progress", "done": 0, "total": total}
        samples = shape_low_end(audio, hum, "wind" in chosen)
        if model_noises:
            self.load()
            spectrum = stft(samples)
            run = self.enhance(spectrum)
            while True:
                try:
                    done = next(run)
                except StopIteration as finished:
                    cleaned: NDArray[np.complex64] = finished.value
                    break
                yield {"type": "progress", "done": done, "total": total}
            limit = attenuation_limit(strength, chosen)
            if limit is not None:
                keep = np.float32(10 ** (-limit / 20))
                cleaned = (cleaned * (1 - keep) + spectrum * keep).astype(np.complex64)
            samples = istft(cleaned, len(audio))
        yield {"type": "progress", "done": total, "total": total}
        yield {
            "type": "audio",
            "sampleRate": SAMPLE_RATE,
            "seconds": round(len(audio) / SAMPLE_RATE, 3),
            "wav": to_voice_wav(samples),
        }

    def _predict(self, audio: NDArray[np.float32], **options: Any) -> dict[str, Any]:
        """The whole answer at once (the stream collected): the analysis or the audio item."""
        items = [item for item in self.stream(audio, **options) if item["type"] != "progress"]
        return items[-1]
