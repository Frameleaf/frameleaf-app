"""Explicit backend policy for a fresh, private desktop inference process."""

from __future__ import annotations

import sys
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


def load_device_libraries(provider: str) -> None:
    """Load the device libraries a desktop runtime carries as wheels beside onnxruntime.

    A container image has CUDA, cuDNN and OpenVINO where the system loader finds them. A desktop
    runtime has no system installation to rely on: its CUDA and cuDNN are the `nvidia-*` wheels,
    and on Windows its OpenVINO is the `openvino` wheel, neither of which is on the loader's path.
    """
    if provider == "CUDAExecutionProvider":
        preload = getattr(ort, "preload_dlls", None)
        if preload is not None:
            # "": the nvidia wheels, then the system's own paths; never another package's copies.
            preload(directory="")
    elif provider == "OpenVINOExecutionProvider" and sys.platform == "win32":
        try:
            from onnxruntime.tools.add_openvino_win_libs import add_openvino_libs_to_path

            add_openvino_libs_to_path()
        except (ImportError, SystemExit) as error:
            raise ValueError("native_provider_unavailable") from error


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
    load_device_libraries(provider)
    _policy = NativeOrtPolicy(provider, profile_dir, observer=observer)
    return _policy
