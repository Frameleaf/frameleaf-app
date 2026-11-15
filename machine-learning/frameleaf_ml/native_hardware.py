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


# Windows' software renderer is a DirectX adapter too; DirectML on it is the processor, not a GPU.
_SOFTWARE_ADAPTERS = ("Microsoft Basic Render Driver", "Microsoft Basic Display Adapter")


def directx_adapters() -> list[str]:
    """FL-1001: the hardware display adapters Windows lists, which DirectML can run on."""
    executable = shutil.which("powershell")
    if executable is None:
        return []
    try:
        result = subprocess.run(
            [executable, "-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController).Name"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    names = sorted({line.strip() for line in result.stdout.splitlines() if line.strip()} - set(_SOFTWARE_ADAPTERS))
    if len(names) > 16 or any(len(name) > 128 or not name.isascii() for name in names):
        raise ValueError("native_directx_adapter_report_invalid")
    return names


def snapshot(device_facts: dict[str, Any] | None = None) -> dict[str, Any]:
    from .native_device import validate_facts
    from .native_ort import current_policy

    policy = current_policy()
    if device_facts is None and policy is not None and policy.observer is not None:
        device_facts = policy.observer.facts()
    if device_facts is not None:
        validate_facts(device_facts)
    versions = {}
    packages = ("onnxruntime", "onnxruntime-gpu", "onnxruntime-openvino", "onnxruntime-directml", "numpy", "Pillow")
    for package in (*packages, "tokenizers"):
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
    if "OpenVINOExecutionProvider" in stable["providers"]:
        # What OpenVINO can run on here ("CPU", "GPU.0", "NPU"); only a graphics device is an accelerator.
        devices = sorted(str(device) for device in ort.capi._pybind_state.get_available_openvino_device_ids())
        if len(devices) > 16 or any(not 1 <= len(device) <= 64 or not device.isascii() for device in devices):
            raise ValueError("native_openvino_device_report_invalid")
        stable["openvinoDevices"] = devices
    if "DmlExecutionProvider" in stable["providers"]:
        stable["directxAdapters"] = directx_adapters()
    if device_facts is not None:
        stable["deviceEvidence"] = device_facts
    return {
        "fingerprint": fingerprint(stable),
        "facts": stable,
        "availableMemoryBytes": psutil.virtual_memory().available,
    }
