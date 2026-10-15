"""Revalidate one approved model/configuration before and after native prediction."""

from pathlib import Path
from typing import Any

import orjson

from .models.base import ModelUnavailableError
from .native_hardware import snapshot
from .native_qualification import QualificationSpec, preprocessing_identity, verify_models
from .schemas import InferenceEntries


class NativeBinding:
    def __init__(self, spec: QualificationSpec, cache: Path, fingerprint: str) -> None:
        self.spec = spec
        self.cache = cache
        self.fingerprint = fingerprint

    @classmethod
    def load(cls, spec_path: Path, report_path: Path, cache: Path, provider: str) -> "NativeBinding":
        import hashlib
        import re

        def read(path: Path) -> bytes:
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 4 * 1024 * 1024:
                raise ValueError("native_binding_path_invalid")
            with path.open("rb") as stream:
                value = stream.read(4 * 1024 * 1024 + 1)
            if len(value) > 4 * 1024 * 1024:
                raise ValueError("native_binding_path_invalid")
            return value

        raw = read(spec_path)
        spec = QualificationSpec.model_validate(orjson.loads(raw))
        report = orjson.loads(read(report_path))
        if (
            not isinstance(report, dict)
            or spec.provider != provider
            or report.get("provider") != provider
            or report.get("state") not in {"ready-cpu", "ready-mixed", "ready-accelerator"}
            or report.get("reason") is not None
            or report.get("bindingSha256") != hashlib.sha256(raw).hexdigest()
            or report.get("modelKey") != spec.model_key
            or not isinstance(report.get("runtimeFingerprint"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", report["runtimeFingerprint"])
        ):
            raise ValueError("native_binding_report_invalid")
        binding = cls(spec, cache, report["runtimeFingerprint"])
        binding.check(spec.entries, spec.fixture_kind)
        return binding

    def check(self, entries: Any, kind: str) -> InferenceEntries:
        if entries != self.spec.entries or kind != self.spec.fixture_kind:
            raise ValueError("native_request_binding_mismatch")
        facts = snapshot()
        if facts["fingerprint"] != self.fingerprint:
            raise ValueError("native_runtime_or_driver_changed")
        if facts["availableMemoryBytes"] < self.spec.min_memory_bytes:
            raise ValueError("native_memory_insufficient")
        if preprocessing_identity() != self.spec.preprocessing_sha256:
            raise ValueError("native_preprocessing_changed")
        if self.cache.is_symlink():
            raise ValueError("native_cache_directory_invalid")
        try:
            return verify_models(self.spec, self.cache)[0]
        except (ModelUnavailableError, OSError) as error:
            raise ValueError("native_staged_model_unavailable") from error
