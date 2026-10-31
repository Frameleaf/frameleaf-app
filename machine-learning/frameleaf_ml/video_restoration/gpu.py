"""GPU discovery and memory sampling through ``nvidia-smi`` (FL-114).

The worker app itself does not import torch: the model runtimes live in their own pinned
environments, so the app asks the driver what hardware exists and how much memory a run
used. Every failure degrades to "no GPU" or "not measured", never to a guess.
"""

import logging
import subprocess
import threading
from types import TracebackType

from .schemas import GpuDescription

log = logging.getLogger("frameleaf.restoration")

NVIDIA_SMI = "nvidia-smi"
MIB = 1024 * 1024


def _run_smi(args: list[str], timeout: float = 10.0) -> str | None:
    try:
        completed = subprocess.run(
            [NVIDIA_SMI, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except (FileNotFoundError, PermissionError, subprocess.TimeoutExpired) as error:
        log.debug("nvidia-smi unavailable: %s", error)
        return None
    if completed.returncode != 0:
        log.debug("nvidia-smi exited with %s: %s", completed.returncode, completed.stderr.strip())
        return None
    return completed.stdout


def parse_gpu_query(output: str) -> list[GpuDescription]:
    """Parse ``--query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits``."""
    gpus: list[GpuDescription] = []
    for line in output.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 3 or not parts[0]:
            continue
        try:
            memory_mib = int(float(parts[1]))
        except ValueError:
            continue
        gpus.append(GpuDescription(name=parts[0], memoryTotalBytes=memory_mib * MIB, driverVersion=parts[2]))
    return gpus


def query_gpus() -> list[GpuDescription]:
    output = _run_smi(["--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"])
    return parse_gpu_query(output) if output is not None else []


def parse_memory_used(output: str) -> int | None:
    """Largest ``memory.used`` across devices, in bytes."""
    values: list[int] = []
    for line in output.splitlines():
        try:
            values.append(int(float(line.strip())) * MIB)
        except ValueError:
            continue
    return max(values) if values else None


def query_memory_used() -> int | None:
    output = _run_smi(["--query-gpu=memory.used", "--format=csv,noheader,nounits"], timeout=5.0)
    return parse_memory_used(output) if output is not None else None


class VramSampler:
    """Sample device memory in the background while a runtime runs; ``peak`` is the highest
    reading, or None when no reading succeeded."""

    def __init__(self, interval_s: float = 0.5) -> None:
        self.interval_s = interval_s
        self.peak: int | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _sample(self) -> None:
        reading = query_memory_used()
        if reading is not None and (self.peak is None or reading > self.peak):
            self.peak = reading

    def _loop(self) -> None:
        while not self._stop.is_set():
            self._sample()
            self._stop.wait(self.interval_s)

    def __enter__(self) -> "VramSampler":
        self._thread = threading.Thread(target=self._loop, name="restoration-vram-sampler", daemon=True)
        self._thread.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self.interval_s * 4)
        self._sample()
