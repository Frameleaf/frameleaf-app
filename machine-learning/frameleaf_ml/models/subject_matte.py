"""Cut out the subject in a video (FL-639): one subject followed through a clip with SAM2.1 video.

The server sends a clip's frames (at most `MAX_FRAMES`, each at most `MAX_EDGE` pixels a side, in
order) and how to find the subject on the first frame:

- `seedKind: "face"` with `seedBox`, the chosen person's face from the library's face recognition, as
  fractions of the frame. Florence-2 proposes the people in the first frame and the one around that
  face is the subject; without a proposal the face box is grown to a head-and-shoulders box.
- `seedKind: "subject"` ("Main subject"): Florence-2's box for the main foreground subject.

That box seeds SAM2.1's video predictor (the transformers `Sam2Video` model, loaded from the same pinned
`sam2.1-hiera-small` snapshot as photo masks), which follows the subject frame by frame in streaming
mode, so memory stays bounded by one frame. "Add to subject" and "Take away" arrive as `points`: a
frame index, a position (fractions of the frame) and whether it adds (1) or takes away (0); each is
added to the prediction on its own frame and followed from there on.

The answer is a stream (`stream()`): a `frame` item per frame with that frame's matte as a grayscale
PNG at `matteWidth` x `matteHeight` (255 is the subject, soft at the edges), with progress counts.
No media leaves the worker, and no model is downloaded: the pinned snapshots are read as for
`semantic-mask`.
"""

from __future__ import annotations

import base64
import io
import threading
from collections.abc import Callable, Generator, Sequence
from pathlib import Path
from typing import Any, ClassVar, Literal, cast

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from frameleaf_ml.config import settings
from frameleaf_ml.models.base import InferenceModel, ModelUnavailableError
from frameleaf_ml.models.semantic_mask import MODEL_NAME, pinned_snapshot_paths, resolve_device
from frameleaf_ml.models.semantic_mask_manifest import bounded_boxes
from frameleaf_ml.schemas import ModelIdentity, ModelTask, ModelType

# Bounds the server keeps to; the worker refuses anything beyond them.
MAX_FRAMES = 600
MAX_EDGE = 1024
MAX_MATTE_EDGE = 512
MAX_POINTS = 64

SeedKind = Literal["face", "subject"]


def clamp_box(box: Sequence[float], width: int, height: int) -> list[float] | None:
    """A pixel box clipped to the frame, or None when nothing of it is left."""
    x1, y1, x2, y2 = (float(value) for value in box)
    x1, x2 = max(0.0, min(x1, width)), max(0.0, min(x2, width))
    y1, y2 = max(0.0, min(y1, height)), max(0.0, min(y2, height))
    return [x1, y1, x2, y2] if x2 - x1 >= 1 and y2 - y1 >= 1 else None


def fraction_box(box: Sequence[float], width: int, height: int) -> list[float] | None:
    """A box given as fractions of the frame, in pixels of a `width` x `height` frame."""
    if len(box) != 4 or not all(np.isfinite(value) for value in box):
        return None
    x1, y1, x2, y2 = box
    if x1 >= x2 or y1 >= y2:
        return None
    return clamp_box([x1 * width, y1 * height, x2 * width, y2 * height], width, height)


def grow_face_box(face: Sequence[float], width: int, height: int) -> list[float] | None:
    """Head and shoulders around a face box: three faces wide, from just above the head to six faces down."""
    x1, y1, x2, y2 = face
    size_x, size_y = x2 - x1, y2 - y1
    centre = (x1 + x2) / 2
    return clamp_box([centre - 1.5 * size_x, y1 - 0.4 * size_y, centre + 1.5 * size_x, y2 + 6 * size_y], width, height)


def pick_person_box(people: Sequence[Sequence[float]], face: Sequence[float]) -> list[float] | None:
    """Of the people proposed, the smallest one around the face's centre that is bigger than the face."""
    cx, cy = (face[0] + face[2]) / 2, (face[1] + face[3]) / 2
    face_area = (face[2] - face[0]) * (face[3] - face[1])
    around = [
        list(box)
        for box in people
        if box[0] <= cx <= box[2] and box[1] <= cy <= box[3] and (box[2] - box[0]) * (box[3] - box[1]) > face_area
    ]
    return min(around, key=lambda box: (box[2] - box[0]) * (box[3] - box[1])) if around else None


def pick_subject_box(proposals: Sequence[Sequence[float]], width: int, height: int) -> list[float] | None:
    """The largest proposal for the main subject, which Florence lists in no useful order."""
    boxes = bounded_boxes([list(box) for box in proposals], width, height)
    return max(boxes, key=lambda box: (box[2] - box[0]) * (box[3] - box[1])) if boxes else None


