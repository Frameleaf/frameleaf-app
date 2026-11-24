"""Download-only model staging. Stop inference before replacing or rolling back its cache."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import threading
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from filelock import FileLock

from frameleaf_ml.config import settings
from frameleaf_ml.models import from_model_type
from frameleaf_ml.models.base import InferenceModel, ModelUnavailableError
from frameleaf_ml.schemas import ModelFormat, ModelTask, ModelType, validate_options

RECEIPT = ".frameleaf-staged.json"
# Compiled-provider caches `sessions/ort.py` writes beside a model file (`<type>/`, `onnx/`, ...) while downloads
# are on. They are not model files, and a bound request never reads them (it compiles into a private directory).
# No model repository ships a folder by these names.
RUNTIME_CACHES = {"coreml", "migraphx", "openvino", "trt-rtx"}


_StatKey = tuple[int, int, int, int, int]
_MAX_REMEMBERED_HASHES = 4096
_remembered: dict[Path, tuple[_StatKey, str]] = {}
_remembered_lock = threading.Lock()


def _stat_key(info: os.stat_result) -> _StatKey:
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def cache_hashes(cache: Path, *, reuse: bool = False) -> dict[str, str]:
    """Each regular file's SHA-256, by path relative to `cache`.

    With `reuse`, a hash taken earlier is kept while the file's device, inode, size, modification
    time and status-change time are all unchanged, as the restoration weight check does. Any write
    or replacement moves the status-change time, which no caller can set back, so it forces a fresh
    hash. Staging and qualification always hash afresh.
    """
    files = {}
    for path in sorted(cache.rglob("*")):
        info = path.lstat()
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            raise ModelUnavailableError("Model staging requires regular files, without symlinks")
        relative = path.relative_to(cache)
        if relative.parts[0] == ".cache" or relative.as_posix() == RECEIPT:
            continue
        if RUNTIME_CACHES.intersection(relative.parts[:-1]):
            continue
        key = _stat_key(info)
        if reuse:
            with _remembered_lock:
                remembered = _remembered.get(path)
            if remembered is not None and remembered[0] == key:
                files[relative.as_posix()] = remembered[1]
                continue
        with path.open("rb") as stream:
            opened = _stat_key(os.fstat(stream.fileno()))
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        files[relative.as_posix()] = digest
        # Remembered under what was opened, and only if it still matches after reading it.
        if opened == key == _stat_key(path.lstat()):
            with _remembered_lock:
                if len(_remembered) >= _MAX_REMEMBERED_HASHES:
                    _remembered.clear()
                _remembered[path] = (key, digest)
    return files


def verify_staged(cache: Path, *, reuse: bool = False) -> dict[str, str]:
    """Detect changes since acquisition; model-specific manifests remain the upstream trust roots."""
    try:
        receipt = cache / RECEIPT
        info = receipt.lstat()
        if cache.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_size > 4 * 1024 * 1024:
            raise ValueError("Invalid staging receipt")
        expected = json.loads(receipt.read_text())
        actual = cache_hashes(cache, reuse=reuse)
        if not expected or expected != actual:
            raise ValueError("Staged files changed")
        return actual
    except (OSError, ValueError) as error:
        raise ModelUnavailableError(
            "Model cache is absent, incomplete or changed; stop inference and run the model-staging command"
        ) from error


def stage_model(model: InferenceModel, *, refresh: bool = False, rollback: bool = False) -> None:
    active = model.cache_dir
    active.parent.mkdir(parents=True, exist_ok=True)
    previous = active.with_name(f".{active.name}.previous")
    with FileLock(str(active.with_name(f".{active.name}.staging.lock")), timeout=0):
        if active.is_symlink() or previous.is_symlink():
            raise ModelUnavailableError("Model staging does not replace cache symlinks")
        swap = active.with_name(f".{active.name}.rollback")
        if swap.exists() or swap.is_symlink():
            raise ModelUnavailableError("An interrupted rollback needs recovery before staging")
        if rollback:
            verify_staged(previous)
            had_active = active.exists()
            if had_active:
                active.rename(swap)
            try:
                previous.rename(active)
            except OSError:
                if had_active:
                    swap.rename(active)
                raise
            if had_active:
                swap.rename(previous)
            return
        if not refresh and model.cached and (active / RECEIPT).is_file():
            verify_staged(active)
            return
        with TemporaryDirectory(prefix=f".{active.name}.staging-", dir=active.parent) as temporary:
            candidate = Path(temporary) / "candidate"
            candidate.mkdir()
            if active.exists():
                cache_hashes(active)  # Reject links before preserving a legacy cache.
            model.cache_dir = candidate
            try:
                # An empty destination prevents Hub's offline fallback from accepting legacy files.
                model._download()
                if not model.cached:
                    raise ModelUnavailableError("Model staging did not produce a complete model")
                if active.exists():
                    try:
                        verify_staged(active)
                    except ModelUnavailableError:
                        pass
                    else:
                        other_types = {kind.value for kind in ModelType} - {model.model_type.value}
                        for relative in cache_hashes(active):
                            if Path(relative).parts[0] not in other_types:
                                continue
                            destination = candidate / relative
                            if not destination.exists():
                                destination.parent.mkdir(parents=True, exist_ok=True)
                                shutil.copy2(active / relative, destination)
                (candidate / RECEIPT).write_text(json.dumps(cache_hashes(candidate), sort_keys=True) + "\n")
                verify_staged(candidate)
            finally:
                model.cache_dir = active
            had_active = active.exists()
            backup = previous
            if had_active:
                try:
                    verify_staged(active)
                except ModelUnavailableError:
                    backup = active.with_name(f".{active.name}.unverified")
                    if backup.exists() or backup.is_symlink():
                        raise ModelUnavailableError("Preserve the existing unverified cache before staging again")
                if backup == previous and previous.exists():
                    verify_staged(previous)
                    shutil.rmtree(previous)
                active.rename(backup)
            try:
                os.replace(candidate, active)
            except OSError:
                if had_active:
                    backup.rename(active)
                raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--task", required=True, choices=list(ModelTask))
    parser.add_argument("--type", required=True, choices=list(ModelType))
    parser.add_argument("--model", required=True)
    parser.add_argument("--format", choices=list(ModelFormat))
    parser.add_argument("--options", default="{}", help="The same JSON options used by the inference task")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--refresh", action="store_true")
    action.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    task, model_type = ModelTask(args.task), ModelType(args.type)
    if task in (ModelTask.SEMANTIC_MASK, ModelTask.SUBJECT_MATTE):
        parser.error("Use scripts/provision-semantic-models.py for the pinned Florence/SAM snapshots")
    options: Any = json.loads(args.options)
    if not isinstance(options, dict):
        parser.error("--options must be a JSON object")
    kwargs = validate_options(task, model_type, options)
    if args.format:
        kwargs["model_format"] = ModelFormat(args.format)
    model = from_model_type(args.model, model_type, task, **kwargs)
    settings.model_downloads = True
    stage_model(model, refresh=args.refresh, rollback=args.rollback)
    print("Model staged; inference was not loaded or executed")


if __name__ == "__main__":
    main()
