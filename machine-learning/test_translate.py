"""Studio captions in other languages (FL-641): the `translate` task with a fake CTranslate2 translator and
SentencePiece tokenizer in place of the M2M100 weights, which are not downloaded in unit tests."""

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from pytest_mock import MockerFixture

from frameleaf_ml.models import get_model_class
from frameleaf_ml.models.base import ModelUnavailableError
from frameleaf_ml.models.translate import (
    MAX_LINES,
    TRANSLATE_MODEL_ALIAS,
    TRANSLATE_MODELS,
    TRANSLATION_LANGUAGES,
    TranslateModel,
    get_translate_model_file,
    m2m_language,
    resolve_translate_model,
)
from frameleaf_ml.schemas import ModelTask, ModelType, validate_options


class FakeTokenizer:
    """Splits on spaces and joins back, like SentencePiece pieces without the word marks."""

    def encode(self, text: str, out_type: type = str) -> list[str]:
        return text.split(" ")

    def decode(self, pieces: list[str]) -> str:
        return " ".join(pieces)


class FakeTranslator:
    """Answers each source with its target prefix followed by the words reversed and upper-cased."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def translate_batch(self, tokens: list[list[str]], target_prefix: list[list[str]], **options: Any) -> list[Any]:
        self.calls.append({"tokens": tokens, "target_prefix": target_prefix, **options})
        results = []
        for source, prefix in zip(tokens, target_prefix):
            words = [word.upper() for word in reversed(source[1:-1])]
            results.append(SimpleNamespace(hypotheses=[[*prefix, *words]]))
        return results


def loaded_model(tmp_path: Path) -> tuple[TranslateModel, FakeTranslator]:
    model = TranslateModel(TRANSLATE_MODEL_ALIAS, cache_dir=tmp_path)
    translator = FakeTranslator()
    model.session = {"translator": translator, "tokenizer": FakeTokenizer()}
    model.loaded = True
    return model, translator


class TestManifest:
    def test_alias_names_the_pinned_m2m100(self) -> None:
        assert resolve_translate_model(TRANSLATE_MODEL_ALIAS) == "m2m100-418m"
        source = get_translate_model_file(TRANSLATE_MODEL_ALIAS)
        assert source is not None
        assert source.repo == "m2m100-418m"
        paths = {path for path, _ in source.files}
        assert paths == {
            "textual/model.bin",
            "textual/config.json",
            "textual/shared_vocabulary.json",
            "textual/sentencepiece.bpe.model",
        }
        assert all(len(digest) == 64 for _, digest in source.files)
        assert source.source.endswith("@7c1b2620a4e58dacecbd8bf89cfd6da7eb9eb7b0")

    def test_manifest_never_names_a_download_site(self) -> None:
        text = (Path(__file__).parent / "frameleaf_ml/models/translation-models.json").read_text().lower()
        assert "http" not in text
        assert "huggingface" not in text

    def test_unknown_model_is_none(self) -> None:
        assert get_translate_model_file("nllb-200") is None
        assert set(TRANSLATE_MODELS) == {"m2m100-418m"}

    def test_registered_as_its_own_task(self) -> None:
        assert get_model_class(TRANSLATE_MODEL_ALIAS, ModelType.TEXTUAL, ModelTask.TRANSLATE) is TranslateModel


class TestLanguages:
    def test_the_ten_app_languages_and_english(self) -> None:
        assert set(TRANSLATION_LANGUAGES) == {"en", "fr", "es", "de", "it", "pt", "nl", "pl", "sv", "da", "nb"}
        assert m2m_language("nb") == "no"
        assert m2m_language("pt") == "pt"

    def test_other_languages_are_refused(self) -> None:
        with pytest.raises(ValueError):
            m2m_language("ja")

    def test_options_are_declared(self) -> None:
        assert validate_options(ModelTask.TRANSLATE, ModelType.TEXTUAL, {"source": "en", "target": "fr"}) == {
            "source": "en",
            "target": "fr",
        }
        with pytest.raises(ValidationError):
            validate_options(ModelTask.TRANSLATE, ModelType.TEXTUAL, {"source": "en", "target": "fr", "beam": 9})
        with pytest.raises(ValidationError):
            validate_options(ModelTask.TRANSLATE, ModelType.TEXTUAL, {"source": "en"})
        with pytest.raises(ValidationError):
            validate_options(ModelTask.TRANSLATE, ModelType.TEXTUAL, {"source": "EN-us", "target": "fr"})


class TestPredict:
    def test_one_translation_per_line_in_order(self, tmp_path: Path) -> None:
        model, translator = loaded_model(tmp_path)
        result = model.predict(["hello there", "", "  good morning  "], source="en", target="fr")
        assert result == {"model": "m2m100-418m", "translations": ["THERE HELLO", "", "MORNING GOOD"]}
        # Blank lines never reach the model; the M2M100 source and target language tokens frame each line.
        assert translator.calls[0]["tokens"] == [
            ["__en__", "hello", "there", "</s>"],
            ["__en__", "good", "morning", "</s>"],
        ]
        assert translator.calls[0]["target_prefix"] == [["__fr__"], ["__fr__"]]

    def test_norwegian_uses_m2m100_code(self, tmp_path: Path) -> None:
        model, translator = loaded_model(tmp_path)
        model.predict(["hi"], source="en", target="nb")
        assert translator.calls[0]["target_prefix"] == [["__no__"]]

    def test_batches_long_projects(self, tmp_path: Path) -> None:
        model, translator = loaded_model(tmp_path)
        result = model.predict([f"line {n}" for n in range(70)], source="en", target="de")
        assert len(result["translations"]) == 70
        assert [len(call["tokens"]) for call in translator.calls] == [32, 32, 6]
        assert result["translations"][69] == "69 LINE"

    def test_same_language_copies_without_the_model(self, tmp_path: Path) -> None:
        model, translator = loaded_model(tmp_path)
        assert model.predict(["Hi "], source="en", target="en")["translations"] == ["Hi"]
        assert translator.calls == []

    def test_refuses_too_much(self, tmp_path: Path) -> None:
        model, _ = loaded_model(tmp_path)
        with pytest.raises(ValueError):
            model.predict(["x"] * (MAX_LINES + 1), source="en", target="fr")
        with pytest.raises(ValueError):
            model.predict(["x" * 1001], source="en", target="fr")
        with pytest.raises(ValueError):
            model.predict(["x"], source="en", target="ja")


class TestDownload:
    def test_checks_every_pinned_file(self, tmp_path: Path, mocker: MockerFixture) -> None:
        source = get_translate_model_file(TRANSLATE_MODEL_ALIAS)
        assert source is not None
        model = TranslateModel(TRANSLATE_MODEL_ALIAS, cache_dir=tmp_path)

        def fake_download(repo: str, **_: Any) -> None:
            for path, _digest in source.files:
                file = tmp_path / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(b"not the model")

        mocker.patch.object(model, "_download_from_source", side_effect=fake_download)
        with pytest.raises(ModelUnavailableError):
            model._download()
        # The first file that failed its checksum is removed so a later download fetches it again.
        assert not (tmp_path / sorted(source.files)[0][0]).exists()

    def test_accepts_files_that_match(self, tmp_path: Path, mocker: MockerFixture) -> None:
        model = TranslateModel(TRANSLATE_MODEL_ALIAS, cache_dir=tmp_path)
        contents = {"textual/model.bin": b"a", "textual/config.json": b"b"}
        fake = SimpleNamespace(
            repo="m2m100-418m",
            files=tuple((path, hashlib.sha256(data).hexdigest()) for path, data in contents.items()),
            source="x@y",
        )
        mocker.patch("frameleaf_ml.models.translate.get_translate_model_file", return_value=fake)

        def fake_download(repo: str, **_: Any) -> None:
            for path, data in contents.items():
                (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
                (tmp_path / path).write_bytes(data)

        mocker.patch.object(model, "_download_from_source", side_effect=fake_download)
        model._download()
        assert model.cached


class TestRoute:
    @pytest.fixture
    def client(self, mocker: MockerFixture, tmp_path: Path) -> TestClient:
        from frameleaf_ml import main

        model, _ = loaded_model(tmp_path)

        async def get(*_: Any, **__: Any) -> TranslateModel:
            return model

        mocker.patch.object(main.model_cache, "get", side_effect=get)
        return TestClient(main.app)

    def entries(self, **options: Any) -> str:
        return json.dumps({"translate": {"textual": {"modelName": TRANSLATE_MODEL_ALIAS, "options": options}}})

    def test_translates_lines(self, client: TestClient) -> None:
        response = client.post(
            "/translate",
            data={"entries": self.entries(source="en", target="es"), "lines": json.dumps(["see you soon", ""])},
        )
        assert response.status_code == 200
        assert response.json() == {"model": "m2m100-418m", "translations": ["SOON YOU SEE", ""]}

    def test_refuses_a_language_it_does_not_offer(self, client: TestClient) -> None:
        response = client.post(
            "/translate", data={"entries": self.entries(source="en", target="ja"), "lines": json.dumps(["hi"])}
        )
        assert response.status_code == 400

    def test_refuses_bad_lines(self, client: TestClient) -> None:
        for lines in ["not json", json.dumps({"a": 1}), json.dumps([1, 2]), json.dumps(["x"] * (MAX_LINES + 1))]:
            response = client.post(
                "/translate", data={"entries": self.entries(source="en", target="fr"), "lines": lines}
            )
            assert response.status_code == 400

    def test_refuses_undeclared_options(self, client: TestClient) -> None:
        response = client.post(
            "/translate",
            data={"entries": self.entries(source="en", target="fr", beam=9), "lines": json.dumps(["hi"])},
        )
        assert response.status_code == 422

    def test_needs_exactly_one_translate_entry(self, client: TestClient) -> None:
        entries = json.dumps({"transcribe": {"audio": {"modelName": "frameleaf-transcribe", "options": {}}}})
        response = client.post("/translate", data={"entries": entries, "lines": json.dumps(["hi"])})
        assert response.status_code == 400
