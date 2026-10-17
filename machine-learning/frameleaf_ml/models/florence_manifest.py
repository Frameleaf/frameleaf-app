"""Reviewed native Florence artifacts; downloaded manifests never change this trust root."""

import json
from pathlib import Path
from typing import Any

from frameleaf_ml.models.base import ModelUnavailableError
from frameleaf_ml.models.semantic_mask_manifest import verify_snapshot

FLORENCE_MODELS: dict[str, dict[str, Any]] = json.loads(Path(__file__).with_name("florence-models.json").read_text())


def florence_manifest(model_name: str) -> dict[str, Any] | None:
    for name, manifest in FLORENCE_MODELS.items():
        if model_name.lower() in {name.lower(), manifest["repository"].lower()}:
            return manifest
    return None


def verify_florence_snapshot(path: Path, manifest: dict[str, Any]) -> None:
    try:
        if path.is_symlink() or {entry.name for entry in path.iterdir()} - {".cache"} != set(manifest["files"]):
            raise ValueError("Unexpected artifact")
        if any((path / name).is_symlink() or not (path / name).is_file() for name in manifest["files"]):
            raise ValueError("Artifact is not a regular file")
        verify_snapshot(path, manifest["files"])
    except (OSError, ValueError):
        raise ModelUnavailableError(
            "Pinned Florence snapshot is absent or failed verification; "
            "clear this model's cache and stage its reviewed revision."
        ) from None