def prompt_points(
    points: Sequence[dict[str, Any]], frames: int, width: int, height: int
) -> dict[int, tuple[list[list[float]], list[int]]]:
    """Refinement points grouped by frame, in pixels; points outside the clip or the frame are dropped."""
    grouped: dict[int, tuple[list[list[float]], list[int]]] = {}
    for point in points[:MAX_POINTS]:
        frame, x, y, label = point["frame"], point["x"], point["y"], point["label"]
        if not 0 <= frame < frames or not (0 <= x <= 1 and 0 <= y <= 1) or label not in (0, 1):
            continue
        coordinates, labels = grouped.setdefault(frame, ([], []))
        coordinates.append([x * width, y * height])
        labels.append(label)
    return grouped


def matte_png(probability: NDArray[np.float32], width: int, height: int) -> str:
    """One frame's subject probability (0..1, frame-sized) as a base64 grayscale PNG at the matte size.

    Downscaling by area keeps the edge soft instead of stair-stepped.
    """
    pixels = np.clip(np.nan_to_num(probability, nan=0.0) * 255.0, 0, 255).astype(np.uint8)
    image = Image.fromarray(pixels, mode="L")
    if image.size != (width, height):
        image = image.resize((width, height), Image.Resampling.BOX)
    png = io.BytesIO()
    image.save(png, format="PNG", optimize=True)
    return base64.b64encode(png.getvalue()).decode("ascii")


def check_frames(frames: Sequence[Image.Image]) -> tuple[int, int]:
    """Every frame the same size and within the bounds; answers that size."""
    if not 1 <= len(frames) <= MAX_FRAMES:
        raise ValueError(f"A cut-out needs between 1 and {MAX_FRAMES} frames")
    width, height = frames[0].size
    if width <= 0 or height <= 0 or max(width, height) > MAX_EDGE:
        raise ValueError(f"Cut-out frames must have an edge of at most {MAX_EDGE} pixels")
    if any(frame.size != (width, height) for frame in frames):
        raise ValueError("Every cut-out frame must be the same size")
    return width, height


def sigmoid(values: NDArray[np.float32]) -> NDArray[np.float32]:
    return cast(NDArray[np.float32], 1.0 / (1.0 + np.exp(-np.clip(values, -60.0, 60.0))))


