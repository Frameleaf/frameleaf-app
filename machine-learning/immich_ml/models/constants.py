from typing import NamedTuple

from immich_ml.config import clean_name
from immich_ml.schemas import ModelSource, ModelType

_OPENCLIP_MODELS = {
    "RN101__openai",
    "RN101__yfcc15m",
    "RN50__cc12m",
    "RN50__openai",
    "RN50__yfcc15m",
    "RN50x16__openai",
    "RN50x4__openai",
    "RN50x64__openai",
    "ViT-B-16-SigLIP-256__webli",
    "ViT-B-16-SigLIP-384__webli",
    "ViT-B-16-SigLIP-512__webli",
    "ViT-B-16-SigLIP-i18n-256__webli",
    "ViT-B-16-SigLIP__webli",
    "ViT-B-16-plus-240__laion400m_e31",
    "ViT-B-16-plus-240__laion400m_e32",
    "ViT-B-16__laion400m_e31",
    "ViT-B-16__laion400m_e32",
    "ViT-B-16__openai",
    "ViT-B-32__laion2b-s34b-b79k",
    "ViT-B-32__laion2b_e16",
    "ViT-B-32__laion400m_e31",
    "ViT-B-32__laion400m_e32",
    "ViT-B-32__openai",
    "ViT-H-14-378-quickgelu__dfn5b",
    "ViT-H-14-quickgelu__dfn5b",
    "ViT-H-14__laion2b-s32b-b79k",
    "ViT-L-14-336__openai",
    "ViT-L-14-quickgelu__dfn2b",
    "ViT-L-14__laion2b-s32b-b82k",
    "ViT-L-14__laion400m_e31",
    "ViT-L-14__laion400m_e32",
    "ViT-L-14__openai",
    "ViT-L-16-SigLIP-256__webli",
    "ViT-L-16-SigLIP-384__webli",
    "ViT-SO400M-14-SigLIP-384__webli",
    "ViT-g-14__laion2b-s12b-b42k",
    "XLM-Roberta-Base-ViT-B-32__laion5b_s13b_b90k",
    "XLM-Roberta-Large-ViT-H-14__frozen_laion5b_s13b_b90k",
    "nllb-clip-base-siglip__mrl",
    "nllb-clip-base-siglip__v1",
    "nllb-clip-large-siglip__mrl",
    "nllb-clip-large-siglip__v1",
    "ViT-B-16-SigLIP2__webli",
    "ViT-B-32-SigLIP2-256__webli",
    "ViT-L-16-SigLIP2-256__webli",
    "ViT-L-16-SigLIP2-384__webli",
    "ViT-L-16-SigLIP2-512__webli",
    "ViT-SO400M-14-SigLIP2-378__webli",
    "ViT-SO400M-14-SigLIP2__webli",
    "ViT-SO400M-16-SigLIP2-256__webli",
    "ViT-SO400M-16-SigLIP2-384__webli",
    "ViT-SO400M-16-SigLIP2-512__webli",
    "ViT-gopt-16-SigLIP2-256__webli",
    "ViT-gopt-16-SigLIP2-384__webli",
}


_MCLIP_MODELS = {
    "LABSE-Vit-L-14",
    "XLM-Roberta-Large-Vit-B-16Plus",
    "XLM-Roberta-Large-Vit-B-32",
    "XLM-Roberta-Large-Vit-L-14",
}


_INSIGHTFACE_MODELS = {
    "antelopev2",
    "buffalo_s",
    "buffalo_m",
    "buffalo_l",
}


class OcrModelFile(NamedTuple):
    """Where an OCR model file lives on the model source.

    `repo` is a repository under the model source organisation, and the file is
    `<detection|recognition>/model.onnx` in it. `sha256` pins the exact PP-OCRv5
    export (RapidOCR 3.8.0 ONNX), so a mirror that serves other bytes is rejected.
    """

    repo: str
    sha256: str


_OCR_DET_MOBILE = OcrModelFile("PP-OCRv5_mobile", "4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae")
_OCR_DET_SERVER = OcrModelFile("PP-OCRv5_server", "0f8846b1d4bba223a2a2f9d9b44022fbc22cc019051a602b41a7fda9667e4cad")
_OCR_REC_MOBILE = OcrModelFile("PP-OCRv5_mobile", "5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5")
_OCR_REC_SERVER = OcrModelFile("PP-OCRv5_server", "e09385400eaaaef34ceff54aeb7c4f0f1fe014c27fa8b9905d4709b65746562a")


