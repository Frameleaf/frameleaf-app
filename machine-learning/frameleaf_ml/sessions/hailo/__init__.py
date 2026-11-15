"""FL-1004 proof of concept, not for merge: a ModelSession that runs a compiled Hailo HEF through HailoRT.

It mirrors the RKNN session: the model's ONNX stays the identity in the mirror, and a device-specific compiled
file (`hailo/<arch>/model.hef`, arch = hailo8, hailo8l or hailo10h) sits beside it. HailoRT (`hailo_platform`,
MIT) is imported lazily, so images without it are unaffected. Untested on hardware: no Hailo device or
Dataflow Compiler licence was available (see the findings note on FL-1004).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, NamedTuple

import numpy as np
from numpy.typing import NDArray

from frameleaf_ml.config import log
from frameleaf_ml.schemas import SessionNode

TIMEOUT_MS = 10_000


def device_arch() -> str | None:
    """The Hailo architecture of the first device, or None without HailoRT or a device (/dev/hailo0)."""
    if not Path("/dev/hailo0").exists():
        return None
    try:
        from hailo_platform import Device

        identity = Device().control.identify()
        return str(identity.device_architecture).lower().replace("_", "")
    except Exception as error:
        log.info(f"Hailo: device present but not usable: {error}")
        return None


class HailoNode(NamedTuple):
    name: str
    shape: tuple[int, ...]


class HailoSession:
    def __init__(self, model_path: Path) -> None:
        from hailo_platform import FormatType, VDevice

        self.model_path = model_path
        self._vdevice = VDevice()
        model = self._vdevice.create_infer_model(model_path.as_posix())
        # Ask HailoRT to (de)quantize on the host: the callers pass and expect float32, as with ONNX Runtime.
        model.input().set_format_type(FormatType.FLOAT32)
        for output in model.outputs:
            output.set_format_type(FormatType.FLOAT32)
        self._inputs = [HailoNode(i.name, tuple(i.shape)) for i in model.inputs]
        self._outputs = [HailoNode(o.name, tuple(o.shape)) for o in model.outputs]
        self._configured = model.configure()
        log.info(f"Hailo: loaded {model_path} with inputs {self._inputs} and outputs {self._outputs}")

    def get_inputs(self) -> list[SessionNode]:
        return list(self._inputs)

    def get_outputs(self) -> list[SessionNode]:
        return list(self._outputs)

    def get_metadata(self) -> dict[str, str]:
        return {}

    def run(
        self,
        output_names: list[str] | None,
        input_feed: dict[str, NDArray[np.float32]] | dict[str, NDArray[np.int32]] | dict[str, NDArray[np.uint8]],
        run_options: Any = None,
    ) -> list[NDArray[np.float32]]:
        (value,) = input_feed.values()
        results: list[list[NDArray[np.float32]]] = []
        # HEFs are compiled with a batch of one and NHWC input; the callers pass NCHW batches.
        for item in np.asarray(value, dtype=np.float32):
            buffers = {o.name: np.empty(o.shape, dtype=np.float32) for o in self._outputs}
            bindings = self._configured.create_bindings(output_buffers=buffers)
            bindings.input().set_buffer(np.ascontiguousarray(item.transpose(1, 2, 0)))
            self._configured.run([bindings], TIMEOUT_MS)
            results.append([bindings.output(o.name).get_buffer() for o in self._outputs])
        names = output_names or [o.name for o in self._outputs]
        index = {o.name: i for i, o in enumerate(self._outputs)}
        return [np.stack([r[index[name]] for r in results]) for name in names]


__all__ = ["HailoSession", "HailoNode", "device_arch"]
