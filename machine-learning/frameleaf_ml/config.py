import concurrent.futures
import logging
import os
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict
from rich.console import Console
from rich.logging import RichHandler

from .env_aliases import apply_env_aliases
from .schemas import ModelPrecision

# FL-294: deprecated IMMICH_* names are copied to their FRAMELEAF_* names before any setting is read;
# a pair set to two different values stops the service here. __main__ logs the names in use once.
DEPRECATED_ENV = apply_env_aliases(os.environ)


class ClipSettings(BaseModel):
    textual: str | None = None
    visual: str | None = None


class FacialRecognitionSettings(BaseModel):
    recognition: str | None = None
    detection: str | None = None


class OcrSettings(BaseModel):
    recognition: str | None = None
    detection: str | None = None


class ImageDescriptionSettings(BaseModel):
    # Single visual VLM model for the image-description-tagging task.
    # When set, the model is downloaded and warmed into VRAM at container
    # boot — important for remote GPU workers with cold starts, where the model
    # download + load takes longer than the edge proxy's 30 s timeout.
    visual: str | None = None


class ImageDescriptionRuntimeSettings(BaseModel):
    # Pydantic-settings group for runtime tunables on the image-description path.
    # Cached module-level (read once on settings construction) so the value is
    # not re-parsed on every request — see ml.md Medium "Per-request env-var read
    # in OpenVINO image resize".
    openvino_max_image_edge: int = 512
    # Worker-admin consent only: API model selection must not authorize executable repository code.
    trusted_custom_models: list[str] = []


class PreloadModelData(BaseModel):
    clip: ClipSettings = ClipSettings()
    facial_recognition: FacialRecognitionSettings = FacialRecognitionSettings()
    ocr: OcrSettings = OcrSettings()
    image_description: ImageDescriptionSettings = ImageDescriptionSettings()


class MaxBatchSize(BaseModel):
    facial_recognition: int | None = None
    ocr: int | None = None


DEFAULT_MODEL_SOURCE_URL = "https://models.frameleaf.cloud"
HUGGING_FACE_HOST = "huggingface.co"


def default_worker_timeout() -> int:
    return 900 if os.environ.get("DEVICE") == "rocm" else 300


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MACHINE_LEARNING_",
        case_sensitive=False,
        env_nested_delimiter="__",
        protected_namespaces=("settings_",),
    )

    cache_folder: Path = (Path.home() / ".cache" / "frameleaf_ml").resolve()
    # Online standalone/remote workers keep their existing download workflow.
    model_downloads: bool = True
    # Hub-compatible host serving the frameleaf/<model> repositories. Unset means
    # HF_ENDPOINT if that is set, otherwise the Frameleaf mirror (see model_source()).
    model_source_url: str | None = None
    # Token for a custom model source that needs authentication. Never logged.
    model_source_token: SecretStr | None = None
    model_ttl: int = 300
    model_ttl_poll_s: int = 10
    workers: int = 1
    worker_timeout: int = Field(default_factory=default_worker_timeout)
    http_keepalive_timeout_s: int = 2
    test_full: bool = False
    request_threads: int = os.cpu_count() or 4
    model_inter_op_threads: int = 0
    model_intra_op_threads: int = 0
    model_arena: bool = True
    ann: bool = True
    ann_fp16_turbo: bool = False
    ann_tuning_level: int = 2
    rknn: bool = True
    rknn_threads: int = 1
    preload: PreloadModelData | None = None
    max_batch_size: MaxBatchSize | None = None
    image_description: ImageDescriptionRuntimeSettings = ImageDescriptionRuntimeSettings()
    # Opt in after qualifying the local CUDA runtime; auto retains a CPU-only host fallback.
    semantic_mask_device: Literal["cpu", "cuda", "auto"] = "cpu"
    # Studio captions: the Whisper model `frameleaf-transcribe` stands for. Unset picks
    # whisper-large-v3-turbo on a CUDA GPU and whisper-small otherwise (models/constants.py).
    transcription_model: str | None = None
    # PCM plus normalized samples; one four-hour clip needs 1,382,400,000 bytes, excluding model/runtime memory.
    transcription_max_memory_mb: int = Field(default=1536, gt=0)
    openvino_precision: ModelPrecision = ModelPrecision.FP32
    rocm_precision: ModelPrecision = ModelPrecision.FP32

    @property
    def device_id(self) -> str:
        return os.environ.get("MACHINE_LEARNING_DEVICE_ID", "0")


