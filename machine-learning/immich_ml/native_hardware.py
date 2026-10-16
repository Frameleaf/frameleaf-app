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


def snapshot() -> dict[str, Any]:
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
    return {
        "fingerprint": fingerprint(stable),
        "facts": stable,
        "availableMemoryBytes": psutil.virtual_memory().available,
    }
