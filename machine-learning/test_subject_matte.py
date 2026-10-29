"""Cut out the subject in a video (FL-639).

The propagation test runs the real transformers `Sam2Video` streaming code on a tiny synthetic clip with
a randomly initialised model (no weights are downloaded, so the masks themselves mean nothing): it proves
the seeding, the refinement points and the per-frame matte plumbing, not segmentation quality. Florence-2
is stubbed. Real-weight qualification is listed in README-semantic-mask.md.
"""

import base64
import io
import json
from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError
from pytest_mock import MockerFixture

from frameleaf_ml.models import get_model_class
from frameleaf_ml.models.base import ModelUnavailableError
from frameleaf_ml.models.semantic_mask import MODEL_NAME
from frameleaf_ml.models.subject_matte import (
    SubjectMatteModel,
    check_frames,
    fraction_box,
    grow_face_box,
    matte_png,
    pick_person_box,
    pick_subject_box,
    prompt_points,
)
from frameleaf_ml.schemas import ModelTask, ModelType, validate_options


def synthetic_clip(frames: int = 4, width: int = 64, height: int = 48) -> list[Image.Image]:
    """A white square moving right over a dark background."""
    clip = []
    for index in range(frames):
        pixels = np.full((height, width, 3), 20, dtype=np.uint8)
        pixels[12:32, 8 + index * 6 : 28 + index * 6] = 235
        clip.append(Image.fromarray(pixels))
    return clip


def decode(png: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(png)))


class TestHelpers:
    def test_routes_the_task_to_the_cutout_model(self) -> None:
        assert get_model_class(MODEL_NAME, ModelType.VISUAL, ModelTask.SUBJECT_MATTE) is SubjectMatteModel

    def test_options_are_a_closed_set(self) -> None:
        options = validate_options(
            ModelTask.SUBJECT_MATTE,
            ModelType.VISUAL,
            {
                "seedKind": "face",
                "seedBox": [0.1, 0.1, 0.2, 0.3],
                "points": [{"frame": 2, "x": 0.5, "y": 0.5, "label": 0}],
            },
        )
        assert options["points"] == [{"frame": 2, "x": 0.5, "y": 0.5, "label": 0}]
        assert options["matteWidth"] == 256
        for bad in ({"tempo": 1}, {"seedKind": "dog"}, {"points": [{"frame": 0, "x": 2, "y": 0, "label": 1}]}):
            with pytest.raises(ValidationError):
                validate_options(ModelTask.SUBJECT_MATTE, ModelType.VISUAL, bad)

    def test_a_face_grows_to_head_and_shoulders_inside_the_frame(self) -> None:
        assert grow_face_box([40, 10, 50, 20], 100, 100) == [30.0, 6.0, 60.0, 80.0]
        assert grow_face_box([0, 90, 10, 100], 100, 100) == [0.0, 86.0, 20.0, 100.0]

    def test_the_person_around_the_face_is_the_subject(self) -> None:
        face = [40, 10, 50, 20]
        people = [[0, 0, 20, 90], [30, 5, 70, 95], [20, 0, 90, 99], [42, 12, 48, 18]]
        assert pick_person_box(people, face) == [30, 5, 70, 95]
        assert pick_person_box([[0, 0, 20, 90]], face) is None

    def test_the_main_subject_is_the_largest_valid_proposal(self) -> None:
        assert pick_subject_box([[0, 0, 10, 10], [5, 5, 60, 40], [9, 9, 1, 1]], 64, 48) == [5.0, 5.0, 60.0, 40.0]
        assert pick_subject_box([], 64, 48) is None

    def test_fraction_boxes_and_points_become_pixels(self) -> None:
        assert fraction_box([0.25, 0.5, 0.5, 1.0], 64, 48) == [16.0, 24.0, 32.0, 48.0]
        assert fraction_box([0.5, 0.5, 0.25, 1.0], 64, 48) is None
        grouped = prompt_points(
            [
                {"frame": 1, "x": 0.5, "y": 0.5, "label": 1},
                {"frame": 1, "x": 0.25, "y": 0.0, "label": 0},
                {"frame": 9, "x": 0.5, "y": 0.5, "label": 1},
            ],
            4,
            64,
            48,
        )
        assert grouped == {1: ([[32.0, 24.0], [16.0, 0.0]], [1, 0])}

    def test_a_matte_is_a_soft_grayscale_png_at_the_matte_size(self) -> None:
        probability = np.zeros((48, 64), dtype=np.float32)
        probability[:, :33] = 1.0
        image = decode(matte_png(probability, 16, 12))
        assert image.mode == "L" and image.size == (16, 12)
        values = np.asarray(image)
        assert values[0, 0] == 255 and values[0, 15] == 0
        assert 0 < values[0, 8] < 255

    def test_frames_must_match_and_stay_in_bounds(self) -> None:
        assert check_frames(synthetic_clip(2)) == (64, 48)
        with pytest.raises(ValueError):
            check_frames([])
        with pytest.raises(ValueError):
            check_frames([*synthetic_clip(1), Image.new("RGB", (32, 32))])
        with pytest.raises(ValueError):
            check_frames([Image.new("RGB", (2048, 16))])


