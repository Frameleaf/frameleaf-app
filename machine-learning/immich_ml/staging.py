"""Download-only model staging. Stop inference before replacing or rolling back its cache."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from filelock import FileLock

from immich_ml.config import settings
from immich_ml.models import from_model_type
from immich_ml.models.base import InferenceModel, ModelUnavailableError
from immich_ml.schemas import ModelFormat, ModelTask, ModelType, validate_options

RECEIPT = ".frameleaf-staged.json"


def cache_hashes(cache: Path) -> dict[str, str]:
    files = {}
    for path in sorted(cache.rglob("*")):
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            continue
        if not stat.S_ISREG(mode):
            raise ModelUnavailableError("Model staging requires regular files, without symlinks")
        relative = path.relative_to(cache)
        if relative.parts[0] == ".cache" or relative.as_posix() == RECEIPT:
            continue
        with path.open("rb") as stream:
            files[relative.as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
    return files


def verify_staged(cache: Path) -> None:
    """Detect changes since acquisition; model-specific manifests remain the upstream trust roots."""
    try:
        receipt = cache / RECEIPT
        info = receipt.lstat()
        if cache.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_size > 4 * 1024 * 1024:
            raise ValueError("Invalid staging receipt")
        expected = json.loads(receipt.read_text())
        if not expected or expected != cache_hashes(cache):
            raise ValueError("Staged files changed")
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
        if rollback:
            verify_staged(previous)
            swap = active.with_name(f".{active.name}.rollback")
            if swap.exists():
                raise ModelUnavailableError("An interrupted rollback needs recovery before staging")
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
            if active.exists():
                cache_hashes(active)  # Reject links before copying a legacy cache.
                shutil.copytree(active, candidate)
            else:
                candidate.mkdir()
            model.cache_dir = candidate
            try:
                # Acquire even when adopting a legacy cache; its existence is not origin verification.
                model._download()
                if not model.cached:
                    raise ModelUnavailableError("Model staging did not produce a complete model")
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
    if task == ModelTask.SEMANTIC_MASK:
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
