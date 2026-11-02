"""What this container can actually use for AI work (Frameleaf FL-159, Hardware & GPU).

Reported by ``GET /hardware`` as ``container`` next to the provider list, so the server's
Hardware & GPU page can say which GPU the analysis container reaches, through which backend, and
why it does not when a card is on the host but not passed in. Everything is read inside the
container; nothing here guesses at the host.

Public contract — KEEP IN SYNC WITH ``server/src/repositories/machine-learning.repository.ts``
(``MlContainerHardware``).
"""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
from pathlib import Path
from typing import Any

PCI_VENDORS = {"0x10de": "NVIDIA", "0x1002": "AMD", "0x8086": "Intel"}
GIB = 1024**3


def _read(path: Path) -> str | None:
    try:
        return path.read_text().strip()
    except OSError:
        return None


def _host_node(node: Path, sys_dev: Path = Path("/sys/dev/char")) -> str | None:
    """The host render node this one is, by device number: names inside can differ from the host's."""
    try:
        info = node.stat()
        if not stat.S_ISCHR(info.st_mode):
            return None
        target = Path(os.path.realpath(sys_dev / f"{os.major(info.st_rdev)}:{os.minor(info.st_rdev)}"))
    except OSError:
        return None
    return target.name if target.name.startswith("renderD") and target.exists() else None


def _is_integrated(vendor: str, pci_address: str, memory: int | None) -> bool:
    """Intel's integrated GPU sits at PCI 00:02.0; an AMD APU has only a small memory carve-out.

    KEEP IN SYNC WITH ``server/src/utils/hardware-check.ts`` (``isIntegratedGpu``).
    """
    if vendor == "Intel":
        return pci_address.endswith("00:02.0")
    return vendor == "AMD" and (memory or 0) < 2 * GIB


def _host_gpus(pci: Path = Path("/sys/bus/pci/devices")) -> list[dict[str, Any]] | None:
    """GPUs in the host's PCI list (sysfs shows the host's devices, not only those passed in)."""
    if not pci.is_dir():
        return None
    gpus: list[dict[str, Any]] = []
    for device in sorted(pci.iterdir()):
        if not (_read(device / "class") or "").startswith("0x03"):
            continue
        vendor = PCI_VENDORS.get(_read(device / "vendor") or "")
        if vendor is None:
            continue
        try:
            memory: int | None = int(_read(device / "mem_info_vram_total") or "") or None
        except ValueError:
            memory = None
        drm = device / "drm"
        render = (
            sorted(entry.name for entry in drm.iterdir() if entry.name.startswith("renderD")) if drm.is_dir() else []
        )
        gpus.append(
            {
                "pciAddress": device.name,
                "vendor": vendor,
                "renderNode": render[0] if render else None,
                "integrated": _is_integrated(vendor, device.name, memory),
                "memoryTotalBytes": memory,
            }
        )
    return gpus


def host_facts() -> dict[str, Any]:
    """The kernel (WSL2, Docker Desktop, Unraid), the host's GPUs, /dev/dxg and this process's groups."""
    return {
        "kernel": _read(Path("/proc/sys/kernel/osrelease")) or None,
        "gpus": _host_gpus(),
        "dxg": Path("/dev/dxg").exists(),
        "groups": sorted(set(os.getgroups()) | {os.getgid()}),
        "root": os.geteuid() == 0,
    }


def _gfx_name(version: int) -> str:
    """KFD ``gfx_target_version`` (major·10000 + minor·100 + stepping) as a gfx target, e.g. gfx1032."""
    major, rest = divmod(version, 10000)
    minor, stepping = divmod(rest, 100)
    return f"gfx{major}{minor}{stepping:x}"


