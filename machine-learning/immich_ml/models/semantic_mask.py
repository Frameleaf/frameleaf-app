from __future__ import annotations

import base64
import io
import json
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any, ClassVar, cast

import numpy as np
from huggingface_hub import snapshot_download
from huggingface_hub.errors import LocalEntryNotFoundError
from PIL import Image

from immich_ml.config import settings
from immich_ml.models.base import InferenceModel, ModelUnavailableError
from immich_ml.models.semantic_mask_manifest import bounded_boxes, verify_snapshot
from immich_ml.schemas import ModelIdentity, ModelTask, ModelType

MODEL_NAME = "frameleaf-florence2-sam2.1"
MANIFEST = json.loads(Path(__file__).with_name("semantic-mask-models.json").read_text())


class SemanticMaskModel(InferenceModel):
    """Native, offline Florence-2 proposals refined by SAM2.1; no model Python/pickle is loaded."""

    depends: ClassVar[list[ModelIdentity]] = []
    identity = (ModelType.VISUAL, ModelTask.SEMANTIC_MASK)

    def __init__(self, model_name: str, **kwargs: Any) -> None:
        if model_name != MODEL_NAME:
            raise ModelUnavailableError("Only the pinned semantic-mask model is supported")
        self.device_name = kwargs.get("device") or settings.semantic_mask_device
        if self.device_name not in {"cpu", "cuda", "auto"}:
            raise ValueError("Semantic masks require cpu, cuda or auto")
        self._inference_lock = threading.Lock()
        super().__init__(model_name, **kwargs)

    @property
    def cached(self) -> bool:
        # load verifies pinned snapshots itself. Never let the base class download a generic ONNX model.
        return True

    def _load(self) -> Any:
        try:
            import torch
            from transformers import Florence2ForConditionalGeneration, Florence2Processor, Sam2Model, Sam2Processor
        except ImportError as error:
            raise ModelUnavailableError("Semantic masks require the existing Torch/Transformers ML runtime") from error
        paths = []
        for model in MANIFEST:
            try:
                path = Path(
                    snapshot_download(
                        model["repository"],
                        revision=model["revision"],
                        cache_dir=self.cache_dir / "hub",
                        local_files_only=True,
                    )
                )
                verify_snapshot(path, model["files"])
            except (OSError, ValueError, LocalEntryNotFoundError) as error:
                raise ModelUnavailableError(
                    "Pinned semantic model snapshots are absent or unverified; preload them locally"
                ) from error
            paths.append(path)
        if self.device_name == "auto":
            self.device_name = "cuda" if torch.cuda.is_available() else "cpu"
        if self.device_name == "cuda" and not torch.cuda.is_available():
            raise ModelUnavailableError("CUDA was requested but is unavailable")
        self.florence_processor = Florence2Processor.from_pretrained(
            paths[0], local_files_only=True, trust_remote_code=False
        )
        self.florence = Florence2ForConditionalGeneration.from_pretrained(
            paths[0], use_safetensors=True, local_files_only=True, trust_remote_code=False
        )
        # Pin boundaries to these dynamic vendor methods, not to the entire model's type.
        cast(Callable[[str], object], getattr(self.florence, "to"))(self.device_name)
        cast(Callable[[], object], getattr(self.florence, "eval"))()
        self.sam_processor = Sam2Processor.from_pretrained(paths[1], local_files_only=True, trust_remote_code=False)
        self.sam = Sam2Model.from_pretrained(
            paths[1], use_safetensors=True, local_files_only=True, trust_remote_code=False
        )
        cast(Callable[[str], object], getattr(self.sam, "to"))(self.device_name)
        cast(Callable[[], object], getattr(self.sam, "eval"))()
        return None

    def _predict(self, image: Image.Image, target: str = "subject", **kwargs: Any) -> dict[str, Any]:
        import torch

        if target not in {"subject", "sky"}:
            raise ValueError("Unknown semantic target")
        if image.width <= 0 or image.height <= 0 or max(image.size) > 2048:
            raise ValueError("Semantic mask canvas must have an edge of at most 2048 pixels")
        image = image.convert("RGB")
        with self._inference_lock, torch.inference_mode():
            task = "<CAPTION_TO_PHRASE_GROUNDING>"
            phrase = "sky" if target == "sky" else "the main foreground subject"
            inputs = self.florence_processor(text=task + phrase, images=image, return_tensors="pt").to(self.device_name)
            # The mixin's self annotation excludes Florence despite its supported runtime inheritance.
            generate = cast(Callable[..., object], getattr(self.florence, "generate"))
            generated = generate(**inputs, max_new_tokens=512, num_beams=1, do_sample=False)
            # These vendor processor methods are unannotated in the pinned Transformers release.
            decode = cast(Callable[..., list[str]], self.florence_processor.batch_decode)
            text = decode(generated, skip_special_tokens=False)[0]
            proposal = self.florence_processor.post_process_generation(text, task=task, image_size=image.size)
            boxes = bounded_boxes(proposal.get(task, {}).get("bboxes"), image.width, image.height)
            if not boxes:
                raise ValueError("No subject or sky proposal found; draw a manual mask")
            inputs = self.sam_processor(images=image, input_boxes=[boxes], return_tensors="pt").to(self.device_name)
            output = self.sam(**inputs, multimask_output=False)
            post_process = cast(Callable[..., list[torch.Tensor]], self.sam_processor.post_process_masks)
            masks = post_process(output.pred_masks.cpu(), inputs["original_sizes"])[0]
            pixels = masks.numpy().astype(bool).reshape(-1, image.height, image.width).any(axis=0)
            if not pixels.any():
                raise ValueError("Empty semantic proposal; draw a manual mask")
            png = io.BytesIO()
            Image.fromarray(np.where(pixels, 255, 0).astype(np.uint8), mode="L").save(png, format="PNG")
            return {
                "png": base64.b64encode(png.getvalue()).decode(),
                "width": image.width,
                "height": image.height,
                "target": target,
                "coordinates": "sensor-active",
                "models": [{"repository": model["repository"], "revision": model["revision"]} for model in MANIFEST],
            }
