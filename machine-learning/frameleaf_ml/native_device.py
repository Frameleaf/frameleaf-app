"""Optional device evidence supplied by an owned native launcher, never by request JSON."""

from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping, Sequence
from contextlib import AbstractContextManager
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from .models.base import InferenceModel
    from .native_qualification import ModelBindingSpec
    from .qualification import ExecutionEvidence


class DeviceObserver(Protocol):
    provider: str

    def facts(self) -> dict[str, Any]: ...
    def bind(self, models: Mapping[Path, str]) -> None: ...
    def observe(self, model: Path) -> AbstractContextManager[None]: ...
    def evidence(self) -> dict[str, Any]: ...


def validate_facts(value: Any) -> None:
    if (
        not isinstance(value, dict)
        or set(value) != {"abiVersion", "collectorSha256", "osBuild", "devices"}
        or type(value["abiVersion"]) is not int
        or value["abiVersion"] != 1
        or not isinstance(value["collectorSha256"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", value["collectorSha256"])
        or not isinstance(value["osBuild"], str)
        or not 1 <= len(value["osBuild"]) <= 256
        or not isinstance(value["devices"], list)
        or not 1 <= len(value["devices"]) <= 16
    ):
        raise ValueError("native_device_facts_invalid")
    identities = set()
    for device in value["devices"]:
        if (
            not isinstance(device, dict)
            or set(device) != {"name", "identitySha256"}
            or not isinstance(device["name"], str)
            or not 1 <= len(device["name"]) <= 256
            or not isinstance(device["identitySha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", device["identitySha256"])
            or device["identitySha256"] in identities
        ):
            raise ValueError("native_device_facts_invalid")
        identities.add(device["identitySha256"])
    if len(json.dumps(value, allow_nan=False).encode()) > 16384:
        raise ValueError("native_device_facts_invalid")


def model_bindings(spec: ModelBindingSpec, models: Sequence[InferenceModel]) -> dict[Path, str]:
    result = {}
    for item, model in zip(spec.models, models, strict=True):
        relative = model.model_path.relative_to(model.cache_dir).as_posix()
        digest = item.artifacts[relative]
        path = model.model_path.resolve()
        if path in result and result[path] != digest:
            raise ValueError("native_device_model_binding_conflict")
        result[path] = digest
    return result


def validate_evidence(value: Any, expected: set[str], facts: dict[str, Any]) -> None:
    validate_facts(facts)
    if (
        not isinstance(value, dict)
        or set(value) != {"provider", "facts", "models"}
        or value["provider"] != "CoreMLExecutionProvider"
        or value["facts"] != facts
        or not isinstance(value["models"], list)
        or not 1 <= len(value["models"]) <= 64
    ):
        raise ValueError("native_device_evidence_invalid")
    validate_facts(value["facts"])
    observed = set()
    for model in value["models"]:
        if (
            not isinstance(model, dict)
            or set(model) != {"sha256", "calls", "computeBuffers", "computeDispatches", "gpuNanoseconds"}
            or not isinstance(model["sha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", model["sha256"])
            or model["sha256"] in observed
            or any(type(model[key]) is not int for key in ("calls", "computeBuffers", "computeDispatches"))
            or not 2 <= model["calls"] <= model["computeBuffers"] <= model["computeDispatches"] < 2**63
            or type(model["gpuNanoseconds"]) not in {int, float}
            or not math.isfinite(model["gpuNanoseconds"])
            or not 0 < model["gpuNanoseconds"] <= 600_000_000_000 * model["calls"]
        ):
            raise ValueError("native_device_evidence_invalid")
        observed.add(model["sha256"])
    if observed != expected:
        raise ValueError("native_device_model_coverage_missing")


def confirm_coreml_execution(
    value: Any, expected: set[str], facts: dict[str, Any], execution: list[ExecutionEvidence]
) -> list[ExecutionEvidence]:
    validate_evidence(value, expected, facts)
    if not 1 <= len(execution) <= 64:
        raise ValueError("native_provider_execution_unproven")
    for item in execution:
        nodes = item.get("nodes")
        if (
            not isinstance(nodes, dict)
            or "CoreMLExecutionProvider" not in nodes
            or set(nodes) - {"CoreMLExecutionProvider", "CPUExecutionProvider"}
            or any(type(count) is not int or not 0 < count <= 200_000 for count in nodes.values())
        ):
            raise ValueError("native_provider_execution_unproven")
    # Physical GPU participation does not prove exclusive placement inside a CoreML delegation.
    return [{**item, "state": "ready-mixed", "reason": None} for item in execution]
