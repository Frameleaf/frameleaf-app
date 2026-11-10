"""Read the worker's visible cgroup limits, never host RAM as a container allowance.

These are diagnostic limits, not free memory or a model-admission decision. Ancestors
outside the cgroup mount/namespace are invisible and may impose tighter limits.
CPU quota is bandwidth in cores, not a count of available/affinity CPUs.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Literal, TypedDict


class ResourceLimit(TypedDict):
    status: Literal["limited", "unlimited", "unavailable"]
    value: int | float | None


class ContainerResources(TypedDict):
    memoryBytes: ResourceLimit
    cpuCores: ResourceLimit


def _read(path: Path) -> str:
    return path.read_text().strip()


def _unescape(value: str) -> str:
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), value)


def _location(controller: str, membership: str, mounts: str) -> tuple[int, Path, Path] | None:
    groups = [line.split(":", 2) for line in membership.splitlines()]
    # On hybrid hosts a controller's v1 membership takes precedence over the v2 hierarchy.
    for version in (1, 2):
        for group in groups:
            if len(group) != 3 or (controller not in group[1].split(",") if version == 1 else group[0:2] != ["0", ""]):
                continue
            member = Path(group[2])
            if not member.is_absolute() or ".." in member.parts:
                return None
            for line in mounts.splitlines():
                before, separator, after = line.partition(" - ")
                fields, fs = before.split(), after.split()
                if not separator or len(fields) < 6 or len(fs) < 3:
                    continue
                if fs[0] != ("cgroup" if version == 1 else "cgroup2"):
                    continue
                if version == 1 and controller not in fs[2].split(","):
                    continue
                root, mount = Path(_unescape(fields[3])), Path(_unescape(fields[4]))
                if not root.is_absolute() or not mount.is_absolute() or ".." in root.parts or ".." in mount.parts:
                    continue
                if not member.is_relative_to(root):
                    continue
                return version, mount / member.relative_to(root), mount
            # A controller assigned to v1 is not governed by the unified v2 mount.
            return None
    return None


def _limit(controller: str, location: tuple[int, Path, Path] | None) -> ResourceLimit:
    unknown: ResourceLimit = {"status": "unavailable", "value": None}
    if location is None:
        return unknown
    version, leaf, mount = location
    limits: list[int | float] = []
    seen = False
    current = leaf
    while True:
        try:
            if controller == "memory":
                value = _read(current / ("memory.max" if version == 2 else "memory.limit_in_bytes"))
                # v1 PAGE_COUNTER_MAX is LONG_MAX rounded down to a page boundary.
                unlimited = (
                    value == "max"
                    if version == 2
                    else value == str(sys.maxsize - sys.maxsize % os.sysconf("SC_PAGE_SIZE"))
                )
                if not unlimited:
                    limit = int(value)
                    if limit < 0 or limit > 2**53 - 1:
                        return unknown
                    limits.append(limit)
            else:
                quota, period = (
                    _read(current / "cpu.max").split()
                    if version == 2
                    else (_read(current / "cpu.cfs_quota_us"), _read(current / "cpu.cfs_period_us"))
                )
                period_us = int(period)
                if period_us <= 0:
                    return unknown
                if quota != ("max" if version == 2 else "-1"):
                    quota_us = int(quota)
                    if quota_us <= 0 or quota_us > 2**53 - 1 or period_us > 2**53 - 1:
                        return unknown
                    limits.append(quota_us / period_us)
            seen = True
        except FileNotFoundError:
            # The real v2 root has no limit files. A missing leaf/controller is unknown.
            if version != 2 or current != mount or current == leaf:
                return unknown
        except (OSError, UnicodeError, ValueError, OverflowError):
            return unknown
        if current == mount:
            break
        current = current.parent
    if not seen:
        return unknown
    return {"status": "limited", "value": min(limits)} if limits else {"status": "unlimited", "value": None}


def container_resources(proc: Path = Path("/proc/self")) -> ContainerResources:
    """Limits from this process and all readable ancestors inside its visible mount.

    Null with ``unavailable`` means absent, inaccessible or malformed evidence, not
    unlimited. ``unlimited`` only describes the visible hierarchy. No paths or raw
    proc contents are returned. An older/non-Linux worker remains usable.
    """
    try:
        membership, mounts = _read(proc / "cgroup"), _read(proc / "mountinfo")
    except (OSError, UnicodeError):
        membership, mounts = "", ""
    return {
        "memoryBytes": _limit("memory", _location("memory", membership, mounts)),
        "cpuCores": _limit("cpu", _location("cpu", membership, mounts)),
    }
