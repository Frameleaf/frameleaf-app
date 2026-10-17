"""Evidence checks for native model qualification; availability alone is not execution."""

from __future__ import annotations

import math
from typing import Any, Literal, TypedDict

QualificationState = Literal["ready-cpu", "ready-accelerator", "ready-mixed", "incompatible"]


class ExecutionEvidence(TypedDict):
    state: QualificationState
    nodes: dict[str, int]
    microseconds: dict[str, float]
    reason: str | None


def execution_evidence(events: Any, requested: str) -> ExecutionEvidence:
    if not isinstance(events, list) or len(events) > 200_000:
        raise ValueError("native_execution_profile_invalid")
    nodes: dict[str, int] = {}
    elapsed: dict[str, float] = {}
    for event in events:
        if not isinstance(event, dict):
            raise ValueError("native_execution_profile_invalid")
        if (
            event.get("cat") != "Node"
            or event.get("ph") != "X"
            or not str(event.get("name", "")).endswith("_kernel_time")
        ):
            continue
        args = event.get("args")
        duration = event.get("dur")
        if (
            not isinstance(args, dict)
            or not isinstance(args.get("provider"), str)
            or not isinstance(duration, (int, float))
            or isinstance(duration, bool)
            or not math.isfinite(duration)
            or duration < 0
        ):
            raise ValueError("native_execution_profile_invalid")
        provider = args["provider"]
        nodes[provider] = nodes.get(provider, 0) + 1
        elapsed[provider] = elapsed.get(provider, 0) + duration
    state: QualificationState = "incompatible"
    reason: str | None = "requested_provider_not_executed"
    if requested == "CoreMLExecutionProvider" and nodes.get(requested):
        # A CoreML delegation can still execute on CPU internally; device proof must be supplied separately.
        reason = "coreml_device_execution_unproven"
    elif nodes.get(requested) and set(nodes).issubset({requested, "CPUExecutionProvider"}):
        state = (
            "ready-cpu"
            if requested == "CPUExecutionProvider"
            else "ready-mixed"
            if nodes.get("CPUExecutionProvider")
            else "ready-accelerator"
        )
        reason = None
    return {"state": state, "nodes": nodes, "microseconds": elapsed, "reason": reason}


def compare_output(actual: Any, expected: Any, key: str = "") -> None:
    """Compare a NAS-approved fixture without accepting NaN, changed shapes or embeddings."""
    if isinstance(actual, dict) and isinstance(expected, dict):
        if set(actual) != set(expected):
            raise ValueError("native_output_schema_mismatch")
        for name in expected:
            compare_output(actual[name], expected[name], name)
    elif isinstance(actual, list) and isinstance(expected, list):
        if len(actual) != len(expected):
            raise ValueError("native_output_shape_mismatch")
        for left, right in zip(actual, expected):
            compare_output(left, right)
    elif (
        isinstance(actual, (int, float))
        and isinstance(expected, (int, float))
        and not isinstance(actual, bool)
        and not isinstance(expected, bool)
    ):
        if (
            not math.isfinite(actual)
            or not math.isfinite(expected)
            or not math.isclose(actual, expected, rel_tol=1e-3, abs_tol=1e-4)
        ):
            raise ValueError("native_output_value_mismatch")
    elif key in {"clip", "embedding"} and isinstance(actual, str) and isinstance(expected, str):
        import orjson

        left, right = orjson.loads(actual), orjson.loads(expected)
        if not isinstance(left, list) or not isinstance(right, list) or not left or len(left) > 65_536:
            raise ValueError("native_embedding_invalid")
        compare_output(left, right)
    elif type(actual) is not type(expected) or actual != expected:
        raise ValueError("native_output_value_mismatch")
