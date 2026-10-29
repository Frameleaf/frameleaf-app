"""Studio "Clean up voice" (FL-637): the `voice-cleanup` task, with small fake ONNX sessions for DeepFilterNet3.

The fixture WAVs are made here: a voice-like signal (a 140 Hz voice with harmonics, spoken in syllables
with pauses) with mains hum, steady noise, wind or a room's echo added. `FRAMELEAF_TEST_DEEPFILTERNET3_DIR`
pointing at the three pinned ONNX files also runs the real model on them.
"""

import base64
import hashlib
import io
import json
import os
import wave
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from numpy.typing import NDArray
from pydantic import ValidationError
from pytest_mock import MockerFixture

from frameleaf_ml.models import get_model_class
from frameleaf_ml.models.base import ModelUnavailableError
from frameleaf_ml.models.voice_cleanup import (
    DF_ORDER,
    FREQS,
    NB_DF,
    NB_ERB,
    SAMPLE_RATE,
    VOICE_CLEANUP_MODEL_ALIAS,
    VoiceAudioError,
    VoiceCleanupModel,
    analyze_noise,
    attenuation_limit,
    deep_filter,
    detect_hum,
    erb_widths,
    get_voice_model_file,
    istft,
    read_voice_wav,
    shape_low_end,
    stft,
    to_voice_wav,
    voice_wav_frames,
)
from frameleaf_ml.schemas import ModelTask, ModelType, validate_options

RNG = np.random.default_rng(7)


def voice(seconds: float = 6.0) -> NDArray[np.float32]:
    """Words of a 140 Hz voice: three 180 ms syllables 300 ms apart, then a pause, every 1.3 s."""
    t = np.arange(int(seconds * SAMPLE_RATE)) / SAMPLE_RATE
    tone = sum(np.sin(2 * np.pi * 140 * k * t) / k for k in range(1, 12))
    word = t % 1.3
    phase = (word % 0.3) / 0.18
    envelope = np.where((phase < 1) & (word < 0.9), np.sin(np.pi * np.clip(phase, 0, 1)) ** 0.5, 0.0)
    signal = tone * envelope
    return (signal / np.abs(signal).max() * 0.5).astype(np.float32)


def level_db(samples: NDArray[np.float32]) -> float:
    return float(10 * np.log10(np.mean(samples.astype(np.float64) ** 2) + 1e-12))


def tone_db(samples: NDArray[np.float32], freq: float) -> float:
    spectrum = np.abs(np.fft.rfft(samples * np.hanning(len(samples)))) ** 2
    bin_ = int(round(freq * len(samples) / SAMPLE_RATE))
    return float(10 * np.log10(spectrum[bin_ - 2 : bin_ + 3].max() + 1e-12))


def with_hum(samples: NDArray[np.float32], hz: float) -> NDArray[np.float32]:
    t = np.arange(len(samples)) / SAMPLE_RATE
    return (samples + 0.02 * np.sin(2 * np.pi * hz * t) + 0.01 * np.sin(2 * np.pi * 2 * hz * t)).astype(np.float32)


def with_noise(samples: NDArray[np.float32], level: float = 0.02) -> NDArray[np.float32]:
    return (samples + RNG.standard_normal(len(samples)) * level).astype(np.float32)


def with_wind(samples: NDArray[np.float32]) -> NDArray[np.float32]:
    """Gusts of rumble below 100 Hz, loud next to the voice."""
    spectrum = np.fft.rfft(RNG.standard_normal(len(samples)))
    freqs = np.fft.rfftfreq(len(samples), 1 / SAMPLE_RATE)
    spectrum[freqs > 100] = 0
    rumble = np.fft.irfft(spectrum, n=len(samples))
    gusts = 0.5 + 0.5 * np.sin(2 * np.pi * 0.4 * np.arange(len(samples)) / SAMPLE_RATE)
    rumble = rumble / np.abs(rumble).max() * 0.6 * gusts
    return (samples + rumble).astype(np.float32)


def with_echo(samples: NDArray[np.float32], seconds: float = 0.6) -> NDArray[np.float32]:
    length = int(seconds * SAMPLE_RATE)
    response = np.exp(-np.arange(length) / SAMPLE_RATE * 6.9 / seconds) * RNG.standard_normal(length)
    response[0] = 30
    wet = np.convolve(samples, response)[: len(samples)]
    return (wet / np.abs(wet).max() * 0.5).astype(np.float32)