def rocm_facts(topology: Path = Path("/sys/class/kfd/kfd/topology/nodes")) -> dict[str, Any] | None:
    """The gfx targets of the AMD GPUs and the ``HSA_OVERRIDE_GFX_VERSION`` set, for the ROCm image."""
    targets: list[str] = []
    if topology.is_dir():
        for node in sorted(topology.iterdir()):
            for line in (_read(node / "properties") or "").splitlines():
                key, _, value = line.partition(" ")
                if key == "gfx_target_version" and value.strip().isdigit() and int(value) > 0:
                    targets.append(_gfx_name(int(value)))
    return {"gfxTargets": targets, "hsaOverride": os.environ.get("HSA_OVERRIDE_GFX_VERSION") or None}


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
        try:
            gid: int | None = node.stat().st_gid
        except OSError:
            gid = None
        nodes.append(
            {
                "node": node.name,
                "vendor": vendor,
                "accessible": os.access(node, os.R_OK | os.W_OK),
                "memoryTotalBytes": vram,
                "gid": gid,
                "hostNode": _host_node(node),
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


def _rocm_smi() -> list[dict[str, Any]]:
    """Name and memory of the AMD GPUs rocm-smi lists, when it is in the image (the ROCm image has it)."""
    binary = shutil.which("rocm-smi")
    if binary is None:
        return []
    try:
        output = subprocess.run(
            [binary, "--showproductname", "--showmeminfo", "vram", "--json"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        cards = json.loads(output.stdout) if output.returncode == 0 and output.stdout.strip() else {}
    except (OSError, subprocess.SubprocessError, ValueError):
        return []
    gpus: list[dict[str, Any]] = []
    for key in sorted(card for card in cards if card.startswith("card")):
        card = cards[key]
        if not isinstance(card, dict):
            continue
        name = card.get("Card Series") or card.get("Device Name") or card.get("Card Model") or key
        try:
            memory: int | None = int(card.get("VRAM Total Memory (B)") or 0) or None
        except (TypeError, ValueError):
            memory = None
        gpus.append({"name": str(name), "vendor": "AMD", "memoryTotalBytes": memory})
    return gpus


def _amd_gpus(render_nodes: list[dict[str, Any]], sys_drm: Path = Path("/sys/class/drm")) -> list[dict[str, Any]]:
    """The AMD GPUs MIGraphX runs on when torch is not installed to name them: rocm-smi first, else the AMD
    render nodes passed in, named by the kernel's product name or their gfx target."""
    gpus = _rocm_smi()
    if gpus:
        return gpus
    targets = (rocm_facts() or {}).get("gfxTargets") or []
    for index, node in enumerate(entry for entry in render_nodes if entry.get("vendor") == "AMD"):
        name = _read(sys_drm / node["node"] / "device" / "product_name")
        if not name:
            name = f"AMD {targets[index]}" if index < len(targets) else "AMD GPU"
        gpus.append({"name": name, "vendor": "AMD", "memoryTotalBytes": node.get("memoryTotalBytes")})
    return gpus


def _compute_capability() -> str | None:
    """CUDA compute capability of the first GPU, such as "7.5" (bf16 and FlashAttention need 8.0)."""
    try:
        import torch

        if torch.cuda.is_available() and not getattr(torch.version, "hip", None):
            major, minor = torch.cuda.get_device_capability(0)
            return f"{major}.{minor}"
    except Exception:
        pass
    binary = shutil.which("nvidia-smi")
    if binary is None:
        return None
    try:
        output = subprocess.run(
            [binary, "--query-gpu=compute_cap", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    lines = output.stdout.strip().splitlines()
    value = lines[0].strip() if output.returncode == 0 and lines else ""
    return value if value.replace(".", "", 1).isdigit() else None


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
    if not gpus and ("MIGraphXExecutionProvider" in providers or "ROCMExecutionProvider" in providers):
        # ONNX Runtime on ROCm without torch: the provider names no device, so the GPUs are read from the driver
        gpus, backend = _amd_gpus(render_nodes), "ROCm"
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
        # FL-159: GPU present on the host, visible here and usable by the runtime are three facts.
        "host": host_facts(),
        "computeCapability": _compute_capability() if backend == "CUDA" else None,
        "rocm": rocm_facts() if os.environ.get("DEVICE", "cpu") == "rocm" else None,
    }