class NonPrefixedSettings(BaseSettings):
    model_config = SettingsConfigDict(case_sensitive=False)

    frameleaf_host: str = "[::]"
    frameleaf_port: int = 3003
    frameleaf_log_level: str = "info"
    no_color: bool = False


def model_source() -> tuple[str, str]:
    """The model source URL and the setting it came from.

    Precedence: MACHINE_LEARNING_MODEL_SOURCE_URL, then HF_ENDPOINT (an admin who
    already chose a Hub mirror keeps it), then the Frameleaf model mirror.
    """
    if settings.model_source_url and settings.model_source_url.strip():
        return settings.model_source_url.strip().rstrip("/"), "MACHINE_LEARNING_MODEL_SOURCE_URL"
    hf_endpoint = os.environ.get("HF_ENDPOINT", "").strip()
    if hf_endpoint:
        return hf_endpoint.rstrip("/"), "HF_ENDPOINT"
    return DEFAULT_MODEL_SOURCE_URL, "default"


def model_source_url() -> str:
    return model_source()[0]


def model_repository_url() -> str:
    """Repository models retain their public Hub default and explicit source overrides."""
    endpoint, setting = model_source()
    return "https://huggingface.co" if setting == "default" else endpoint


def model_source_token(endpoint: str | None = None) -> str | bool:
    """The token argument for downloads from the model source.

    Public downloads never inherit HF_TOKEN or a saved login. An intentional
    private source requires an explicit token, bound to its exact HTTPS origin.
    """
    source = urlsplit(model_source_url())
    destination = urlsplit(endpoint or model_source_url())
    if (
        source.scheme == destination.scheme == "https"
        and source.hostname == destination.hostname
        and (source.port or 443) == (destination.port or 443)
        and settings.model_source_token is not None
        and settings.model_source_token.get_secret_value()
    ):
        return settings.model_source_token.get_secret_value()
    return False


_clean_name = str.maketrans(":\\/", "___", ".")


def clean_name(model_name: str) -> str:
    return model_name.split("/")[-1].translate(_clean_name)


LOG_LEVELS: dict[str, int] = {
    "critical": logging.ERROR,
    "error": logging.ERROR,
    "warning": logging.WARNING,
    "warn": logging.WARNING,
    "info": logging.INFO,
    "log": logging.INFO,
    "debug": logging.DEBUG,
    "verbose": logging.DEBUG,
}

settings = Settings()
non_prefixed_settings = NonPrefixedSettings()

LOG_LEVEL = LOG_LEVELS.get(non_prefixed_settings.frameleaf_log_level.lower(), logging.INFO)


class CustomRichHandler(RichHandler):
    def __init__(self) -> None:
        console = Console(color_system="standard", no_color=non_prefixed_settings.no_color)
        self.excluded = ["uvicorn", "starlette", "fastapi"]
        super().__init__(
            show_path=False,
            omit_repeated_times=False,
            console=console,
            rich_tracebacks=True,
            tracebacks_suppress=[*self.excluded, concurrent.futures],
            tracebacks_show_locals=LOG_LEVEL == logging.DEBUG,
        )

    # hack to exclude certain modules from rich tracebacks
    def emit(self, record: logging.LogRecord) -> None:
        if record.exc_info is not None:
            tb = record.exc_info[2]
            while tb is not None:
                if any(excluded in tb.tb_frame.f_code.co_filename for excluded in self.excluded):
                    tb.tb_frame.f_locals["_rich_traceback_omit"] = True
                tb = tb.tb_next

        return super().emit(record)


log = logging.getLogger("ml.log")
log.setLevel(LOG_LEVEL)


def __getattr__(name: str) -> type:
    # Gunicorn resolves its configured worker by this legacy module path.
    if name in {"CustomUvicornServer", "CustomUvicornWorker"}:
        from . import gunicorn_worker

        return (
            gunicorn_worker.CustomUvicornServer
            if name == "CustomUvicornServer"
            else gunicorn_worker.CustomUvicornWorker
        )
    raise AttributeError(name)