def _ocr_lang(lang: str, sha256: str) -> tuple[OcrModelFile, OcrModelFile]:
    return _OCR_DET_MOBILE, OcrModelFile(f"{lang}__PP-OCRv5_mobile", sha256)


# The one place an OCR model name maps to its (detection, recognition) files on the model source.
# Language variants share the Chinese/English detector and only differ in the recogniser.
_PADDLE_MODELS: dict[str, tuple[OcrModelFile, OcrModelFile]] = {
    "PP-OCRv5_server": (_OCR_DET_SERVER, _OCR_REC_SERVER),
    "PP-OCRv5_mobile": (_OCR_DET_MOBILE, _OCR_REC_MOBILE),
    "CH__PP-OCRv5_server": (_OCR_DET_SERVER, _OCR_REC_SERVER),
    "CH__PP-OCRv5_mobile": (_OCR_DET_MOBILE, _OCR_REC_MOBILE),
    "EL__PP-OCRv5_mobile": _ocr_lang("EL", "b4368bccd557123c702b7549fee6cd1e94b581337d1c9b65310f109131542b7f"),
    "EN__PP-OCRv5_mobile": _ocr_lang("EN", "c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8"),
    "ESLAV__PP-OCRv5_mobile": _ocr_lang("ESLAV", "08705d6721849b1347d26187f15a5e362c431963a2a62bfff4feac578c489aab"),
    "KOREAN__PP-OCRv5_mobile": _ocr_lang("KOREAN", "cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b"),
    "LATIN__PP-OCRv5_mobile": _ocr_lang("LATIN", "b20bd37c168a570f583afbc8cd7925603890efbcdc000a59e22c269d160b5f5a"),
    "TH__PP-OCRv5_mobile": _ocr_lang("TH", "de541dd83161c241ff426f7ecfd602a0ba77d686cf3ab9a6c255ea82fd08006e"),
}


def get_ocr_model_file(model_name: str, model_type: ModelType) -> OcrModelFile:
    detection, recognition = _PADDLE_MODELS[clean_name(model_name)]
    return detection if model_type == ModelType.DETECTION else recognition


class InpaintModelFile(NamedTuple):
    """Where an inpainting model lives on the model source: `visual/model.onnx` in `frameleaf/<repo>`.

    `sha256` pins the exact export, so a mirror that serves other bytes is rejected.
    """

    repo: str
    sha256: str
    source: str


# Clean Up Remove fills (owner decision 2026-10-08): LaMa big-lama, Apache-2.0
# (https://github.com/advimman/lama), as the fp32 ONNX export by Carve
# (https://huggingface.co/Carve/LaMa-ONNX, lama_fp32.onnx at revision c3c0c9e468934d62e79c329e35d82dd09ff8c444).
# The Frameleaf model mirror serves that file unchanged as frameleaf/frameleaf-inpaint/visual/model.onnx.
_INPAINT_MODELS: dict[str, InpaintModelFile] = {
    "frameleaf-inpaint": InpaintModelFile(
        "frameleaf-inpaint",
        "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
        "Carve/LaMa-ONNX@c3c0c9e468934d62e79c329e35d82dd09ff8c444:lama_fp32.onnx",
    ),
}


def get_inpaint_model_file(model_name: str) -> InpaintModelFile | None:
    return _INPAINT_MODELS.get(clean_name(model_name))


SUPPORTED_PROVIDERS = [
    "CUDAExecutionProvider",
    "MIGraphXExecutionProvider",
    "OpenVINOExecutionProvider",
    "CoreMLExecutionProvider",
    "CPUExecutionProvider",
]

RKNN_SUPPORTED_SOCS = ["rk3566", "rk3568", "rk3576", "rk3588"]
RKNN_COREMASK_SUPPORTED_SOCS = ["rk3576", "rk3588"]


