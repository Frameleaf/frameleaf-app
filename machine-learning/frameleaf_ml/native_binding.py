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

    async def preload(self) -> None:
        from . import main

        entries = await main.run(self.check, self.spec.entries, self.spec.fixture_kind)
        for group in entries:
            for entry in group:
                model = await main.model_cache.get(
                    entry["name"], entry["type"], entry["task"], ttl=main.settings.model_ttl, **entry["options"]
                )
                await main.load(model)
        await main.run(self.check, self.spec.entries, self.spec.fixture_kind)

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

    def matches(self, entries: Any, kind: str) -> bool:
        return (
            kind == self.spec.fixture_kind
            and isinstance(entries, dict)
            and orjson.dumps(entries, option=orjson.OPT_SORT_KEYS)
            == orjson.dumps(self.spec.entries, option=orjson.OPT_SORT_KEYS)
        )

    def check(self, entries: Any, kind: str) -> InferenceEntries:
        if not self.matches(entries, kind):
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
            entries, models = verify_models(self.spec, self.cache)
            from .native_device import model_bindings
            from .native_ort import current_policy

            policy = current_policy()
            if policy is not None and policy.observer is not None:
                if policy.provider != self.spec.provider:
                    raise ValueError("native_device_observer_invalid")
                policy.observer.bind(model_bindings(self.spec, models))
            return entries
        except (ModelUnavailableError, OSError) as error:
            raise ValueError("native_staged_model_unavailable") from error


class NativeBindingSet:
    """One owned runtime, with an exact, independently qualified binding for every admitted role."""

    def __init__(self, bindings: list[NativeBinding]) -> None:
        if not 1 <= len(bindings) <= 64:
            raise ValueError("native_binding_set_invalid")
        keys = {binding.spec.model_key for binding in bindings}
        requests = {
            (binding.spec.fixture_kind, orjson.dumps(binding.spec.entries, option=orjson.OPT_SORT_KEYS))
            for binding in bindings
        }
        runtimes = {(binding.spec.provider, binding.fingerprint, binding.cache.resolve()) for binding in bindings}
        if len(keys) != len(bindings) or len(requests) != len(bindings) or len(runtimes) != 1:
            raise ValueError("native_binding_set_invalid")
        self.bindings = tuple(bindings)

    async def preload(self) -> None:
        for binding in self.bindings:
            await binding.preload()

    @classmethod
    def load(cls, specs: list[Path], reports: list[Path], cache: Path, provider: str) -> "NativeBindingSet":
        if not 1 <= len(specs) <= 64 or len(specs) != len(reports):
            raise ValueError("native_binding_set_invalid")
        return cls(
            [NativeBinding.load(spec, report, cache, provider) for spec, report in zip(specs, reports, strict=True)]
        )

    def check(self, entries: Any, kind: str) -> InferenceEntries:
        for binding in self.bindings:
            if binding.matches(entries, kind):
                return binding.check(entries, kind)
        raise ValueError("native_request_binding_mismatch")