def stub_model(tmp_path: Path, mocker: MockerFixture, boxes: list[list[float]]) -> SubjectMatteModel:
    model = SubjectMatteModel(MODEL_NAME, cache_dir=tmp_path)
    mocker.patch.object(model, "propose", return_value=boxes)
    model.loaded = True
    return model


class TestStream:
    def test_follows_the_seeded_subject_and_answers_a_matte_per_frame(
        self, tmp_path: Path, mocker: MockerFixture
    ) -> None:
        model = stub_model(tmp_path, mocker, [[0, 0, 64, 48], [20, 4, 44, 46]])
        seen: dict[str, Any] = {}

        def follow(
            frames: list[Image.Image], box: list[float], refinements: dict[int, Any]
        ) -> Generator[tuple[int, np.ndarray], None, None]:
            seen.update(box=box, refinements=refinements)
            for index, _ in enumerate(frames):
                yield index, np.full((48, 64), index / 4, dtype=np.float32)

        mocker.patch.object(model, "follow", side_effect=follow)
        items = list(
            model.stream(
                synthetic_clip(),
                seedKind="face",
                seedBox=[0.4, 0.2, 0.5, 0.4],
                points=[{"frame": 2, "x": 0.5, "y": 0.5, "label": 0}],
                matteWidth=32,
                matteHeight=24,
            )
        )
        # The face (25.6..32 x 9.6..19.2) sits inside the second, smaller person.
        assert seen["box"] == [20, 4, 44, 46]
        assert seen["refinements"] == {2: ([[32.0, 24.0]], [0])}
        frames = [item for item in items if item["type"] == "frame"]
        assert [item["index"] for item in frames] == [0, 1, 2, 3]
        assert all(decode(item["png"]).size == (32, 24) for item in frames)
        assert items[0] == {"type": "progress", "done": 0, "total": 4, "seedBox": [20, 4, 44, 46]}
        assert items[-1] == {"type": "progress", "done": 4, "total": 4}

    def test_no_subject_on_the_first_frame_is_a_plain_error(self, tmp_path: Path, mocker: MockerFixture) -> None:
        model = stub_model(tmp_path, mocker, [])
        with pytest.raises(ValueError, match="No subject"):
            list(model.stream(synthetic_clip(), seedKind="subject"))

    def test_real_sam2_video_propagation_on_a_tiny_clip(self, tmp_path: Path, mocker: MockerFixture) -> None:
        torch = pytest.importorskip("torch")
        transformers = pytest.importorskip("transformers")
        from transformers.models.sam2.image_processing_sam2 import Sam2ImageProcessor
        from transformers.models.sam2_video.video_processing_sam2_video import Sam2VideoVideoProcessor

        torch.manual_seed(0)
        model = stub_model(tmp_path, mocker, [[8, 12, 28, 32]])
        model.device_name = "cpu"
        # The real streaming video predictor with random weights: no download, meaningless masks.
        model.video_model = transformers.Sam2VideoModel(transformers.Sam2VideoConfig()).eval()
        model.video_processor = transformers.Sam2VideoProcessor(
            image_processor=Sam2ImageProcessor(), video_processor=Sam2VideoVideoProcessor()
        )
        stream = model.stream(
            synthetic_clip(3),
            seedKind="subject",
            points=[{"frame": 1, "x": 0.4, "y": 0.4, "label": 1}, {"frame": 2, "x": 0.9, "y": 0.9, "label": 0}],
            matteWidth=16,
            matteHeight=12,
        )

        # The endpoint advances the stream on whichever pool thread is free: a new thread for every
        # step here, so inference mode must not be carried across a yield.
        def step() -> tuple[dict[str, Any] | None, bool]:
            item = next(stream, None)
            # Checked on the worker thread that ran the step: a leaked mode would stay on here.
            return item, torch.is_inference_mode_enabled()

        items = []
        while True:
            with ThreadPoolExecutor(max_workers=1) as pool:
                item, leaked = pool.submit(step).result()
            assert not leaked
            if item is None:
                break
            items.append(item)
        frames = [item for item in items if item["type"] == "frame"]
        assert [item["index"] for item in frames] == [0, 1, 2]
        for item in frames:
            image = decode(item["png"])
            assert image.mode == "L" and image.size == (16, 12)


