from __future__ import annotations

from collections.abc import Sequence
from contextlib import nullcontext
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock
from typing import Any
from uuid import uuid4

import numpy as np
import onnxruntime as ort
from numpy.typing import NDArray

from frameleaf_ml.models.constants import SUPPORTED_PROVIDERS
from frameleaf_ml.native_ort import current_policy
from frameleaf_ml.schemas import ModelPrecision, SessionNode
from frameleaf_ml.sessions import runtime_cache_dir

from ..config import log, settings

MigraphxInputSignature = tuple[tuple[str, str, tuple[int, ...]], ...]

_migraphx_registry_lock = Lock()
_migraphx_model_locks: dict[str, Lock] = {}
_migraphx_compiled_inputs: set[tuple[str, MigraphxInputSignature]] = set()


def _migraphx_get_model_lock(model_key: str) -> Lock:
    with _migraphx_registry_lock:
        lock = _migraphx_model_locks.get(model_key)
        if lock is None:
            lock = Lock()
            _migraphx_model_locks[model_key] = lock
        return lock


def _migraphx_has_compiled_input(key: tuple[str, MigraphxInputSignature]) -> bool:
    with _migraphx_registry_lock:
        return key in _migraphx_compiled_inputs


def _migraphx_mark_compiled_input(key: tuple[str, MigraphxInputSignature]) -> None:
    with _migraphx_registry_lock:
        _migraphx_compiled_inputs.add(key)


def _migraphx_input_signature(input_feed: dict[str, NDArray[Any]]) -> MigraphxInputSignature:
    return tuple((name, str(value.dtype), tuple(value.shape)) for name, value in sorted(input_feed.items()))


def _get_openvino_device_type(device_ids: list[str], configured_device_id: str) -> str:
    gpu_devices = [device_id for device_id in device_ids if device_id.upper().startswith("GPU")]
    requested_id = configured_device_id.strip() or "AUTO"

    if requested_id.upper() == "CPU":
        log.debug("OpenVINO: Using CPU device")
        return "CPU"

    if not gpu_devices:
        log.debug("OpenVINO: No GPU found, using CPU")
        return "CPU"

    if requested_id.upper() == "AUTO":
        device_type = gpu_devices[0]
        log.debug(f"OpenVINO: AUTO selected {device_type}")
        return device_type

    if requested_id.upper().startswith("GPU"):
        requested_gpu = requested_id
    else:
        requested_gpu = f"GPU.{requested_id}"

    if requested_gpu in gpu_devices:
        log.debug(f"OpenVINO: Using GPU device {requested_gpu}")
        return requested_gpu

    if requested_gpu == "GPU.0" and "GPU" in gpu_devices:
        log.debug("OpenVINO: Using GPU device GPU")
        return "GPU"

    device_type = gpu_devices[0]
    log.warning(
        f"OpenVINO: Requested GPU device {requested_gpu} was not found. "
        f"Available OpenVINO devices: {device_ids}. Using {device_type}"
    )
    return device_type


