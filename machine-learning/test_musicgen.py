"""Make a movie (FL-561): the `music` task with small fake ONNX sessions in place of MusicGen."""

import base64
import hashlib
import io
import json
import wave
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from pytest_mock import MockerFixture

from frameleaf_ml.models import get_model_class
from frameleaf_ml.models.base import ModelUnavailableError
from frameleaf_ml.models.constants import MUSIC_MODEL_ALIAS, get_music_model_file
from frameleaf_ml.models.musicgen import (
    CONTEXT_FRAMES,
    NUM_CODEBOOKS,
    PAD_TOKEN,
    MusicGenModel,
    delay_pattern,
    generation_steps,
    music_frames,
    music_windows,
    undelay,
)
from frameleaf_ml.schemas import ModelTask, ModelType, validate_options

SAMPLES_PER_FRAME = 640


class FakeDecoder:
    """The merged decoder's surface. Each step's logits favour one token per codebook, so the
    output is known; the cross-attention outputs of a cached run are placeholders, as in the export."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.step = 0

    def get_outputs(self) -> list[SimpleNamespace]:
        names = ["logits"]
        for layer in range(24):
            for side in ("decoder", "encoder"):
                names += [f"present.{layer}.{side}.key", f"present.{layer}.{side}.value"]
        return [SimpleNamespace(name=name) for name in names]

    def run(self, names: list[str], feed: dict[str, Any]) -> list[Any]:
        cached = bool(feed["use_cache_branch"][0])
        self.calls.append(
            {
                "cached": cached,
                "input_ids": feed["input_ids"].copy(),
                "encoder_past": feed["past_key_values.0.encoder.key"].shape,
            }
        )
        rows, length = feed["input_ids"].shape
        logits = np.full((rows, length, 2048), -10.0, dtype=np.float32)
        for row in range(rows):
            logits[row, -1, (self.step * 7 + row % NUM_CODEBOOKS) % 2048] = 50.0
        self.step += 1
        past = feed["past_key_values.0.decoder.key"].shape[2]
        out: list[Any] = [logits]
        for name in names[1:]:
            if ".encoder." in name:
                out.append(np.zeros((0 if cached else 2, 16, 3, 64), np.float32))
            else:
                out.append(np.zeros((2, 16, past + length, 64), np.float32))
        return out


class FakeText:
    def run(self, names: list[str], feed: dict[str, Any]) -> list[Any]:
        return [np.ones((1, feed["input_ids"].shape[1], 768), np.float32)]


class FakeEncodec:
    def __init__(self) -> None:
        self.codes: np.ndarray | None = None

    def run(self, names: list[str], feed: dict[str, Any]) -> list[Any]:
        self.codes = feed["audio_codes"]
        frames = self.codes.shape[-1]
        return [np.sin(np.arange(frames * SAMPLES_PER_FRAME, dtype=np.float32) / 10)[None, None, :] * 0.5]


@pytest.fixture
def fake_model(tmp_path: Path) -> MusicGenModel:
    model = MusicGenModel(MUSIC_MODEL_ALIAS, cache_dir=tmp_path)
    model.session = {  # type: ignore[assignment]
        "tokenizer": SimpleNamespace(encode=lambda text: SimpleNamespace(ids=[5, 6, 1])),
        "text": FakeText(),
        "decoder": FakeDecoder(),
        "encodec": FakeEncodec(),
    }
    model.loaded = True
    return model


def read_wav(data: bytes) -> tuple[int, int, int]:
    with wave.open(io.BytesIO(data), "rb") as reader:
        return reader.getframerate(), reader.getnchannels(), reader.getnframes()


class TestHelpers:
    def test_routes_the_music_task_to_musicgen(self) -> None:
        assert get_model_class(MUSIC_MODEL_ALIAS, ModelType.AUDIO, ModelTask.MUSIC) is MusicGenModel
        assert MusicGenModel(MUSIC_MODEL_ALIAS).model_name == "musicgen-small"

    def test_the_model_pins_every_file(self) -> None:
        source = get_music_model_file(MUSIC_MODEL_ALIAS)
        assert source is not None and source.repo == "musicgen-small"
        assert {path for path, _ in source.files} == {
            "audio/tokenizer.json",
            "audio/text_encoder.onnx",
            "audio/decoder_model_merged.onnx",
            "audio/encodec_decode.onnx",
        }
        assert all(len(digest) == 64 for _, digest in source.files)

    def test_options_are_a_closed_set(self) -> None:
        assert validate_options(ModelTask.MUSIC, ModelType.AUDIO, {"prompt": "calm piano", "duration": 30}) == {
            "prompt": "calm piano",
            "duration": 30.0,
            "seed": 0,
        }
        for bad in (
            {"prompt": "", "duration": 30},
            {"prompt": "x", "duration": 181},
            {"prompt": "x", "duration": 5, "voice": 1},
        ):
            with pytest.raises(ValidationError):
                validate_options(ModelTask.MUSIC, ModelType.AUDIO, bad)

    def test_windows_of_thirty_seconds_then_ten(self) -> None:
        assert music_frames(30) == 1500
        assert music_windows(1500) == [1500]
        assert music_windows(music_frames(45)) == [1500, 500, 250]
        assert sum(music_windows(music_frames(180))) == 9000
        assert generation_steps(1500) == 1503
        assert generation_steps(2250) == 1503 + 503 + 253

    def test_the_delay_pattern_staggers_each_codebook_by_one_step(self) -> None:
        context = np.arange(8, dtype=np.int64).reshape(NUM_CODEBOOKS, 2)
        pattern = delay_pattern(context, 3)
        assert pattern.shape == (NUM_CODEBOOKS, 7)
        assert list(pattern[0]) == [PAD_TOKEN, 0, 1, -1, PAD_TOKEN, PAD_TOKEN, PAD_TOKEN]
        assert list(pattern[3]) == [PAD_TOKEN, PAD_TOKEN, PAD_TOKEN, PAD_TOKEN, 6, 7, -1]
        filled = np.where(pattern >= 0, pattern, 99)
        assert undelay(filled, 3).tolist() == [[0, 1, 99], [2, 3, 99], [4, 5, 99], [6, 7, 99]]


class TestModel:
    def test_streams_progress_then_32khz_mono_audio(self, fake_model: MusicGenModel) -> None:
        items = list(fake_model.stream("calm piano", 2.0, seed=3))
        assert items[0] == {"type": "progress", "done": 0, "total": generation_steps(100)}
        assert items[-2] == {"type": "progress", "done": generation_steps(100), "total": generation_steps(100)}
        audio = items[-1]
        assert audio["type"] == "audio" and audio["seconds"] == 2.0
        assert read_wav(audio["wav"]) == (32_000, 1, 100 * SAMPLES_PER_FRAME)

    def test_guidance_doubles_the_batch_and_keeps_the_first_cross_attention(self, fake_model: MusicGenModel) -> None:
        list(fake_model.stream("calm piano", 0.2))
        calls = fake_model.session["decoder"].calls  # type: ignore[index]
        assert calls[0]["cached"] is False and all(call["cached"] for call in calls[1:])
        assert all(call["input_ids"].shape[0] == 2 * NUM_CODEBOOKS for call in calls)
        # the placeholder cross-attention outputs of cached runs are never fed back
        assert all(call["encoder_past"][0] == 2 for call in calls[1:])

    def test_longer_music_continues_from_the_last_twenty_seconds(self, fake_model: MusicGenModel) -> None:
        items = list(fake_model.stream("calm piano", 35.0))
        decoder: FakeDecoder = fake_model.session["decoder"]  # type: ignore[index]
        prefills = [call for call in decoder.calls if not call["cached"]]
        assert len(prefills) == 2
        # the second window starts with the start token and the 20 seconds of codes before it
        assert prefills[1]["input_ids"].shape[1] == 1 + CONTEXT_FRAMES
        codes = fake_model.session["encodec"].codes  # type: ignore[index]
        assert codes.shape == (1, 1, NUM_CODEBOOKS, 1750)
        assert np.array_equal(prefills[1]["input_ids"][0, 1:], codes[0, 0, 0, 1500 - CONTEXT_FRAMES : 1500])
        assert items[-1]["seconds"] == 35.0

    def test_the_stream_is_lazy(self, fake_model: MusicGenModel) -> None:
        stream = fake_model.stream("calm piano", 30.0)
        next(stream)
        next(stream)
        stream.close()
        assert len(fake_model.session["decoder"].calls) <= 26  # type: ignore[index]

    def test_downloads_and_checks_every_pinned_file(self, tmp_path: Path, mocker: MockerFixture) -> None:
        sut = MusicGenModel(MUSIC_MODEL_ALIAS, cache_dir=tmp_path)
        source = get_music_model_file(MUSIC_MODEL_ALIAS)
        assert source is not None
        contents = {path: path.encode() for path, _ in source.files}
        pinned = {path: hashlib.sha256(data).hexdigest() for path, data in contents.items()}

        def fake_download(repo: str, **kwargs: Any) -> None:
            assert repo == "musicgen-small" and kwargs == {"allow_patterns": ["audio/*"]}
            for path, data in contents.items():
                (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
                (tmp_path / path).write_bytes(data)

        mocker.patch(
            "frameleaf_ml.models.musicgen.get_music_model_file",
            return_value=source._replace(files=tuple(pinned.items())),
        )
        mocker.patch.object(sut, "_download_from_source", side_effect=fake_download)
        sut.download()
        assert all((tmp_path / path).is_file() for path in pinned)

    def test_rejects_and_removes_a_file_that_fails_its_checksum(self, tmp_path: Path, mocker: MockerFixture) -> None:
        sut = MusicGenModel(MUSIC_MODEL_ALIAS, cache_dir=tmp_path)
        source = get_music_model_file(MUSIC_MODEL_ALIAS)
        assert source is not None

        def fake_download(repo: str, **kwargs: Any) -> None:
            for path, _ in source.files:
                (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
                (tmp_path / path).write_bytes(b"other bytes")

        mocker.patch.object(sut, "_download_from_source", side_effect=fake_download)
        with pytest.raises(ModelUnavailableError, match="checksum"):
            sut.download()
        assert not sut.cached


def entries(**options: Any) -> str:
    return json.dumps({"music": {"audio": {"modelName": MUSIC_MODEL_ALIAS, "options": options}}})


def lines(body: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in body.splitlines() if line]


class TestEndpoint:
    @pytest.fixture
    def served(self, fake_model: MusicGenModel, mocker: MockerFixture) -> MusicGenModel:
        async def get(*args: Any, **kwargs: Any) -> MusicGenModel:
            assert args[:3] == (MUSIC_MODEL_ALIAS, ModelType.AUDIO, ModelTask.MUSIC)
            return fake_model

        mocker.patch("frameleaf_ml.main.model_cache.get", side_effect=get)
        return fake_model

    def test_streams_progress_info_audio_and_done(self, served: MusicGenModel, deployed_app: TestClient) -> None:
        response = deployed_app.post(
            "http://localhost:3003/music", data={"entries": entries(prompt="calm piano", duration=1.0, seed=4)}
        )
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        body = lines(response.text)
        kinds = [item["type"] for item in body]
        assert kinds[0] == "progress" and kinds[-1] == "done"
        info = next(item for item in body if item["type"] == "info")
        assert info == {"type": "info", "sampleRate": 32_000, "seconds": 1.0}
        wav = b"".join(base64.b64decode(item["data"]) for item in body if item["type"] == "audio")
        assert read_wav(wav) == (32_000, 1, 50 * SAMPLES_PER_FRAME)

    def test_refuses_unknown_options(self, deployed_app: TestClient) -> None:
        response = deployed_app.post(
            "http://localhost:3003/music", data={"entries": entries(prompt="x", duration=5, tempo=90)}
        )
        assert response.status_code == 422

    def test_refuses_other_tasks(self, deployed_app: TestClient) -> None:
        response = deployed_app.post(
            "http://localhost:3003/music",
            data={"entries": json.dumps({"inpaint": {"visual": {"modelName": "frameleaf-inpaint"}}})},
        )
        assert response.status_code == 400

    def test_a_failure_after_the_stream_starts_is_an_error_line(
        self, served: MusicGenModel, deployed_app: TestClient, mocker: MockerFixture
    ) -> None:
        mocker.patch.object(served.session["decoder"], "run", side_effect=RuntimeError("out of memory"))  # type: ignore[index]
        response = deployed_app.post("http://localhost:3003/music", data={"entries": entries(prompt="x", duration=1.0)})
        assert lines(response.text)[-1] == {"type": "error", "message": "Music generation failed"}

    def test_a_worker_without_the_model_answers_503(
        self, tmp_path: Path, mocker: MockerFixture, deployed_app: TestClient
    ) -> None:
        sut = MusicGenModel(MUSIC_MODEL_ALIAS, cache_dir=tmp_path)
        mocker.patch.object(sut, "_download", side_effect=ModelUnavailableError("not on the mirror"))

        async def get(*args: Any, **kwargs: Any) -> MusicGenModel:
            return sut

        mocker.patch("frameleaf_ml.main.model_cache.get", side_effect=get)
        response = deployed_app.post("http://localhost:3003/music", data={"entries": entries(prompt="x", duration=1.0)})
        assert response.status_code == 503
