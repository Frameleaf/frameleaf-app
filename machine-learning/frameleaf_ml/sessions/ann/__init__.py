from __future__ import annotations

from pathlib import Path
from typing import Any, NamedTuple

import numpy as np
from numpy.typing import NDArray

from frameleaf_ml.config import log, settings
from frameleaf_ml.schemas import SessionNode
from frameleaf_ml.sessions import runtime_cache_dir

from .loader import Ann


class AnnSession:
    """
    Wrapper for ANN to be drop-in replacement for ONNX session.
    """

    def __init__(self, model_path: Path, cache_dir: Path = settings.cache_folder) -> None:
        self.model_path = model_path
        self.cache_dir = runtime_cache_dir(model_path) if not settings.model_downloads else cache_dir
        cached_network_path = model_path.with_suffix(".anncache")
        if not settings.model_downloads:
            cached_network_path = self.cache_dir / cached_network_path.name
        self.ann = Ann(
            tuning_level=settings.ann_tuning_level, tuning_file=(self.cache_dir / "gpu-tuning.ann").as_posix()
        )

        log.info("Loading ANN model %s ...", model_path)
        self.model = self.ann.load(
            model_path.as_posix(),
            cached_network_path=cached_network_path.as_posix(),
            fp16=settings.ann_fp16_turbo,
        )
        log.info("Loaded ANN model with ID %d", self.model)

    def __del__(self) -> None:
        ann = getattr(self, "ann", None)
        if ann is None:
            return
        del self.ann
        try:
            model = getattr(self, "model", None)
            if model is not None:
                ann.unload(model)
                log.info("Unloaded ANN model %d", model)
        finally:
            ann.destroy()

    def get_inputs(self) -> list[SessionNode]:
        shapes = self.ann.input_shapes[self.model]
        return [AnnNode(f"input.{i + 1}", s) for i, s in enumerate(shapes)]

    def get_outputs(self) -> list[SessionNode]:
        shapes = self.ann.output_shapes[self.model]
        return [AnnNode(f"output.{i + 1}", s) for i, s in enumerate(shapes)]

    def get_metadata(self) -> dict[str, str]:
        return {}

    def run(
        self,
        output_names: list[str] | None,
        input_feed: dict[str, NDArray[np.float32]] | dict[str, NDArray[np.int32]] | dict[str, NDArray[np.uint8]],
        run_options: Any = None,
    ) -> list[NDArray[np.float32]]:
        inputs: list[NDArray[np.float32]] = [np.ascontiguousarray(v) for v in input_feed.values()]
        return self.ann.execute(self.model, inputs)


class AnnNode(NamedTuple):
    name: str
    shape: tuple[int, ...]
