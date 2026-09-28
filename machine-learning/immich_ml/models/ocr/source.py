import hashlib

from immich_ml.config import model_source_url
from immich_ml.models.base import MODEL_SOURCE_ORG, InferenceModel
from immich_ml.models.constants import get_ocr_model_file


def download_ocr_model(model: InferenceModel) -> None:
    """Fetch `<detection|recognition>/model.onnx` for an OCR model from the model source.

    OCR goes through the same Hub-compatible model source as every other Frameleaf
    model (MACHINE_LEARNING_MODEL_SOURCE_URL), never through RapidOCR's own downloader.
    """
    source = get_ocr_model_file(model.model_name, model.model_type)
    # `<type>/*` also brings an optional charset.txt for exports without embedded characters
    model._download_from_source(source.repo, allow_patterns=[f"{model.model_type.value}/*"])

    repo_id = f"{MODEL_SOURCE_ORG}/{source.repo}"
    if not model.model_path.is_file():
        raise model._unavailable(repo_id, model_source_url(), reason=f"has no {model.model_type.value}/model.onnx")

    digest = hashlib.sha256()
    with model.model_path.open("rb") as file:
        for chunk in iter(lambda: file.read(1 << 20), b""):
            digest.update(chunk)
    if digest.hexdigest() != source.sha256:
        model.model_path.unlink()
        raise model._unavailable(repo_id, model_source_url(), reason="failed its checksum")