@pytest.fixture
def fixture_wav() -> bytes:
    """The fixture WAV the server would send: four seconds of voice with hum and noise."""
    return to_voice_wav(with_noise(with_hum(voice(4.0), 60)))


class FakeSession:
    """One DeepFilterNet3 graph: outputs of the right shapes, and a record of the frames it was given."""

    def __init__(self, name: str, gain: float = 0.0) -> None:
        self.name = name
        self.gain = gain
        self.frames: list[int] = []

    def run(self, names: list[str] | None, feed: dict[str, Any]) -> list[Any]:
        if self.name == "enc":
            frames = feed["feat_erb"].shape[2]
            self.frames.append(frames)
            assert feed["feat_erb"].shape == (1, 1, frames, NB_ERB)
            assert feed["feat_spec"].shape == (1, 2, frames, NB_DF)
            zeros = lambda *shape: np.zeros(shape, dtype=np.float32)  # noqa: E731
            return [
                zeros(1, 64, frames, 32),
                zeros(1, 64, frames, 16),
                zeros(1, 64, frames, 8),
                zeros(1, 64, frames, 8),
                zeros(1, frames, 512),
                zeros(1, 64, frames, NB_DF),
                zeros(1, frames, 1),
            ]
        frames = feed["emb"].shape[1]
        if self.name == "erb_dec":
            return [np.full((1, 1, frames, NB_ERB), self.gain, dtype=np.float32)]
        coefs = np.zeros((1, frames, NB_DF, DF_ORDER * 2), dtype=np.float32)
        # The identity filter: weight 1 on the frame itself (order index 2), scaled by the gain.
        coefs[..., 2 * 2] = self.gain
        return [coefs, np.zeros((1, frames, 1), dtype=np.float32)]


def fake_model(tmp_path: Path, gain: float = 0.0) -> VoiceCleanupModel:
    model = VoiceCleanupModel(VOICE_CLEANUP_MODEL_ALIAS, cache_dir=tmp_path)
    model.session = {name: FakeSession(name, gain) for name in ("enc", "erb_dec", "df_dec")}  # type: ignore[assignment]
    model.loaded = True
    return model


def audio_of(items: list[dict[str, Any]]) -> NDArray[np.float32]:
    return read_voice_wav(next(item for item in items if item["type"] == "audio")["wav"])


class TestManifestAndOptions:
    def test_routes_the_task_to_the_voice_model(self) -> None:
        assert get_model_class(VOICE_CLEANUP_MODEL_ALIAS, ModelType.AUDIO, ModelTask.VOICE_CLEANUP) is VoiceCleanupModel
        assert VoiceCleanupModel(VOICE_CLEANUP_MODEL_ALIAS).model_name == "deepfilternet3"

    def test_the_manifest_pins_the_three_graphs(self) -> None:
        source = get_voice_model_file(VOICE_CLEANUP_MODEL_ALIAS)
        assert source is not None and source.repo == "deepfilternet3"
        assert {path for path, _ in source.files} == {"audio/enc.onnx", "audio/erb_dec.onnx", "audio/df_dec.onnx"}
        assert all(len(digest) == 64 and int(digest, 16) >= 0 for _, digest in source.files)

    def test_options_are_a_closed_set(self) -> None:
        assert validate_options(ModelTask.VOICE_CLEANUP, ModelType.AUDIO, {"mode": "analyze"}) == {
            "mode": "analyze",
            "strength": "standard",
            "noises": [],
        }
        assert validate_options(
            ModelTask.VOICE_CLEANUP,
            ModelType.AUDIO,
            {"mode": "clean", "strength": "light", "noises": ["hum", "wind"], "humHz": 50},
        ) == {"mode": "clean", "strength": "light", "noises": ["hum", "wind"], "humHz": 50}
        for bad in (
            {"strength": "max"},
            {"noises": ["traffic"]},
            {"humHz": 55},
            {"mode": "clean", "gain": 3},
        ):
            with pytest.raises(ValidationError):
                validate_options(ModelTask.VOICE_CLEANUP, ModelType.AUDIO, bad)

    def test_strength_is_the_attenuation_limit(self) -> None:
        assert attenuation_limit("light", ["background"]) == 12.0
        assert attenuation_limit("standard", ["background"]) == 24.0
        assert attenuation_limit("standard", ["echo"]) == 30.0
        assert attenuation_limit("strong", ["echo"]) is None