def entries(**options: Any) -> str:
    return json.dumps({"subject-matte": {"visual": {"modelName": MODEL_NAME, "options": options}}})


def frame_parts(clip: list[Image.Image]) -> list[tuple[str, tuple[str, bytes, str]]]:
    parts = []
    for index, frame in enumerate(clip):
        jpeg = io.BytesIO()
        frame.save(jpeg, format="JPEG")
        parts.append(("frames", (f"{index}.jpg", jpeg.getvalue(), "image/jpeg")))
    return parts


def lines(body: str) -> list[dict[str, Any]]:
    return [json.loads(line) for line in body.splitlines() if line]


class TestEndpoint:
    @pytest.fixture
    def served(self, tmp_path: Path, mocker: MockerFixture) -> SubjectMatteModel:
        model = stub_model(tmp_path, mocker, [[8, 12, 28, 32]])

        def follow(frames: list[Image.Image], *_: Any) -> Generator[tuple[int, np.ndarray], None, None]:
            for index, _ in enumerate(frames):
                yield index, np.ones((48, 64), dtype=np.float32)

        mocker.patch.object(model, "follow", side_effect=follow)

        async def get(*args: Any, **kwargs: Any) -> SubjectMatteModel:
            assert args[:3] == (MODEL_NAME, ModelType.VISUAL, ModelTask.SUBJECT_MATTE)
            assert "device" not in kwargs
            return model

        mocker.patch("frameleaf_ml.main.model_cache.get", side_effect=get)
        return model

    def test_streams_progress_frames_and_done(self, served: SubjectMatteModel, deployed_app: TestClient) -> None:
        response = deployed_app.post(
            "http://localhost:3003/subject-matte",
            data={"entries": entries(seedKind="subject", matteWidth=16, matteHeight=12)},
            files=frame_parts(synthetic_clip(3)),
        )
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        body = lines(response.text)
        assert body[-1] == {"type": "done"}
        assert [item["index"] for item in body if item["type"] == "frame"] == [0, 1, 2]

    def test_refuses_frames_of_different_sizes(self, served: SubjectMatteModel, deployed_app: TestClient) -> None:
        clip = [*synthetic_clip(1), Image.new("RGB", (32, 32))]
        response = deployed_app.post(
            "http://localhost:3003/subject-matte", data={"entries": entries()}, files=frame_parts(clip)
        )
        assert response.status_code == 400

    def test_refuses_unknown_options_and_other_tasks(self, deployed_app: TestClient) -> None:
        response = deployed_app.post(
            "http://localhost:3003/subject-matte",
            data={"entries": entries(colour="red")},
            files=frame_parts(synthetic_clip(1)),
        )
        assert response.status_code == 422
        response = deployed_app.post(
            "http://localhost:3003/subject-matte",
            data={"entries": json.dumps({"inpaint": {"visual": {"modelName": "frameleaf-inpaint"}}})},
            files=frame_parts(synthetic_clip(1)),
        )
        assert response.status_code == 400

    def test_a_failure_after_the_stream_starts_is_an_error_line(
        self, served: SubjectMatteModel, deployed_app: TestClient, mocker: MockerFixture
    ) -> None:
        mocker.patch.object(served, "propose", return_value=[])
        response = deployed_app.post(
            "http://localhost:3003/subject-matte", data={"entries": entries()}, files=frame_parts(synthetic_clip(2))
        )
        assert lines(response.text)[-1] == {"type": "error", "message": "No subject found in the first frame"}

    def test_a_long_error_is_cut_to_what_the_server_reads(
        self, served: SubjectMatteModel, deployed_app: TestClient, mocker: MockerFixture
    ) -> None:
        mocker.patch.object(served, "propose", side_effect=ValueError("x" * 2000))
        response = deployed_app.post(
            "http://localhost:3003/subject-matte", data={"entries": entries()}, files=frame_parts(synthetic_clip(2))
        )
        last = lines(response.text)[-1]
        assert last["type"] == "error" and len(last["message"]) == 512

    def test_a_worker_without_the_pinned_snapshots_answers_503(
        self, tmp_path: Path, mocker: MockerFixture, deployed_app: TestClient
    ) -> None:
        model = SubjectMatteModel(MODEL_NAME, cache_dir=tmp_path)
        mocker.patch.object(model, "_load", side_effect=ModelUnavailableError("absent"))

        async def get(*args: Any, **kwargs: Any) -> SubjectMatteModel:
            return model

        mocker.patch("frameleaf_ml.main.model_cache.get", side_effect=get)
        response = deployed_app.post(
            "http://localhost:3003/subject-matte", data={"entries": entries()}, files=frame_parts(synthetic_clip(1))
        )
        assert response.status_code == 503