class OrtSession:
    session: ort.InferenceSession

    def __init__(
        self,
        model_path: Path | str,
        providers: list[str] | None = None,
        provider_options: list[dict[str, Any]] | None = None,
        sess_options: ort.SessionOptions | None = None,
        device_id: str | None = None,
    ):
        self.model_path = Path(model_path)
        self.source_model_path = self.model_path
        native = current_policy()
        self._coreml_lock = (
            Lock()
            if native is not None
            and native.provider == "CoreMLExecutionProvider"
            and sess_options is None
            and provider_options is None
            else None
        )
        self._coreml_input_shapes: list[tuple[str, tuple[int | str | None, ...]]] | None = None
        self._coreml_shape: tuple[tuple[str, tuple[int, ...]], ...] | None = None
        self._coreml_cache: TemporaryDirectory[str] | None = None
        if native is not None:
            requested = [native.provider] + (
                [] if native.provider == "CPUExecutionProvider" else ["CPUExecutionProvider"]
            )
            if providers is not None and providers != requested:
                raise ValueError("native_provider_override_forbidden")
            providers = requested
        self.device_id = device_id
        self.providers = providers if providers is not None else self._providers_default
        self.provider_options = provider_options if provider_options is not None else self._provider_options_default
        self.sess_options = sess_options if sess_options is not None else self._sess_options_default
        if native is not None and native.profile_dir is not None:
            self.sess_options.enable_profiling = True
            self.sess_options.profile_file_prefix = str(native.profile_dir / f"native-{uuid4().hex}")
        self.session = ort.InferenceSession(
            self.model_path.as_posix(),
            providers=self.providers,
            provider_options=self.provider_options,
            sess_options=self.sess_options,
        )
        if native is not None:
            self.session.disable_fallback()
            if native.provider not in self.session.get_providers():
                raise RuntimeError("native_provider_not_loaded")
            if native.profile_dir is not None:
                if len(native.sessions) >= 64:
                    raise RuntimeError("native_session_limit")
                native.sessions.append(self)

    def get_inputs(self) -> Sequence[SessionNode]:
        inputs: Sequence[SessionNode] = self.session.get_inputs()
        return inputs

    def get_outputs(self) -> Sequence[SessionNode]:
        outputs: Sequence[SessionNode] = self.session.get_outputs()
        return outputs

    def get_metadata(self) -> dict[str, str]:
        metadata: dict[str, str] = self.session.get_modelmeta().custom_metadata_map
        return metadata

    def run(
        self,
        output_names: list[str] | None,
        input_feed: dict[str, NDArray[np.float32]] | dict[str, NDArray[np.int32]] | dict[str, NDArray[np.uint8]],
        run_options: Any = None,
    ) -> list[NDArray[np.float32]]:
        native = current_policy()
        observer = native.observer if native is not None else None
        if self._coreml_lock is not None:
            with self._coreml_lock:
                self._specialize_coreml(input_feed)
                with observer.observe(self.source_model_path) if observer is not None else nullcontext():
                    coreml_outputs: list[NDArray[np.float32]] = self.session.run(output_names, input_feed, run_options)
                    return coreml_outputs
        with observer.observe(self.source_model_path) if observer is not None else nullcontext():
            if "MIGraphXExecutionProvider" in self.providers:
                model_key = self.model_path.resolve().as_posix()
                input_key = (model_key, _migraphx_input_signature(input_feed))
                if not _migraphx_has_compiled_input(input_key):
                    model_lock = _migraphx_get_model_lock(model_key)
                    with model_lock:
                        if not _migraphx_has_compiled_input(input_key):
                            outputs: list[NDArray[np.float32]] = self.session.run(output_names, input_feed, run_options)
                            _migraphx_mark_compiled_input(input_key)
                            return outputs

                outputs = self.session.run(output_names, input_feed, run_options)
                return outputs

            outputs = self.session.run(output_names, input_feed, run_options)
            return outputs

    def _specialize_coreml(self, input_feed: dict[str, NDArray[Any]]) -> None:
        signature = tuple((name, tuple(value.shape)) for name, value in sorted(input_feed.items()))
        if signature == self._coreml_shape:
            return
        native = current_policy()
        if native is None:
            raise RuntimeError("native_backend_requires_fresh_process")
        if self._coreml_shape is not None and native.profile_dir is not None:
            # Keep the complete execution trace for the qualification fixture.
            raise ValueError("native_profile_input_shape_changed")
        if self._coreml_input_shapes is None:
            self._coreml_input_shapes = [(item.name, tuple(item.shape)) for item in self.get_inputs()]
        dimensions: dict[str, int] = {}
        for name, shape in self._coreml_input_shapes:
            actual = input_feed[name].shape
            if len(actual) != len(shape):
                raise ValueError("native_input_shape_conflict")
            for dimension, size in zip(shape, actual, strict=True):
                if isinstance(dimension, str) and dimension:
                    if size <= 0 or dimension in dimensions and dimensions[dimension] != size:
                        raise ValueError("native_input_shape_conflict")
                    dimensions[dimension] = int(size)
        if not dimensions:
            self._coreml_shape = signature
            return
        options = self._sess_options_default
        for dimension, size in dimensions.items():
            options.add_free_dimension_override_by_name(dimension, size)
        if native.profile_dir is not None:
            options.enable_profiling = True
            options.profile_file_prefix = str(native.profile_dir / f"native-{uuid4().hex}")
        cache_root = runtime_cache_dir(self.model_path) / "coreml"
        cache_root.mkdir(parents=True, exist_ok=True)
        cache = TemporaryDirectory(prefix="shape-", dir=cache_root)
        providers = [dict(value) for value in self.provider_options]
        for provider, value in zip(self.providers, providers, strict=True):
            if provider == "CoreMLExecutionProvider":
                value["ModelCacheDirectory"] = cache.name
        try:
            session = ort.InferenceSession(
                self.model_path.as_posix(),
                providers=self.providers,
                provider_options=providers,
                sess_options=options,
            )
            session.disable_fallback()
            if "CoreMLExecutionProvider" not in session.get_providers():
                raise RuntimeError("native_provider_not_loaded")
            if native.profile_dir is not None:
                self.session.end_profiling()
        except BaseException:
            cache.cleanup()
            raise
        previous_cache = self._coreml_cache
        self.session, self.sess_options = session, options
        self._coreml_cache, self._coreml_shape = cache, signature
        if previous_cache is not None:
            previous_cache.cleanup()

    @property
    def providers(self) -> list[str]:
        return self._providers

    @providers.setter
    def providers(self, providers: list[str]) -> None:
        log.info(f"Setting execution providers to {providers}, in descending order of preference")
        self._providers = providers

    @property
    def _providers_default(self) -> list[str]:
        available_providers = set(ort.get_available_providers())
        log.debug(f"Available ORT providers: {available_providers}")
        return [provider for provider in SUPPORTED_PROVIDERS if provider in available_providers]

    @property
    def provider_options(self) -> list[dict[str, Any]]:
        return self._provider_options

    @provider_options.setter
    def provider_options(self, provider_options: list[dict[str, Any]]) -> None:
        log.debug(f"Setting execution provider options to {provider_options}")
        self._provider_options = provider_options

    @property
    def _provider_options_default(self) -> list[dict[str, Any]]:
        native = current_policy() is not None
        provider_options = []
        for provider in self.providers:
            match provider:
                case "CPUExecutionProvider":
                    options = {"arena_extend_strategy": "kSameAsRequested"}
                case "CUDAExecutionProvider":
                    options = {"arena_extend_strategy": "kSameAsRequested", "device_id": settings.device_id}
                case "MIGraphXExecutionProvider":
                    migraphx_dir = runtime_cache_dir(self.model_path) / "migraphx"
                    # MIGraphX does not create the underlying folder and will crash if it does not exist
                    migraphx_dir.mkdir(parents=True, exist_ok=True)
                    options = {
                        "device_id": settings.device_id,
                        "migraphx_model_cache_dir": migraphx_dir.as_posix(),
                        "migraphx_fp16_enable": "1" if settings.rocm_precision == ModelPrecision.FP16 else "0",
                    }
                case "OpenVINOExecutionProvider":
                    device_ids: list[str] = ort.capi._pybind_state.get_available_openvino_device_ids()
                    device_type = _get_openvino_device_type(device_ids, self.device_id or settings.device_id)
                    options = {
                        "device_type": device_type,
                        "precision": settings.openvino_precision.value,
                        "cache_dir": (runtime_cache_dir(self.model_path) / "openvino").as_posix(),
                    }
                case "CoreMLExecutionProvider":
                    # Native fixtures need float32 accuracy without the expensive prediction specialization.
                    options = {
                        "ModelFormat": "MLProgram",
                        "MLComputeUnits": "CPUAndGPU" if native else "ALL",
                        "SpecializationStrategy": "Default" if native else "FastPrediction",
                        "AllowLowPrecisionAccumulationOnGPU": "0" if native else "1",
                        "ModelCacheDirectory": (runtime_cache_dir(self.model_path) / "coreml").as_posix(),
                    }
                case _:
                    options = {}
            provider_options.append(options)
        return provider_options

    @property
    def sess_options(self) -> ort.SessionOptions:
        return self._sess_options

    @sess_options.setter
    def sess_options(self, sess_options: ort.SessionOptions) -> None:
        log.debug(f"Setting execution_mode to {sess_options.execution_mode.name}")
        log.debug(f"Setting inter_op_num_threads to {sess_options.inter_op_num_threads}")
        log.debug(f"Setting intra_op_num_threads to {sess_options.intra_op_num_threads}")
        self._sess_options = sess_options

    @property
    def _sess_options_default(self) -> ort.SessionOptions:
        sess_options = ort.SessionOptions()
        sess_options.enable_cpu_mem_arena = settings.model_arena

        # avoid thread contention between models
        # Set inter_op threads
        if settings.model_inter_op_threads > 0:
            sess_options.inter_op_num_threads = settings.model_inter_op_threads
        # these defaults work well for CPU, but bottleneck GPU
        elif settings.model_inter_op_threads == 0 and self.providers == ["CPUExecutionProvider"]:
            sess_options.inter_op_num_threads = 1

        # Set intra_op threads
        if settings.model_intra_op_threads > 0:
            sess_options.intra_op_num_threads = settings.model_intra_op_threads
        elif settings.model_intra_op_threads == 0 and self.providers == ["CPUExecutionProvider"]:
            sess_options.intra_op_num_threads = 2

        if sess_options.inter_op_num_threads > 1:
            sess_options.execution_mode = ort.ExecutionMode.ORT_PARALLEL

        return sess_options