class TestWav:
    def test_accepts_the_longest_window_the_server_sends(self) -> None:
        # Ten minutes and a second of handle each side, silent.
        assert voice_wav_frames(to_voice_wav(np.zeros(602 * SAMPLE_RATE, dtype=np.float32))) == 602 * SAMPLE_RATE
        with pytest.raises(VoiceAudioError, match="longer than"):
            voice_wav_frames(to_voice_wav(np.zeros(603 * SAMPLE_RATE, dtype=np.float32)))

    def test_reads_the_fixture(self, fixture_wav: bytes) -> None:
        assert voice_wav_frames(fixture_wav) == 4 * SAMPLE_RATE
        samples = read_voice_wav(fixture_wav)
        assert samples.dtype == np.float32 and len(samples) == 4 * SAMPLE_RATE

    def test_refuses_other_formats(self) -> None:
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(16_000)
            writer.writeframes(b"\0\0" * 1600)
        with pytest.raises(VoiceAudioError, match="48 kHz"):
            voice_wav_frames(buffer.getvalue())
        with pytest.raises(VoiceAudioError):
            voice_wav_frames(b"not a wav")


class TestSignal:
    def test_erb_bands_cover_every_bin_once(self) -> None:
        widths = erb_widths()
        assert len(widths) == NB_ERB and sum(widths) == FREQS and min(widths) >= 2
        assert widths == sorted(widths)

    def test_the_stft_reconstructs_exactly(self, fixture_wav: bytes) -> None:
        samples = read_voice_wav(fixture_wav)
        spectrum = stft(samples)
        assert spectrum.shape[1] == FREQS
        assert np.abs(istft(spectrum, len(samples)) - samples).max() < 1e-5

    def test_the_deep_filter_with_a_unit_weight_on_the_frame_is_the_identity(self) -> None:
        spectrum = (RNG.standard_normal((20, FREQS)) + 1j * RNG.standard_normal((20, FREQS))).astype(np.complex64)
        coefs = np.zeros((20, DF_ORDER, NB_DF, 2), dtype=np.float32)
        coefs[:, 2, :, 0] = 1
        assert np.allclose(deep_filter(spectrum, coefs), spectrum[:, :NB_DF], atol=1e-6)
        # A weight on the frame two ahead reads the future frame.
        coefs[:] = 0
        coefs[:, 4, :, 0] = 1
        assert np.allclose(deep_filter(spectrum, coefs)[:-2], spectrum[2:, :NB_DF], atol=1e-6)

    def test_notches_the_hum_and_keeps_the_voice(self) -> None:
        t = np.arange(4 * SAMPLE_RATE) / SAMPLE_RATE
        hum = np.sin(2 * np.pi * 50 * t).astype(np.float32)
        speech = np.sin(2 * np.pi * 330 * t).astype(np.float32)
        out = shape_low_end(hum + speech, 50.0, wind=False)
        assert tone_db(hum + speech, 50) - tone_db(out, 50) > 30
        assert abs(tone_db(hum + speech, 330) - tone_db(out, 330)) < 0.5

    def test_wind_gets_a_low_cut_below_the_voice(self) -> None:
        t = np.arange(4 * SAMPLE_RATE) / SAMPLE_RATE
        rumble = np.sin(2 * np.pi * 30 * t).astype(np.float32)
        speech = np.sin(2 * np.pi * 200 * t).astype(np.float32)
        out = shape_low_end(rumble + speech, None, wind=True)
        assert tone_db(rumble + speech, 30) - tone_db(out, 30) > 25
        assert abs(tone_db(rumble + speech, 200) - tone_db(out, 200)) < 0.5


