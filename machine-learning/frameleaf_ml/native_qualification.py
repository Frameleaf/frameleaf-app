"""Run an approved fixture through production library inference in a fresh process."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path, PurePosixPath
from threading import Timer
from time import perf_counter
from typing import TYPE_CHECKING, Any

import onnx
import orjson
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

from frameleaf_ml.native_hardware import snapshot
from frameleaf_ml.native_ort import configure
from frameleaf_ml.qualification import compare_output, execution_evidence
from frameleaf_ml.schemas import InferenceEntries, ModelTask, ModelType, ORJSONResponse

if TYPE_CHECKING:
    from frameleaf_ml.models.base import InferenceModel
    from frameleaf_ml.native_device import DeviceObserver
    from frameleaf_ml.sessions.ort import OrtSession


def safe_relative(value: str) -> str:
    path = PurePosixPath(value)
    if (
        not value
        or path.is_absolute()
        or any(part in {"..", "."} for part in value.split("/"))
        or "\\" in value
        or ":" in value
    ):
        raise ValueError("native_artifact_path_invalid")
    return value


class Contract(BaseModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, alias_generator=to_camel, populate_by_name=True, allow_inf_nan=False
    )


class StagedModel(Contract):
    name: str = Field(pattern=r"^[A-Za-z0-9_.-]{1,128}$")
    task: ModelTask
    type: ModelType
    artifacts: dict[str, str] = Field(min_length=1, max_length=4096)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        return safe_relative(value)

    @field_validator("artifacts")
    @classmethod
    def valid_artifacts(cls, value: dict[str, str]) -> dict[str, str]:
        for name, digest in value.items():
            safe_relative(name)
            if not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise ValueError("native_artifact_hash_invalid")
        return value


class ModelBindingSpec(Contract):
    protocol_version: int = Field(ge=1, le=1)
    model_key: str = Field(min_length=1, max_length=256)
    models: list[StagedModel] = Field(min_length=1, max_length=64)
    entries: dict[str, Any]
    preprocessing_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class QualificationSpec(ModelBindingSpec):
    provider: str
    fixture_file: str
    fixture_kind: str = Field(pattern=r"^(image|text)$")
    fixture_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_output: dict[str, Any]
    min_memory_bytes: int = Field(ge=1, le=2**63 - 1)
    deadline_seconds: int = Field(default=120, ge=1, le=600)

    @field_validator("fixture_file")
    @classmethod
    def valid_fixture(cls, value: str) -> str:
        return safe_relative(value)


def preprocessing_identity() -> str:
    root = Path(__file__).parent
    files = sorted((root / "models").rglob("*.py")) + [
        root / name for name in ("main.py", "schemas.py", "config.py", "producer_binding.py")
    ]
    digest = hashlib.sha256()
    for path in files:
        digest.update(path.relative_to(root).as_posix().encode() + b"\0" + path.read_bytes())
    return digest.hexdigest()


def validate_external_weights(model_path: Path, root: Path, artifacts: dict[str, str]) -> None:
    proto = onnx.load(model_path, load_external_data=False)

    def visit(message: Any) -> None:
        if isinstance(message, onnx.TensorProto) and message.data_location == onnx.TensorProto.EXTERNAL:
            location = {entry.key: entry.value for entry in message.external_data}.get("location", "")
            safe_relative(location)
            path = (model_path.parent / location).resolve()
            if not path.is_relative_to(root.resolve()) or path.relative_to(root.resolve()).as_posix() not in artifacts:
                raise ValueError("native_external_weight_not_approved")
        for field, value in message.ListFields():
            if field.type == field.TYPE_MESSAGE:
                for child in value if field.is_repeated else [value]:
                    visit(child)

    visit(proto)


def verify_models(
    spec: ModelBindingSpec, cache_dir: Path, *, require_staged: bool = True
) -> tuple[InferenceEntries, list[InferenceModel]]:
    from frameleaf_ml.models import from_model_type
    from frameleaf_ml.native_runtime import library_entries
    from frameleaf_ml.staging import cache_hashes, verify_staged

    entries = library_entries(orjson.dumps(spec.entries).decode())
    selected = {(entry["name"], entry["task"], entry["type"]): entry for group in entries for entry in group}
    if len(selected) != len(spec.models) or set(selected) != {
        (item.name, item.task, item.type) for item in spec.models
    }:
        raise ValueError("native_model_binding_mismatch")
    models = []
    for item in spec.models:
        if item.task not in {ModelTask.SEARCH, ModelTask.FACIAL_RECOGNITION, ModelTask.OCR}:
            raise ValueError("native_engine_qualification_not_supported")
        model = from_model_type(
            item.name, item.type, item.task, **selected[(item.name, item.task, item.type)]["options"]
        )
        if model.model_name != item.name:
            raise ValueError("native_model_name_not_canonical")
        if not model.cache_dir.resolve().is_relative_to(cache_dir.resolve()):
            raise ValueError("native_cache_directory_invalid")
        actual = verify_staged(model.cache_dir) if require_staged else cache_hashes(model.cache_dir)
        if actual != item.artifacts:
            raise ValueError("native_staged_hash_mismatch")
        if model.model_path.suffix != ".onnx":
            raise ValueError("native_engine_qualification_not_supported")
        validate_external_weights(model.model_path, model.cache_dir, item.artifacts)
        models.append(model)
    return entries, models


async def qualify(
    spec: QualificationSpec,
    cache_dir: Path,
    fixture_root: Path,
    spec_sha256: str,
    *,
    observer: DeviceObserver | None = None,
) -> dict[str, Any]:
    if "frameleaf_ml.main" in sys.modules:
        raise RuntimeError("native_qualification_requires_fresh_process")
    from frameleaf_ml.config import settings
    from frameleaf_ml.native_device import confirm_coreml_execution, model_bindings
    from frameleaf_ml.staging import cache_hashes

    if cache_dir.is_symlink():
        raise ValueError("native_cache_directory_invalid")
    if preprocessing_identity() != spec.preprocessing_sha256:
        raise ValueError("native_preprocessing_changed")
    if observer is not None and (spec.provider != "CoreMLExecutionProvider" or observer.provider != spec.provider):
        raise ValueError("native_device_observer_invalid")
    before = snapshot(observer.facts()) if observer is not None else snapshot()
    if before["availableMemoryBytes"] < spec.min_memory_bytes:
        raise ValueError("native_memory_insufficient")
    settings.model_downloads = False
    settings.cache_folder = cache_dir.resolve()
    settings.ann = False
    settings.rknn = False
    entries, models = verify_models(spec, cache_dir)
    fixture = fixture_root / spec.fixture_file
    if (
        fixture.is_symlink()
        or not fixture.resolve().is_relative_to(fixture_root.resolve())
        or not fixture.is_file()
        or fixture.stat().st_size > 16 * 1024 * 1024
    ):
        raise ValueError("native_fixture_invalid")
    data = fixture.read_bytes()
    if hashlib.sha256(data).hexdigest() != spec.fixture_sha256:
        raise ValueError("native_fixture_changed")
    session: OrtSession | None = None
    previous_temp = tempfile.tempdir
    with tempfile.TemporaryDirectory(prefix="frameleaf-qualification-") as temporary:
        tempfile.tempdir = temporary
        try:
            policy = configure(spec.provider, Path(temporary) / "profiles", observer=observer)
            bindings = model_bindings(spec, models) if observer is not None else {}
            if observer is not None:
                observer.bind(bindings)
            from frameleaf_ml import main
            from frameleaf_ml.models.transforms import decode_pil

            payload = data.decode("utf-8") if spec.fixture_kind == "text" else decode_pil(data)
            latencies = []
            for _ in range(2):
                start = perf_counter()
                output = orjson.loads(ORJSONResponse(await main.run_inference(payload, entries)).body)
                compare_output(output, spec.expected_output)
                latencies.append((perf_counter() - start) * 1000)
            evidence = []
            executed = set()
            for session in policy.sessions:
                trace = Path(session.session.end_profiling())
                if (
                    trace.is_symlink()
                    or not trace.resolve().is_relative_to(Path(temporary).resolve())
                    or trace.stat().st_size > 32 * 1024 * 1024
                ):
                    raise ValueError("native_execution_profile_invalid")
                observed = execution_evidence(orjson.loads(trace.read_bytes()), spec.provider)
                if observed["nodes"]:
                    executed.add(session.source_model_path.resolve())
                    evidence.append(observed)
            if not evidence or not {model.model_path.resolve() for model in models}.issubset(executed):
                raise ValueError("native_model_execution_missing")
            for item, model in zip(spec.models, models):
                if cache_hashes(model.cache_dir) != item.artifacts:
                    raise ValueError("native_staged_hash_changed_during_inference")
            after = snapshot()
            if before["fingerprint"] != after["fingerprint"]:
                raise ValueError("native_runtime_or_driver_changed")
            device_evidence = None
            if observer is not None:
                device_evidence = observer.evidence()
                evidence = confirm_coreml_execution(
                    device_evidence, set(bindings.values()), before["facts"]["deviceEvidence"], evidence
                )
            state = (
                "ready-cpu"
                if spec.provider == "CPUExecutionProvider"
                else "ready-mixed"
                if any(item["state"] == "ready-mixed" for item in evidence)
                else "ready-accelerator"
            )
            reason = None
            if any(item["state"] == "incompatible" for item in evidence):
                state, reason = "incompatible", "native_provider_execution_unproven"
            if spec.provider not in {"CPUExecutionProvider", "CUDAExecutionProvider"} or (
                spec.provider == "CUDAExecutionProvider" and not before["facts"]["gpus"]
            ):
                state, reason = "incompatible", "native_device_execution_evidence_required"
            if device_evidence is not None:
                state, reason = "ready-mixed", None
            return {
                "protocolVersion": 1,
                "modelKey": spec.model_key,
                "bindingSha256": spec_sha256,
                "preprocessingSha256": spec.preprocessing_sha256,
                "fixtureSha256": spec.fixture_sha256,
                "runtimeFingerprint": before["fingerprint"],
                "runtime": before["facts"],
                "state": state,
                "reason": reason,
                "provider": spec.provider,
                "execution": evidence,
                "coldMilliseconds": latencies[0],
                "warmMilliseconds": latencies[1],
                **({"deviceExecution": device_evidence} if device_evidence is not None else {}),
            }
        finally:
            tempfile.tempdir = previous_temp
            policy_value = locals().get("policy")
            if policy_value is not None:
                policy_value.sessions.clear()
            session = None
            loaded_main = sys.modules.get("frameleaf_ml.main")
            if loaded_main is not None:
                loaded_main.model_cache.cache._cache.clear()


def main(observer: DeviceObserver | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.spec.is_symlink() or args.spec.stat().st_size > 4 * 1024 * 1024 or args.output.is_symlink():
        parser.error("invalid_qualification_path")
    try:
        raw_spec = args.spec.read_bytes()
        spec = QualificationSpec.model_validate(orjson.loads(raw_spec))
    except ValueError:
        parser.error("native_spec_invalid")
    # The supervisor also bounds the child; this prevents a blocked native inference from hanging this CLI.
    watchdog = Timer(spec.deadline_seconds, lambda: os._exit(124))
    watchdog.daemon = True
    watchdog.start()
    try:
        try:
            report = asyncio.run(
                qualify(spec, args.cache_dir, args.spec.parent, hashlib.sha256(raw_spec).hexdigest(), observer=observer)
            )
        except Exception as error:
            reason = (
                str(error)
                if isinstance(error, ValueError) and re.fullmatch(r"native_[a-z_]{1,100}", str(error))
                else "native_qualification_failed"
            )
            report = {"protocolVersion": 1, "modelKey": spec.model_key, "state": "incompatible", "reason": reason}
        args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.NamedTemporaryFile(dir=args.output.parent, mode="w", encoding="utf-8", delete=False) as stream:
            candidate = Path(stream.name)
            json.dump(report, stream, sort_keys=True, allow_nan=False)
        candidate.replace(args.output)
        if report["state"] == "incompatible":
            raise SystemExit(1)
    finally:
        watchdog.cancel()


if __name__ == "__main__":
    main()