class SubjectMatteModel(InferenceModel):
    """Florence-2 finds the subject on the first frame; SAM2.1 video follows it through the clip."""

    depends: ClassVar[list[ModelIdentity]] = []
    identity = (ModelType.VISUAL, ModelTask.SUBJECT_MATTE)

    def __init__(self, model_name: str, **kwargs: Any) -> None:
        if model_name != MODEL_NAME:
            raise ModelUnavailableError("Only the pinned Florence-2 + SAM2.1 model is supported")
        self.device_name = kwargs.pop("device", None) or settings.semantic_mask_device
        if self.device_name not in {"cpu", "cuda", "auto"}:
            raise ValueError("Cut-outs require cpu, cuda or auto")
        self._inference_lock = threading.Lock()
        # The same pre-provisioned snapshots as photo masks: one copy of the weights on disk.
        kwargs.setdefault("cache_dir", settings.cache_folder / ModelTask.SEMANTIC_MASK.value / MODEL_NAME)
        super().__init__(model_name, **kwargs)

    @property
    def cached(self) -> bool:
        # load verifies the pinned snapshots itself; never let the base class download anything.
        return True

    def _load(self) -> Any:
        try:
            import torch
            from transformers import (
                Florence2ForConditionalGeneration,
                Florence2Processor,
                Sam2VideoModel,
                Sam2VideoProcessor,
            )
        except ImportError as error:
            raise ModelUnavailableError("Cut-outs require the existing Torch/Transformers ML runtime") from error
        paths = pinned_snapshot_paths(Path(self.cache_dir))
        self.device_name = resolve_device(torch, self.device_name)
        self.florence_processor = Florence2Processor.from_pretrained(
            paths[0], local_files_only=True, trust_remote_code=False
        )
        self.florence = Florence2ForConditionalGeneration.from_pretrained(
            paths[0], use_safetensors=True, local_files_only=True, trust_remote_code=False
        )
        cast(Callable[[str], object], getattr(self.florence, "to"))(self.device_name)
        cast(Callable[[], object], getattr(self.florence, "eval"))()
        # The sam2.1-hiera-small snapshot carries the video preprocessor config the video model reads.
        self.video_processor = Sam2VideoProcessor.from_pretrained(
            paths[1], local_files_only=True, trust_remote_code=False
        )
        self.video_model = Sam2VideoModel.from_pretrained(
            paths[1], use_safetensors=True, local_files_only=True, trust_remote_code=False
        )
        cast(Callable[[str], object], getattr(self.video_model, "to"))(self.device_name)
        cast(Callable[[], object], getattr(self.video_model, "eval"))()
        return None

    def _predict(self, *inputs: Any, **kwargs: Any) -> Any:
        raise ValueError("Cut-outs are a stream of frames; use /subject-matte")

    def propose(self, image: Image.Image, phrase: str) -> list[list[float]]:
        """Florence-2 phrase grounding: boxes for `phrase` in `image`, in pixels."""
        task = "<CAPTION_TO_PHRASE_GROUNDING>"
        inputs = self.florence_processor(text=task + phrase, images=image, return_tensors="pt").to(self.device_name)
        generate = cast(Callable[..., object], getattr(self.florence, "generate"))
        generated = generate(**inputs, max_new_tokens=512, num_beams=1, do_sample=False)
        decode = cast(Callable[..., list[str]], self.florence_processor.batch_decode)
        text = decode(generated, skip_special_tokens=False)[0]
        proposal = self.florence_processor.post_process_generation(text, task=task, image_size=image.size)
        return bounded_boxes(proposal.get(task, {}).get("bboxes"), image.width, image.height)

    def seed_box(self, image: Image.Image, kind: SeedKind, seed: Sequence[float] | None) -> list[float]:
        """The subject's box on the first frame, in pixels."""
        width, height = image.size
        if kind == "face":
            face = fraction_box(seed or [], width, height)
            if face is None:
                raise ValueError("A person cut-out needs the person's face box")
            return pick_person_box(self.propose(image, "person"), face) or grow_face_box(face, width, height) or face
        box = pick_subject_box(self.propose(image, "the main foreground subject"), width, height)
        if box is None:
            raise ValueError("No subject found in the first frame")
        return box

    def stream(
        self,
        frames: Sequence[Image.Image],
        *,
        seedKind: SeedKind = "subject",
        seedBox: Sequence[float] | None = None,
        points: Sequence[dict[str, Any]] = (),
        matteWidth: int = 256,
        matteHeight: int = 256,
        **_: Any,
    ) -> Generator[dict[str, Any], None, None]:
        """`progress` and `frame` items, one `frame` per input frame in order."""
        import torch

        width, height = check_frames(frames)
        if not (1 <= matteWidth <= MAX_MATTE_EDGE and 1 <= matteHeight <= MAX_MATTE_EDGE):
            raise ValueError(f"A matte has an edge of at most {MAX_MATTE_EDGE} pixels")
        rgb = [frame.convert("RGB") for frame in frames]
        total = len(rgb)
        with self._inference_lock, torch.inference_mode():
            box = self.seed_box(rgb[0], seedKind, seedBox)
            refinements = prompt_points(points, total, width, height)
            yield {"type": "progress", "done": 0, "total": total, "seedBox": [round(value, 2) for value in box]}
            for index, probability in self.follow(rgb, box, refinements):
                yield {"type": "frame", "index": index, "png": matte_png(probability, matteWidth, matteHeight)}
                yield {"type": "progress", "done": index + 1, "total": total}

    def follow(
        self,
        frames: Sequence[Image.Image],
        box: Sequence[float],
        refinements: dict[int, tuple[list[list[float]], list[int]]],
    ) -> Generator[tuple[int, NDArray[np.float32]], None, None]:
        """SAM2 video in streaming mode: the subject's probability on each frame, frame by frame."""
        processor, model = self.video_processor, self.video_model
        session = processor.init_video_session(inference_device=self.device_name, dtype=_float32())
        for index, frame in enumerate(frames):
            inputs = processor(images=frame, device=self.device_name, return_tensors="pt")
            original_size = inputs["original_sizes"][0]
            if index == 0:
                processor.add_inputs_to_inference_session(
                    inference_session=session,
                    frame_idx=0,
                    obj_ids=1,
                    input_boxes=[[list(box)]],
                    original_size=original_size,
                )
            if index in refinements:
                coordinates, labels = refinements[index]
                processor.add_inputs_to_inference_session(
                    inference_session=session,
                    frame_idx=index,
                    obj_ids=1,
                    input_points=[[coordinates]],
                    input_labels=[[labels]],
                    original_size=original_size,
                    clear_old_inputs=False,
                )
            output = model(inference_session=session, frame=inputs["pixel_values"][0])
            post_process = cast(Callable[..., list[Any]], processor.post_process_masks)
            logits = post_process([output.pred_masks], original_sizes=inputs["original_sizes"], binarize=False)[0]
            values = np.asarray(logits.float().cpu().numpy(), dtype=np.float32).reshape(-1, *logits.shape[-2:])
            yield index, sigmoid(values.max(axis=0))


def _float32() -> Any:
    import torch

    return torch.float32