class TestAnalysis:
    def test_finds_mains_hum_and_its_frequency(self) -> None:
        assert detect_hum(with_hum(voice(), 50)) == 50.0
        assert detect_hum(with_hum(voice(), 60)) == 60.0
        assert detect_hum(voice()) is None

    def test_a_clean_voice_has_nothing_to_remove(self) -> None:
        assert analyze_noise(voice()) == {"noises": [], "humHz": None}

    def test_finds_background_noise(self) -> None:
        assert "background" in analyze_noise(with_noise(voice()))["noises"]

    def test_finds_wind(self) -> None:
        assert "wind" in analyze_noise(with_wind(voice()))["noises"]

    def test_finds_room_echo(self) -> None:
        assert "echo" in analyze_noise(with_echo(voice()))["noises"]
        assert "echo" not in analyze_noise(with_noise(voice()))["noises"]

    def test_the_fixture(self, fixture_wav: bytes) -> None:
        found = analyze_noise(read_voice_wav(fixture_wav))
        assert found["humHz"] == 60.0 and {"hum", "background"} <= set(found["noises"])

    def test_silence_has_nothing_to_remove(self) -> None:
        assert analyze_noise(np.zeros(SAMPLE_RATE * 2, dtype=np.float32)) == {"noises": [], "humHz": None}


