import hashlib
from pathlib import Path
from tempfile import gettempdir

from immich_ml.config import settings


def runtime_cache_dir(model_path: Path) -> Path:
    if settings.model_downloads:
        return model_path.parent
    # The receipt includes external weights; the relative path separates models sharing a receipt.
    for parent in model_path.parents:
        receipt = parent / ".frameleaf-staged.json"
        if receipt.is_file():
            with receipt.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256")
            digest.update(model_path.relative_to(parent).as_posix().encode())
            break
    else:
        with model_path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256")
    cache = Path(gettempdir()) / "frameleaf-ml-runtime" / digest.hexdigest()
    cache.mkdir(parents=True, exist_ok=True)
    return cache
