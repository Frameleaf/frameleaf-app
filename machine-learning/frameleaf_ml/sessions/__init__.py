import hashlib
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from tempfile import gettempdir

from frameleaf_ml.config import settings

_private_cache: ContextVar[Path | None] = ContextVar("private_model_runtime_cache", default=None)


@contextmanager
def private_runtime_cache(root: Path) -> Iterator[None]:
    token = _private_cache.set(root)
    try:
        yield
    finally:
        _private_cache.reset(token)


def runtime_cache_dir(model_path: Path) -> Path:
    if (root := _private_cache.get()) is not None:
        cache = root / hashlib.sha256(model_path.resolve().as_posix().encode()).hexdigest()
        cache.mkdir(parents=True, exist_ok=True)
        return cache
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
