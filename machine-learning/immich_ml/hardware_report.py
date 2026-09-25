"""What this container can actually use for AI work (Frameleaf FL-159, Hardware & GPU).

Reported by ``GET /hardware`` as ``container`` next to the provider list, so the server's
Hardware & GPU page can say which GPU the analysis container reaches, through which backend, and
why it does not when a card is on the host but not passed in. Everything is read inside the
container; nothing here guesses at the host.

Public contract — KEEP IN SYNC WITH ``server/src/repositories/machine-learning.repository.ts``
(``MlContainerHardware``).
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

PCI_VENDORS = {"0x10de": "NVIDIA", "0x1002": "AMD", "0x8086": "Intel"}


def _render_nodes(dev: Path = Path("/dev/dri"), sys_drm: Path = Path("/sys/class/drm")) -> list[dict[str, Any]]:
    """Render nodes passed into the container, with their vendor and whether they can be opened."""
    nodes: list[dict[str, Any]] = []
    if not dev.is_dir():
        return nodes
    for node in sorted(dev.glob("renderD*")):
        vendor_file = sys_drm / node.name / "device" / "vendor"
        vendor = None
        try:
            vendor = PCI_VENDORS.get(vendor_file.read_text().strip())
        except OSError:
            pass
        vram = None
        try:
            vram = int((sys_drm / node.name / "device" / "mem_info_vram_total").read_text().strip())
        except (OSError, ValueError):
            pass
        nodes.append(
            {
                "node": node.name,
                "vendor": vendor,
                "accessible": os.access(node, os.R_OK | os.W_OK),
                "memoryTotalBytes": vram,
            }
        )
    return nodes


def _nvidia_smi() -> dict[str, Any] | None:
    """Name, memory and driver of the first NVIDIA GPU, when nvidia-smi is in the image."""
    binary = shutil.which("nvidia-smi")
    if binary is None:
        return None
    try:
        output = subprocess.run(
            [binary, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    line = output.stdout.strip().splitlines()[0] if output.returncode == 0 and output.stdout.strip() else ""
    parts = [part.strip() for part in line.split(",")]
    if len(parts) != 3:
        return {"error": (output.stderr or output.stdout).strip()[:300] or None}
    try:
        memory = int(float(parts[1]) * 1024 * 1024)
    except ValueError:
        memory = None
    return {"name": parts[0], "memoryTotalBytes": memory, "driver": parts[2]}


def _torch_gpus() -> tuple[list[dict[str, Any]], str | None, str | None]:
    """GPUs torch can use, the runtime it was built for, and the backend ("CUDA" or "ROCm")."""
    try:
        import torch
    except ImportError:
        return [], None, None
    if not torch.cuda.is_available():
        return [], None, None
    hip = getattr(torch.version, "hip", None)
    gpus = []
    for index in range(torch.cuda.device_count()):
        properties = torch.cuda.get_device_properties(index)
        gpus.append(
            {
                "name": properties.name,
                "vendor": "AMD" if hip else "NVIDIA",
                "memoryTotalBytes": int(properties.total_memory),
            }
        )
    runtime = f"ROCm {hip}" if hip else (f"CUDA {torch.version.cuda}" if torch.version.cuda else None)
    return gpus, runtime, "ROCm" if hip else "CUDA"


def _openvino_gpus(device_ids: list[str]) -> list[dict[str, Any]]:
    """Intel GPUs OpenVINO reaches, with their name and memory when OpenVINO reports them."""
    gpus: list[dict[str, Any]] = []
    gpu_ids = [device for device in device_ids if device.upper().startswith("GPU")]
    if not gpu_ids:
        return gpus
    try:
        import openvino as ov

        core = ov.Core()
    except Exception:
        return [{"name": device, "vendor": "Intel", "memoryTotalBytes": None} for device in gpu_ids]
    for device in gpu_ids:
        name = device
        memory = None
        try:
            name = str(core.get_property(device, "FULL_DEVICE_NAME"))
        except Exception:
            pass
        try:
            memory = int(core.get_property(device, "GPU_DEVICE_TOTAL_MEM_SIZE"))
        except Exception:
            pass
        gpus.append({"name": name, "vendor": "Intel", "memoryTotalBytes": memory})
    return gpus


def container_report(providers: list[str], openvino_device_ids: list[str]) -> dict[str, Any]:
    """The GPU this container uses for AI work, the backend, the driver and the devices passed in."""
    render_nodes = _render_nodes()
    kfd = Path("/dev/kfd")
    smi = _nvidia_smi()
    gpus, runtime, backend = _torch_gpus()
    if not gpus and "CUDAExecutionProvider" in providers and smi and smi.get("name"):
        gpus, runtime, backend = (
            [{"name": smi["name"], "vendor": "NVIDIA", "memoryTotalBytes": smi.get("memoryTotalBytes")}],
            None,
            "CUDA",
        )
    if not gpus and "ROCMExecutionProvider" in providers:
        backend = "ROCm"
    if not gpus and backend is None:
        gpus = _openvino_gpus(openvino_device_ids)
        backend = "OpenVINO" if gpus else "CPU"
    driver_parts = [
        part for part in [f"Driver {smi['driver']}" if smi and smi.get("driver") else None, runtime] if part
    ]
    return {
        "image": os.environ.get("DEVICE", "cpu"),
        "backend": backend or "CPU",
        "gpus": gpus,
        "driver": " · ".join(driver_parts) or None,
        "nvidiaError": smi.get("error") if smi else None,
        "devices": {
            "renderNodes": render_nodes,
            "kfd": kfd.exists(),
            "kfdAccessible": kfd.exists() and os.access(kfd, os.R_OK | os.W_OK),
            "nvidia": Path("/dev/nvidiactl").exists() or Path("/proc/driver/nvidia").exists(),
            "nvidiaRequested": bool(os.environ.get("NVIDIA_VISIBLE_DEVICES")),
        },
    }