class TestStream:
    def test_analysis_is_one_item_and_needs_no_model(self, tmp_path: Path, fixture_wav: bytes) -> None:
        model = VoiceCleanupModel(VOICE_CLEANUP_MODEL_ALIAS, cache_dir=tmp_path)
        items = list(model.stream(read_voice_wav(fixture_wav), mode="analyze"))
        assert [item["type"] for item in items] == ["analysis"]
        assert items[0]["humHz"] == 60.0

    def test_streams_progress_then_the_cleaned_wav(self, tmp_path: Path, fixture_wav: bytes) -> None:
        model = fake_model(tmp_path, gain=1.0)
        samples = read_voice_wav(fixture_wav)
        items = list(model.stream(samples, mode="clean", strength="strong", noises=["background"]))
        kinds = [item["type"] for item in items]
        assert kinds[0] == "progress" and kinds[-1] == "audio" and set(kinds[:-1]) == {"progress"}
        assert items[-2]["done"] == items[-2]["total"]
        assert items[-1]["sampleRate"] == SAMPLE_RATE and items[-1]["seconds"] == 4.0
        out = audio_of(items)
        # A model that passes everything through gives back the sound unchanged.
        assert len(out) == len(samples) and np.abs(out - samples).max() < 1e-3

    def test_strength_keeps_that_much_of_the_noise(self, tmp_path: Path, fixture_wav: bytes) -> None:
        samples = read_voice_wav(fixture_wav)
        # A model that removes everything: what is left is what the strength keeps.
        for strength, expected in (("light", -12.0), ("standard", -24.0)):
            out = audio_of(list(fake_model(tmp_path, 0.0).stream(samples, strength=strength, noises=["background"])))
            assert level_db(out) - level_db(samples) == pytest.approx(expected, abs=0.5)
        out = audio_of(list(fake_model(tmp_path, 0.0).stream(samples, strength="strong", noises=["background"])))
        assert level_db(out) < -90

    def test_runs_the_model_in_thirty_second_runs(self, tmp_path: Path, mocker: MockerFixture) -> None:
        mocker.patch("frameleaf_ml.models.voice_cleanup.CHUNK_FRAMES", 100)
        model = fake_model(tmp_path, gain=1.0)
        samples = voice(2.0)
        out = audio_of(list(model.stream(samples, strength="strong", noises=["wind"])))
        assert len(out) == len(samples)
        frames = model.session["enc"].frames  # type: ignore[index]
        assert len(frames) == 3 and max(frames) <= 100 + 300 + 8

    def test_hum_alone_never_loads_the_model(self, tmp_path: Path, mocker: MockerFixture) -> None:
        model = VoiceCleanupModel(VOICE_CLEANUP_MODEL_ALIAS, cache_dir=tmp_path)
        load = mocker.patch.object(model, "load")
        samples = with_hum(voice(4.0), 50)
        out = audio_of(list(model.stream(samples, noises=["hum"], humHz=50)))
        load.assert_not_called()
        assert tone_db(samples, 50) - tone_db(out, 50) > 20

    def test_the_stream_is_lazy(self, tmp_path: Path) -> None:
        model = fake_model(tmp_path)
        stream = model.stream(voice(1.0), noises=["background"])
        assert model.session["enc"].frames == []  # type: ignore[index]
        next(stream)
        stream.close()
        assert model.session["enc"].frames == []  # type: ignore[index]

    def test_downloads_and_checks_every_pinned_file(self, tmp_path: Path, mocker: MockerFixture) -> None:
        sut = VoiceCleanupModel(VOICE_CLEANUP_MODEL_ALIAS, cache_dir=tmp_path)
        source = get_voice_model_file(VOICE_CLEANUP_MODEL_ALIAS)
        assert source is not None
        contents = {path: path.encode() for path, _ in source.files}
        pinned = {path: hashlib.sha256(data).hexdigest() for path, data in contents.items()}

        def fake_download(repo: str, **kwargs: Any) -> None:
            assert repo == "deepfilternet3" and kwargs == {"allow_patterns": ["audio/*"]}
            for path, data in contents.items():
                (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
                (tmp_path / path).write_bytes(data)

        mocker.patch(
            "frameleaf_ml.models.voice_cleanup.get_voice_model_file",
            return_value=source._replace(files=tuple(pinned.items())),
        )
        mocker.patch.object(sut, "_download_from_source", side_effect=fake_download)
        sut.download()
        assert all((tmp_path / path).is_file() for path in pinned)

    def test_rejects_and_removes_a_file_that_fails_its_checksum(self, tmp_path: Path, mocker: MockerFixture) -> None:
        sut = VoiceCleanupModel(VOICE_CLEANUP_MODEL_ALIAS, cache_dir=tmp_path)
        source = get_voice_model_file(VOICE_CLEANUP_MODEL_ALIAS)
        assert source is not None

        def fake_download(repo: str, **kwargs: Any) -> None:
            for path, _ in source.files:
                (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
                (tmp_path / path).write_bytes(b"other bytes")

        mocker.patch.object(sut, "_download_from_source", side_effect=fake_download)
        with pytest.raises(ModelUnavailableError, match="checksum"):
            sut.download()
        assert not sut.cached


@pytest.mark.skipif(not os.environ.get("FRAMELEAF_TEST_DEEPFILTERNET3_DIR"), reason="needs the pinned model files")
def test_the_real_model_cleans_noisy_voice(tmp_path: Path) -> None:
    import onnxruntime as ort

    directory = Path(os.environ["FRAMELEAF_TEST_DEEPFILTERNET3_DIR"])
    source = get_voice_model_file(VOICE_CLEANUP_MODEL_ALIAS)
    assert source is not None
    for path, digest in source.files:
        assert hashlib.sha256((directory / Path(path).name).read_bytes()).hexdigest() == digest
    model = VoiceCleanupModel(VOICE_CLEANUP_MODEL_ALIAS, cache_dir=tmp_path)
    model.session = {  # type: ignore[assignment]
        name: ort.InferenceSession(str(directory / f"{name}.onnx"), providers=["CPUExecutionProvider"])
        for name in ("enc", "erb_dec", "df_dec")
    }
    model.loaded = True
    clean = voice(4.0)
    noisy = with_noise(clean, 0.05)
    out = audio_of(list(model.stream(noisy, strength="strong", noises=["background"])))

    def snr(estimate: NDArray[np.float32]) -> float:
        return float(10 * np.log10(np.sum(clean**2) / np.sum((clean - estimate) ** 2)))

    assert snr(out) > snr(noisy) + 6


def entries(**options: Any) -> str:
    return json.dumps({"voice-cleanup": {"audio": {"modelName": VOICE_CLEANUP_MODEL_ALIAS, "options": options}}})


def lines(body: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in body.splitlines() if line]


class TestEndpoint:
    @pytest.fixture
    def served(self, tmp_path: Path, mocker: MockerFixture) -> VoiceCleanupModel:
        model = fake_model(tmp_path, gain=1.0)

        async def get(*args: Any, **kwargs: Any) -> VoiceCleanupModel:
            assert args[:3] == (VOICE_CLEANUP_MODEL_ALIAS, ModelType.AUDIO, ModelTask.VOICE_CLEANUP)
            return model

        mocker.patch("frameleaf_ml.main.model_cache.get", side_effect=get)
        return model

    def post(self, app: TestClient, wav: bytes, **options: Any) -> Any:
        return app.post(
            "http://localhost:3003/voice-cleanup",
            data={"entries": entries(**options)},
            files={"audio": ("audio.wav", wav, "audio/wav")},
        )

    def test_analysis(self, served: VoiceCleanupModel, deployed_app: TestClient, fixture_wav: bytes) -> None:
        response = self.post(deployed_app, fixture_wav, mode="analyze")
        assert response.status_code == 200
        body = lines(response.text)
        assert [item["type"] for item in body] == ["analysis", "done"]
        assert body[0]["humHz"] == 60.0 and "hum" in body[0]["noises"]

    def test_streams_progress_info_audio_and_done(
        self, served: VoiceCleanupModel, deployed_app: TestClient, fixture_wav: bytes
    ) -> None:
        response = self.post(deployed_app, fixture_wav, mode="clean", strength="standard", noises=["background"])
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        body = lines(response.text)
        assert body[0]["type"] == "progress" and body[-1] == {"type": "done"}
        assert next(item for item in body if item["type"] == "info") == {
            "type": "info",
            "sampleRate": SAMPLE_RATE,
            "seconds": 4.0,
        }
        wav = b"".join(base64.b64decode(item["data"]) for item in body if item["type"] == "audio")
        assert voice_wav_frames(wav) == 4 * SAMPLE_RATE

    def test_refuses_audio_that_is_not_48khz(self, served: VoiceCleanupModel, deployed_app: TestClient) -> None:
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as writer:
            writer.setnchannels(2)
            writer.setsampwidth(2)
            writer.setframerate(SAMPLE_RATE)
            writer.writeframes(b"\0\0\0\0" * 4800)
        assert self.post(deployed_app, buffer.getvalue(), mode="clean").status_code == 400

    def test_refuses_unknown_options(self, deployed_app: TestClient, fixture_wav: bytes) -> None:
        assert self.post(deployed_app, fixture_wav, mode="clean", denoise=True).status_code == 422

    def test_refuses_other_tasks(self, deployed_app: TestClient, fixture_wav: bytes) -> None:
        response = deployed_app.post(
            "http://localhost:3003/voice-cleanup",
            data={
                "entries": json.dumps(
                    {"music": {"audio": {"modelName": "frameleaf-music", "options": {"prompt": "x", "duration": 1}}}}
                )
            },
            files={"audio": ("audio.wav", fixture_wav, "audio/wav")},
        )
        assert response.status_code == 400

    def test_a_failure_after_the_stream_starts_is_an_error_line(
        self, served: VoiceCleanupModel, deployed_app: TestClient, fixture_wav: bytes, mocker: MockerFixture
    ) -> None:
        mocker.patch.object(served.session["enc"], "run", side_effect=RuntimeError("out of memory"))  # type: ignore[index]
        response = self.post(deployed_app, fixture_wav, mode="clean", noises=["background"])
        assert lines(response.text)[-1] == {"type": "error", "message": "Voice clean-up failed"}

    def test_hum_alone_never_needs_the_model(
        self, tmp_path: Path, mocker: MockerFixture, deployed_app: TestClient, fixture_wav: bytes
    ) -> None:
        sut = VoiceCleanupModel(VOICE_CLEANUP_MODEL_ALIAS, cache_dir=tmp_path)
        mocker.patch.object(sut, "_download", side_effect=ModelUnavailableError("not on the mirror"))

        async def get(*args: Any, **kwargs: Any) -> VoiceCleanupModel:
            return sut

        mocker.patch("frameleaf_ml.main.model_cache.get", side_effect=get)
        response = self.post(deployed_app, fixture_wav, mode="clean", noises=["hum"], humHz=60)
        assert response.status_code == 200
        assert lines(response.text)[-1] == {"type": "done"}

    def test_a_worker_without_the_model_answers_503(
        self, tmp_path: Path, mocker: MockerFixture, deployed_app: TestClient, fixture_wav: bytes
    ) -> None:
        sut = VoiceCleanupModel(VOICE_CLEANUP_MODEL_ALIAS, cache_dir=tmp_path)
        mocker.patch.object(sut, "_download", side_effect=ModelUnavailableError("not on the mirror"))

        async def get(*args: Any, **kwargs: Any) -> VoiceCleanupModel:
            return sut

        mocker.patch("frameleaf_ml.main.model_cache.get", side_effect=get)
        assert self.post(deployed_app, fixture_wav, mode="clean", noises=["background"]).status_code == 503
