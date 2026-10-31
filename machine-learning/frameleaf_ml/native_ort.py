"""Explicit backend policy for a fresh, private desktop inference process."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

import onnxruntime as ort

if TYPE_CHECKING:
    from frameleaf_ml.native_device import DeviceObserver
    from frameleaf_ml.sessions.ort import OrtSession

PROVIDERS = (
    "CPUExecutionProvider",
    "CUDAExecutionProvider",
    "CoreMLExecutionProvider",
    "OpenVINOExecutionProvider",
    "MIGraphXExecutionProvider",
)


@dataclass
class NativeOrtPolicy:
    provider: str
    profile_dir: Path | None
    sessions: list[OrtSession] = field(default_factory=list)
    observer: DeviceObserver | None = None


_policy: NativeOrtPolicy | None = None


def current_policy() -> NativeOrtPolicy | None:
    return _policy


def configure(
    provider: str, profile_dir: Path | None = None, *, observer: DeviceObserver | None = None
) -> NativeOrtPolicy:
    global _policy
    if _policy is not None:
        raise RuntimeError("native_backend_requires_fresh_process")
    if provider not in PROVIDERS or provider not in ort.get_available_providers():
        raise ValueError("native_provider_unavailable")
    if observer is not None and (provider != "CoreMLExecutionProvider" or observer.provider != provider):
        raise ValueError("native_device_observer_invalid")
    if profile_dir is not None:
        if profile_dir.is_symlink():
            raise ValueError("native_profile_directory_invalid")
        profile_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    _policy = NativeOrtPolicy(provider, profile_dir, observer=observer)
    return _policy