WEBLATE_TO_FLORES200 = {
    "af": "afr_Latn",
    "ar": "arb_Arab",
    "az": "azj_Latn",
    "be": "bel_Cyrl",
    "bg": "bul_Cyrl",
    "ca": "cat_Latn",
    "cs": "ces_Latn",
    "da": "dan_Latn",
    "de": "deu_Latn",
    "el": "ell_Grek",
    "en": "eng_Latn",
    "es": "spa_Latn",
    "et": "est_Latn",
    "fa": "pes_Arab",
    "fi": "fin_Latn",
    "fr": "fra_Latn",
    "he": "heb_Hebr",
    "hi": "hin_Deva",
    "hr": "hrv_Latn",
    "hu": "hun_Latn",
    "hy": "hye_Armn",
    "id": "ind_Latn",
    "it": "ita_Latn",
    "ja": "jpn_Hira",
    "kmr": "kmr_Latn",
    "ko": "kor_Hang",
    "lb": "ltz_Latn",
    "lt": "lit_Latn",
    "lv": "lav_Latn",
    "mfa": "zsm_Latn",
    "mk": "mkd_Cyrl",
    "mn": "khk_Cyrl",
    "mr": "mar_Deva",
    "ms": "zsm_Latn",
    "nb-NO": "nob_Latn",
    "nn": "nno_Latn",
    "nl": "nld_Latn",
    "pl": "pol_Latn",
    "pt-BR": "por_Latn",
    "pt": "por_Latn",
    "ro": "ron_Latn",
    "ru": "rus_Cyrl",
    "sk": "slk_Latn",
    "sl": "slv_Latn",
    "sr-Cyrl": "srp_Cyrl",
    "sv": "swe_Latn",
    "ta": "tam_Taml",
    "te": "tel_Telu",
    "th": "tha_Thai",
    "tr": "tur_Latn",
    "uk": "ukr_Cyrl",
    "ur": "urd_Arab",
    "vi": "vie_Latn",
    "zh-CN": "zho_Hans",
    "zh-Hans": "zho_Hans",
    "zh-TW": "zho_Hant",
}


def get_model_source(model_name: str) -> ModelSource | None:
    cleaned_name = clean_name(model_name)

    if cleaned_name in _INSIGHTFACE_MODELS:
        return ModelSource.INSIGHTFACE

    if cleaned_name in _MCLIP_MODELS:
        return ModelSource.MCLIP

    if cleaned_name in _OPENCLIP_MODELS:
        return ModelSource.OPENCLIP

    if cleaned_name in _PADDLE_MODELS:
        return ModelSource.PADDLE

    return None


class TranscribeModelFile(NamedTuple):
    """Where a Whisper model lives on the model source: the CTranslate2 conversion under `audio/` in
    `frameleaf/<repo>`.

    `files` pins every file by SHA-256, so a mirror that serves other bytes is rejected. `gpu` marks the
    model chosen when the worker has a CUDA GPU; the other is the CPU-friendly default.
    """

    repo: str
    files: tuple[tuple[str, str], ...]
    source: str
    gpu: bool


# The name the server asks for. The worker maps it to one of the models below (see transcribe.py).
TRANSCRIBE_MODEL_ALIAS = "frameleaf-transcribe"

# Studio captions (owner decision 2026-10-09): OpenAI Whisper (MIT, https://github.com/openai/whisper)
# as CTranslate2 conversions for faster-whisper. The Frameleaf model mirror serves each file unchanged
# under frameleaf/<repo>/audio/.
_TRANSCRIBE_MODELS: dict[str, TranscribeModelFile] = {
    "whisper-large-v3-turbo": TranscribeModelFile(
        "whisper-large-v3-turbo",
        (
            ("audio/model.bin", "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da"),
            ("audio/config.json", "b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e"),
            ("audio/preprocessor_config.json", "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711"),
            ("audio/tokenizer.json", "297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd"),
            ("audio/vocabulary.json", "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1"),
        ),
        "dropbox-dash/faster-whisper-large-v3-turbo@0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf",
        True,
    ),
    "whisper-small": TranscribeModelFile(
        "whisper-small",
        (
            ("audio/model.bin", "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671"),
            ("audio/config.json", "b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828"),
            ("audio/tokenizer.json", "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab"),
            ("audio/vocabulary.txt", "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913"),
        ),
        "Systran/faster-whisper-small@536b0662742c02347bc0e980a01041f333bce120",
        False,
    ),
}


def get_transcribe_model_file(model_name: str) -> TranscribeModelFile | None:
    return _TRANSCRIBE_MODELS.get(clean_name(model_name))


def default_transcribe_model(gpu: bool) -> str:
    return next(name for name, model in _TRANSCRIBE_MODELS.items() if model.gpu == gpu)
