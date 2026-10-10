"""Studio captions: the `transcribe` task with a tiny fake Whisper model in place of faster-whisper."""

import hashlib
import io
import json
import wave
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator, cast

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from pytest_mock import MockerFixture

from immich_ml.config import settings
from immich_ml.models import get_model_class
from immich_ml.models.base import ModelUnavailableError
from immich_ml.models.constants import TRANSCRIBE_MODEL_ALIAS, get_transcribe_model_file
from immich_ml.models.transcribe import AudioFormatError, TranscribeModel, read_wav, resolve_transcribe_model
from immich_ml.schemas import ModelTask, ModelType, validate_options


def wav(seconds: float = 1.0, rate: int = 16_000, channels: int = 1, width: int = 2) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(width)
        writer.setframerate(rate)
        frames = int(seconds * rate)
        tone = (np.sin(np.arange(frames * channels) / 10) * 8000).astype("<i2")
        writer.writeframes(tone.tobytes() if width == 2 else bytes(frames * channels * width))
    return buffer.getvalue()


class FakeWhisper:
    """faster-whisper's WhisperModel surface: `transcribe` answers lazy segments and the info."""

    supported_languages = ["en", "de", "yue"]

    def __init__(self, segments: list[tuple[float, float, str]], language: str = "en") -> None:
        self.segments = segments
        self.language = language
        self.calls: list[dict[str, Any]] = []
        self.decoded = 0

    def transcribe(self, audio: np.ndarray, **kwargs: Any) -> tuple[Iterator[Any], Any]:
        self.calls.append({"samples": len(audio), **kwargs})

        def generate() -> Iterator[Any]:
            for start, end, text in self.segments:
                self.decoded += 1
                words = [
                    SimpleNamespace(start=start + i * 0.25, end=start + (i + 1) * 0.25, word=f" {w}", probability=0.9)
                    for i, w in enumerate(text.split())
                ]
                yield SimpleNamespace(start=start, end=end, text=f" {text}", words=words)

        language = kwargs.get("language") or self.language
        return generate(), SimpleNamespace(
            language=language, language_probability=0.987654, duration=len(audio) / 16000
        )


def fake(model: TranscribeModel) -> FakeWhisper:
    return cast(FakeWhisper, model.session)


@pytest.fixture
def fake_model(tmp_path: Path) -> TranscribeModel:
    model = TranscribeModel("whisper-small", cache_dir=tmp_path)
    whisper = FakeWhisper([(0.0, 1.5, "hello there world"), (2.0, 3.25, "second line")])
    model.session = whisper  # type: ignore[assignment]
    model.loaded = True
    return model


