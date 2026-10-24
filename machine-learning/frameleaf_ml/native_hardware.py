"""Portable, sanitized runtime facts for invalidating desktop qualification."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import platform
import shutil
import subprocess
from typing import Any

import onnxruntime as ort
import psutil


def fingerprint(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    ).hexdigest()


def snapshot(device_facts: dict[str, Any] | None = None) -> dict[str, Any]:
    from .native_device import validate_facts
    from .native_ort import current_policy

    policy = current_policy()
    if device_facts is None and policy is not None and policy.observer is not None:
        device_facts = policy.observer.facts()
    if device_facts is not None:
        validate_facts(device_facts)
    versions = {}
    for package in ("onnxruntime", "onnxruntime-gpu", "onnxruntime-openvino", "numpy", "Pillow", "tokenizers"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            pass
    gpus = []
    executable = shutil.which("nvidia-smi")
    if executable:
        try:
            result = subprocess.run(
                [executable, "--query-gpu=index,uuid,driver_version,memory.total", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=5,
                check=True,
            )
            if len(result.stdout) > 16_384:
                raise ValueError("native_gpu_report_too_large")
            for line in result.stdout.splitlines():
                index, identity, driver, memory = (part.strip() for part in line.split(","))
                gpus.append(
                    {
                        "index": index,
                        "identitySha256": hashlib.sha256(identity.encode()).hexdigest(),
                        "driver": driver,
                        "memoryBytes": int(memory) * 1024 * 1024,
                    }
                )
        except (OSError, ValueError, subprocess.SubprocessError):
            gpus = []
    stable = {
        "system": platform.system(),
        "release": platform.release(),
        "architecture": platform.machine(),
        "processor": platform.processor(),
        "python": platform.python_version(),
        "ort": ort.__version__,
        "packages": versions,
        "providers": sorted(ort.get_available_providers()),
        "gpus": gpus,
        "totalMemoryBytes": psutil.virtual_memory().total,
    }
    if device_facts is not None:
        stable["deviceEvidence"] = device_facts
    return {
        "fingerprint": fingerprint(stable),
        "facts": stable,
        "availableMemoryBytes": psutil.virtual_memory().available,
    }


def process_memory() -> tuple[int, int]:
    """Current RSS and OS lifetime peak for this process, in bytes; excludes GPU/child memory."""
    try:
        info = psutil.Process().memory_info()
        system = platform.system()
        if system == "Windows":
            peak = getattr(info, "peak_rss", None)
            if peak is None:
                peak = getattr(info, "peak_wset", None)
        elif system in {"Darwin", "Linux"}:
            import resource

            peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            if type(peak) is not int:
                raise ValueError("invalid_memory_measurement")
            if system == "Linux":
                peak *= 1024
        else:
            raise ValueError("unsupported_memory_measurement")
        if any(type(value) is not int or not 0 < value < 2**53 for value in (info.rss, peak)):
            raise ValueError("invalid_memory_measurement")
        return info.rss, max(info.rss, peak)
    except (ImportError, OSError, ValueError, psutil.Error) as error:
        raise ValueError("native_memory_measurement_unavailable") from error
