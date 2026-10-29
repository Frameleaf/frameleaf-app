"""Studio captions in other languages (FL-641): M2M100 418M through CTranslate2, owner decision 2026-10-29.

The server sends a project's caption lines, as text only, and asks for `frameleaf-translate` from one
language into another. The model is the int8 CTranslate2 conversion of M2M100 418M (MIT), run by the
CTranslate2 runtime the worker already has for faster-whisper. Its files come from the model source
(`frameleaf/m2m100-418m/text/*`) and are pinned by SHA-256 in `translation-models.json`.

Lines keep their order and their count: line N of the answer is the translation of line N of the
request, so the caller keeps each line's timing. Blank lines stay blank.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, NamedTuple

from frameleaf_ml.config import log, model_source_url, settings
from frameleaf_ml.models.base import MODEL_SOURCE_ORG, InferenceModel, ModelUnavailableError
from frameleaf_ml.schemas import ModelFormat, ModelTask, ModelType

# The name the server asks for. The worker maps it to the pinned model below.
TRANSLATE_MODEL_ALIAS = "frameleaf-translate"

# The languages Studio offers (the ten app languages and English, FL-641), as the request names them
# (BCP 47 primary tags), mapped to M2M100's own codes. Norwegian Bokmål is `no` in M2M100.
TRANSLATION_LANGUAGES: dict[str, str] = {
    "en": "en",
    "fr": "fr",
    "es": "es",
    "de": "de",
    "it": "it",
    "pt": "pt",
    "nl": "nl",
    "pl": "pl",
    "sv": "sv",
    "da": "da",
    "nb": "no",
}

# Bounds of one request; the server refuses larger requests before sending them.
MAX_LINES = 2000
MAX_LINE_CHARS = 1000
# Lines are translated in small batches so a long project does not hold one huge batch in memory.
BATCH_LINES = 32


class TranslateModelFile(NamedTuple):
    """Where a translation model lives on the model source: CTranslate2 files under `text/` in
    `frameleaf/<repo>`, each pinned by SHA-256."""

    repo: str
    files: tuple[tuple[str, str], ...]
    source: str


def _load_manifest() -> dict[str, TranslateModelFile]:
    entries: list[dict[str, Any]] = json.loads(Path(__file__).with_name("translation-models.json").read_text())
    return {
        entry["name"]: TranslateModelFile(
            entry["name"],
            tuple(sorted(entry["files"].items())),
            f"{entry['repository']}@{entry['revision']}",
        )
        for entry in entries
    }


TRANSLATE_MODELS: dict[str, TranslateModelFile] = _load_manifest()
DEFAULT_TRANSLATE_MODEL = "m2m100-418m"


def resolve_translate_model(model_name: str) -> str:
    """The concrete model a request names; the alias is M2M100 418M."""
    name = model_name.strip().lower()
    return DEFAULT_TRANSLATE_MODEL if name == TRANSLATE_MODEL_ALIAS else name


def get_translate_model_file(model_name: str) -> TranslateModelFile | None:
    return TRANSLATE_MODELS.get(resolve_translate_model(model_name))


def m2m_language(tag: str) -> str:
    """M2M100's code for a language Studio offers; anything else is refused."""
    code = TRANSLATION_LANGUAGES.get(tag)
    if code is None:
        raise ValueError(f"Captions cannot be translated into or from '{tag}'")
    return code


def cuda_device_count() -> int:
    try:
        import ctranslate2

        return int(ctranslate2.get_cuda_device_count())
    except Exception:
        return 0


class TranslateModel(InferenceModel):
    depends = []
    identity = (ModelType.TEXTUAL, ModelTask.TRANSLATE)

    def __init__(self, model_name: str, **model_kwargs: Any) -> None:
        super().__init__(resolve_translate_model(model_name), **model_kwargs, model_format=ModelFormat.ONNX)

    @property
    def model_path(self) -> Path:
        return self.model_dir / "model.bin"

    @property
    def cached(self) -> bool:
        source = get_translate_model_file(self.model_name)
        return source is not None and all((self.cache_dir / path).is_file() for path, _ in source.files)

    def _download(self) -> None:
        source = get_translate_model_file(self.model_name)
        if source is None:
            # An unknown name is a missing model (503), never a generic download from the source.
            raise self._unavailable(
                f"{MODEL_SOURCE_ORG}/{self.model_name}", model_source_url(), "is not a translation model"
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
            import ctranslate2
            import sentencepiece
        except ImportError as error:
            raise ModelUnavailableError(
                "This worker has no translation runtime (CTranslate2, SentencePiece)"
            ) from error
        if cuda_device_count() > 0:
            device, compute_type = "cuda", "int8_float16"
        else:
            device, compute_type = "cpu", "int8"
        log.info(f"Loading translation model '{self.model_name}' on {device} ({compute_type})")
        translator = ctranslate2.Translator(
            str(self.model_dir),
            device=device,
            compute_type=compute_type,
            intra_threads=settings.model_intra_op_threads,
        )
        tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(self.model_dir / "sentencepiece.bpe.model"))
        return {"translator": translator, "tokenizer": tokenizer}

    def _predict(self, lines: list[str], source: str, target: str, **_: Any) -> dict[str, Any]:
        """One translation per line, in order. Blank lines stay blank and are not sent to the model."""
        if len(lines) > MAX_LINES:
            raise ValueError(f"At most {MAX_LINES} lines can be translated at once")
        if any(len(line) > MAX_LINE_CHARS for line in lines):
            raise ValueError(f"A line is longer than {MAX_LINE_CHARS} characters")
        source_code, target_code = m2m_language(source), m2m_language(target)
        self.load()
        session: Any = self.session
        translator, tokenizer = session["translator"], session["tokenizer"]
        results = [""] * len(lines)
        pending = [(index, line.strip()) for index, line in enumerate(lines) if line.strip()]
        if source_code == target_code:
            for index, text in pending:
                results[index] = text
            return {"model": self.model_name, "translations": results}
        for start in range(0, len(pending), BATCH_LINES):
            batch = pending[start : start + BATCH_LINES]
            tokens = [[f"__{source_code}__", *tokenizer.encode(text, out_type=str), "</s>"] for _index, text in batch]
            outputs = translator.translate_batch(
                tokens,
                target_prefix=[[f"__{target_code}__"]] * len(batch),
                beam_size=4,
                max_decoding_length=512,
            )
            for (index, _text), output in zip(batch, outputs):
                hypothesis = [token for token in output.hypotheses[0] if token != f"__{target_code}__"]
                results[index] = str(tokenizer.decode(hypothesis)).strip()
        return {"model": self.model_name, "translations": results}