class TestModel:
    def test_routes_the_transcribe_task_to_whisper(self) -> None:
        assert get_model_class(TRANSCRIBE_MODEL_ALIAS, ModelType.AUDIO, ModelTask.TRANSCRIBE) is TranscribeModel

    def test_both_models_pin_every_file(self) -> None:
        for name, gpu in (("whisper-large-v3-turbo", True), ("whisper-small", False)):
            source = get_transcribe_model_file(name)
            assert source is not None and source.gpu is gpu and source.repo == name
            assert "audio/model.bin" in dict(source.files)
            assert all(path.startswith("audio/") and len(sha) == 64 for path, sha in source.files)

    def test_the_alias_picks_turbo_on_a_gpu_and_small_on_a_cpu(self, mocker: MockerFixture) -> None:
        mocker.patch.object(settings, "transcription_model", None)
        mocker.patch("immich_ml.models.transcribe.cuda_device_count", return_value=1)
        assert resolve_transcribe_model(TRANSCRIBE_MODEL_ALIAS) == "whisper-large-v3-turbo"
        mocker.patch("immich_ml.models.transcribe.cuda_device_count", return_value=0)
        assert resolve_transcribe_model(TRANSCRIBE_MODEL_ALIAS) == "whisper-small"
        mocker.patch.object(settings, "transcription_model", "whisper-large-v3-turbo")
        assert resolve_transcribe_model(TRANSCRIBE_MODEL_ALIAS) == "whisper-large-v3-turbo"
        assert resolve_transcribe_model("whisper-small") == "whisper-small"

    def test_options_are_a_closed_set(self) -> None:
        assert validate_options(ModelTask.TRANSCRIBE, ModelType.AUDIO, {"language": "en", "wordTimestamps": False}) == {
            "language": "en",
            "wordTimestamps": False,
        }
        for bad in ({"language": "en-US"}, {"temperature": 0.2}, {"language": "../x"}):
            with pytest.raises(ValidationError):
                validate_options(ModelTask.TRANSCRIBE, ModelType.AUDIO, bad)

    def test_streams_info_then_segments_with_words(self, fake_model: TranscribeModel) -> None:
        items = list(fake_model.stream(np.zeros(16000 * 4, dtype=np.float32), language=None))
        assert items[0] == {
            "type": "info",
            "model": "whisper-small",
            "language": "en",
            "languageProbability": 0.9877,
            "duration": 4.0,
        }
        assert items[1]["text"] == "hello there world"
        assert [w["text"] for w in items[1]["words"]] == [" hello", " there", " world"]
        assert items[2] == {
            "type": "segment",
            "start": 2.0,
            "end": 3.25,
            "text": "second line",
            "words": [
                {"start": 2.0, "end": 2.25, "text": " second"},
                {"start": 2.25, "end": 2.5, "text": " line"},
            ],
        }
        call = fake(fake_model).calls[0]
        assert call["word_timestamps"] is True and call["vad_filter"] is True and call["language"] is None

    def test_decoding_is_lazy(self, fake_model: TranscribeModel) -> None:
        items = fake_model.stream(np.zeros(16000, dtype=np.float32))
        next(items)
        next(items)
        items.close()
        assert fake(fake_model).decoded == 1

    def test_predict_collects_the_stream(self, fake_model: TranscribeModel) -> None:
        result = fake_model.predict(np.zeros(16000, dtype=np.float32), language="de")
        assert result["language"] == "de" and len(result["segments"]) == 2

    def test_reads_only_16khz_mono_pcm(self) -> None:
        samples = read_wav(wav(0.5))
        assert samples.dtype == np.float32 and samples.size == 8000 and np.abs(samples).max() <= 1.0
        for bad in (wav(0.5, rate=44_100), wav(0.5, channels=2), b"not a wav", wav(0)):
            with pytest.raises(AudioFormatError):
                read_wav(bad)

    def test_downloads_and_checks_every_pinned_file(self, tmp_path: Path, mocker: MockerFixture) -> None:
        sut = TranscribeModel("whisper-small", cache_dir=tmp_path)
        source = get_transcribe_model_file("whisper-small")
        assert source is not None
        contents = {path: path.encode() for path, _ in source.files}
        pinned = {path: hashlib.sha256(data).hexdigest() for path, data in contents.items()}

        def fake_download(repo: str, **kwargs: Any) -> None:
            assert repo == "whisper-small" and kwargs == {"allow_patterns": ["audio/*"]}
            for path, data in contents.items():
                (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
                (tmp_path / path).write_bytes(data)

        mocker.patch(
            "immich_ml.models.transcribe.get_transcribe_model_file",
            return_value=source._replace(files=tuple(pinned.items())),
        )
        mocker.patch.object(sut, "_download_from_source", side_effect=fake_download)
        sut.download()
        assert all((tmp_path / path).is_file() for path in pinned)

    def test_rejects_and_removes_a_file_that_fails_its_checksum(self, tmp_path: Path, mocker: MockerFixture) -> None:
        sut = TranscribeModel("whisper-small", cache_dir=tmp_path)
        source = get_transcribe_model_file("whisper-small")
        assert source is not None

        def fake_download(repo: str, **kwargs: Any) -> None:
            for path, _ in source.files:
                (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
                (tmp_path / path).write_bytes(b"other bytes")

        mocker.patch.object(sut, "_download_from_source", side_effect=fake_download)
        with pytest.raises(ModelUnavailableError, match="checksum"):
            sut.download()
        assert not sut.cached

    def test_an_unknown_model_name_is_unavailable(self, tmp_path: Path, mocker: MockerFixture) -> None:
        sut = TranscribeModel("whisper-enormous", cache_dir=tmp_path)
        download = mocker.patch.object(sut, "_download_from_source")
        with pytest.raises(ModelUnavailableError, match="not a transcription model"):
            sut.download()
        download.assert_not_called()


def entries(**options: Any) -> str:
    return json.dumps({"transcribe": {"audio": {"modelName": TRANSCRIBE_MODEL_ALIAS, "options": options}}})


def lines(body: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in body.splitlines() if line]


class TestEndpoint:
    @pytest.fixture
    def served(self, fake_model: TranscribeModel, mocker: MockerFixture) -> TranscribeModel:
        async def get(*args: Any, **kwargs: Any) -> TranscribeModel:
            assert args[:3] == (TRANSCRIBE_MODEL_ALIAS, ModelType.AUDIO, ModelTask.TRANSCRIBE)
            return fake_model

        mocker.patch("immich_ml.main.model_cache.get", side_effect=get)
        return fake_model

    def test_streams_ndjson(self, served: TranscribeModel, deployed_app: TestClient) -> None:
        response = deployed_app.post(
            "http://localhost:3003/transcribe",
            data={"entries": entries(language="en")},
            files={"audio": wav(4.0)},
        )
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        body = lines(response.text)
        assert [item["type"] for item in body] == ["info", "segment", "segment", "done"]
        assert body[0]["language"] == "en" and body[0]["model"] == "whisper-small"
        assert fake(served).calls[0]["samples"] == 64_000

    def test_refuses_audio_that_is_not_16khz_mono_pcm(self, served: TranscribeModel, deployed_app: TestClient) -> None:
        response = deployed_app.post(
            "http://localhost:3003/transcribe", data={"entries": entries()}, files={"audio": wav(1.0, rate=48_000)}
        )
        assert response.status_code == 400

    def test_refuses_a_language_whisper_does_not_know(self, served: TranscribeModel, deployed_app: TestClient) -> None:
        response = deployed_app.post(
            "http://localhost:3003/transcribe", data={"entries": entries(language="xx")}, files={"audio": wav(1.0)}
        )
        assert response.status_code == 400

    def test_refuses_unknown_options(self, deployed_app: TestClient) -> None:
        response = deployed_app.post(
            "http://localhost:3003/transcribe", data={"entries": entries(beam=9)}, files={"audio": wav(1.0)}
        )
        assert response.status_code == 422

    def test_refuses_other_tasks(self, deployed_app: TestClient) -> None:
        response = deployed_app.post(
            "http://localhost:3003/transcribe",
            data={"entries": json.dumps({"inpaint": {"visual": {"modelName": "frameleaf-inpaint"}}})},
            files={"audio": wav(1.0)},
        )
        assert response.status_code == 400

    def test_a_failure_after_the_stream_starts_is_an_error_line(
        self, served: TranscribeModel, deployed_app: TestClient, mocker: MockerFixture
    ) -> None:
        def broken(audio: np.ndarray, **kwargs: Any) -> tuple[Iterator[Any], Any]:
            def generate() -> Iterator[Any]:
                raise RuntimeError("CUDA out of memory")
                yield  # pragma: no cover

            return generate(), SimpleNamespace(language="en", language_probability=1.0, duration=1.0)

        mocker.patch.object(served.session, "transcribe", side_effect=broken)
        response = deployed_app.post(
            "http://localhost:3003/transcribe", data={"entries": entries()}, files={"audio": wav(1.0)}
        )
        body = lines(response.text)
        assert body[-1] == {"type": "error", "message": "Transcription failed"}

    def test_a_worker_without_the_model_answers_503(
        self, tmp_path: Path, mocker: MockerFixture, deployed_app: TestClient
    ) -> None:
        sut = TranscribeModel("whisper-small", cache_dir=tmp_path)
        mocker.patch.object(sut, "_download", side_effect=ModelUnavailableError("not on the mirror"))

        async def get(*args: Any, **kwargs: Any) -> TranscribeModel:
            return sut

        mocker.patch("immich_ml.main.model_cache.get", side_effect=get)
        response = deployed_app.post(
            "http://localhost:3003/transcribe", data={"entries": entries()}, files={"audio": wav(1.0)}
        )
        assert response.status_code == 503
