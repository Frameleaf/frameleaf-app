"""Clean Up Remove fills: LaMa (big-lama, Apache-2.0) inpainting through ONNX Runtime.

The server sends an RGB PNG of the area plus its context (at most 1,024 pixels a side) and a greyscale
mask of the same size, 255 where content is removed. The model sees both at its fixed input size; its
fill is scaled back and blended into the original through the mask, so unmasked pixels come back
unchanged and a feathered mask edge stays feathered. The answer is `{png, width, height}`, an RGB PNG
the same size as the input (docs/docs/features/develop-recipe-protocol.md).
"""

from __future__ import annotations

import base64
import hashlib
import io
from typing import Any

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from immich_ml.config import model_source_url
from immich_ml.models.base import MODEL_SOURCE_ORG, InferenceModel
from immich_ml.models.constants import get_inpaint_model_file
from immich_ml.schemas import ModelFormat, ModelSession, ModelTask, ModelType
from immich_ml.sessions.ort import OrtSession

# The server never sends more than 1,024 pixels a side; anything far larger is not a fill request.
MAX_EDGE = 4096
# big-lama's ONNX export has a fixed 512 x 512 input; used when a model reports a dynamic size.
DEFAULT_SIZE = 512


class InpaintModel(InferenceModel):
    depends = []
    identity = (ModelType.VISUAL, ModelTask.INPAINT)

    def __init__(self, model_name: str, **model_kwargs: Any) -> None:
        super().__init__(model_name, **model_kwargs, model_format=ModelFormat.ONNX)

    def _download(self) -> None:
        source = get_inpaint_model_file(self.model_name)
        if source is None:
            # An unknown name is a missing model (503), never a generic download from the source.
            raise self._unavailable(
                f"{MODEL_SOURCE_ORG}/{self.model_name}", model_source_url(), "is not an inpainting model"
            )
        repo_id = f"{MODEL_SOURCE_ORG}/{source.repo}"
        self._download_from_source(source.repo, allow_patterns=[f"{self.model_type.value}/*"])
        if not self.model_path.is_file():
            raise self._unavailable(repo_id, model_source_url(), reason=f"has no {self.model_type.value}/model.onnx")
        digest = hashlib.sha256()
        with self.model_path.open("rb") as file:
            for chunk in iter(lambda: file.read(1 << 20), b""):
                digest.update(chunk)
        if digest.hexdigest() != source.sha256:
            self.model_path.unlink()
            raise self._unavailable(repo_id, model_source_url(), reason="failed its checksum")

    def _load(self) -> ModelSession:
        session = OrtSession(self.model_path)
        inputs = session.get_inputs()
        names = [node.name for node in inputs]
        self.mask_input = next((name for name in names if "mask" in name.lower()), names[-1])
        self.image_input = next(name for name in names if name != self.mask_input)
        shape = next(node.shape for node in inputs if node.name == self.image_input)
        height, width = shape[-2], shape[-1]
        self.size = (
            (int(width), int(height))
            if isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0
            else (DEFAULT_SIZE, DEFAULT_SIZE)
        )
        return session

    def _predict(self, image: Image.Image, mask: Image.Image | None = None, **kwargs: Any) -> dict[str, Any]:
        if mask is None:
            raise ValueError("Inpainting needs a mask")
        if image.width <= 0 or image.height <= 0 or max(image.size) > MAX_EDGE:
            raise ValueError(f"Inpainting needs an image of at most {MAX_EDGE} pixels a side")
        if mask.size != image.size:
            raise ValueError("The mask must be the same size as the image")
        image = image.convert("RGB")
        alpha = mask.convert("L")
        if alpha.getextrema()[1] == 0:
            # Nothing to remove: the fill is the image itself.
            return self._encode(image)

        filled = self._fill(image, alpha)
        return self._encode(Image.composite(filled, image, alpha))

    def _fill(self, image: Image.Image, alpha: Image.Image) -> Image.Image:
        """The model's fill for the whole image, scaled back to the image's size."""
        pixels = np.asarray(image.resize(self.size, Image.Resampling.BICUBIC), dtype=np.float32) / 255.0
        # Bilinear then "any coverage" keeps thin strokes that a nearest-neighbour downscale would drop.
        coverage = np.asarray(alpha.resize(self.size, Image.Resampling.BILINEAR), dtype=np.uint8) > 0
        feed: dict[str, NDArray[np.float32]] = {
            self.image_input: np.ascontiguousarray(pixels.transpose(2, 0, 1)[None]),
            self.mask_input: coverage.astype(np.float32)[None, None],
        }
        output = np.asarray(self.session.run(None, feed)[0], dtype=np.float32)[0]
        # big-lama answers in 0..255; an export that answers in 0..1 is scaled up.
        if float(output.max(initial=0.0)) <= 1.0:
            output = output * 255.0
        rgb = np.clip(output.transpose(1, 2, 0), 0, 255).round().astype(np.uint8)
        return Image.fromarray(rgb, mode="RGB").resize(image.size, Image.Resampling.BICUBIC)

    @staticmethod
    def _encode(image: Image.Image) -> dict[str, Any]:
        png = io.BytesIO()
        image.save(png, format="PNG")
        return {"png": base64.b64encode(png.getvalue()).decode(), "width": image.width, "height": image.height}
