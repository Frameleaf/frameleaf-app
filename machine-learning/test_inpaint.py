"""Clean Up Remove fills: the `inpaint` task with a tiny stand-in for the LaMa ONNX export."""

import base64
import hashlib
import io
import json
from pathlib import Path
from typing import Any
from unittest import mock

import numpy as np
import onnx
import pytest
from fastapi.testclient import TestClient
from onnx import TensorProto, helper
from PIL import Image
from pytest_mock import MockerFixture

from immich_ml.models import get_model_class
from immich_ml.models.base import ModelUnavailableError
from immich_ml.models.constants import get_inpaint_model_file
from immich_ml.models.inpaint import InpaintModel
from immich_ml.schemas import ModelTask, ModelType, validate_options

FILL = 200.0
SIZE = 8


def tiny_lama(path: Path, size: int = SIZE) -> Path:
    """Same contract as big-lama: `image` (1,3,H,W) in 0..1 and `mask` (1,1,H,W) in {0,1} in, `output` in 0..255
    out. It keeps the image where the mask is 0 and paints FILL where it is 1."""
    image = helper.make_tensor_value_info("image", TensorProto.FLOAT, [1, 3, size, size])
    mask = helper.make_tensor_value_info("mask", TensorProto.FLOAT, [1, 1, size, size])
    output = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3, size, size])
    nodes = [
        helper.make_node("Constant", [], ["one"], value=helper.make_tensor("one", TensorProto.FLOAT, [], [1.0])),
        helper.make_node("Constant", [], ["scale"], value=helper.make_tensor("scale", TensorProto.FLOAT, [], [255.0])),
        helper.make_node("Constant", [], ["fill"], value=helper.make_tensor("fill", TensorProto.FLOAT, [], [FILL])),
        helper.make_node("Sub", ["one", "mask"], ["keep"]),
        helper.make_node("Mul", ["image", "scale"], ["pixels"]),
        helper.make_node("Mul", ["pixels", "keep"], ["kept"]),
        helper.make_node("Mul", ["mask", "fill"], ["painted"]),
        helper.make_node("Add", ["kept", "painted"], ["output"]),
    ]
    graph = helper.make_graph(nodes, "tiny-lama", [image, mask], [output])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    path.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, path)
    return path


def png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def decode(result: dict[str, Any]) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(result["png"])))


@pytest.fixture
def model(tmp_path: Path) -> InpaintModel:
    sut = InpaintModel("frameleaf-inpaint", cache_dir=tmp_path)
    tiny_lama(sut.model_path)
    sut.load()
    return sut


def half_mask(width: int, height: int) -> Image.Image:
    mask = np.zeros((height, width), dtype=np.uint8)
    mask[:, width // 2 :] = 255
    return Image.fromarray(mask, mode="L")


class TestInpaintModel:
    def test_routes_the_inpaint_task_to_lama(self) -> None:
        assert get_model_class("frameleaf-inpaint", ModelType.VISUAL, ModelTask.INPAINT) is InpaintModel

    def test_frameleaf_inpaint_is_pinned_to_the_lama_export(self) -> None:
        source = get_inpaint_model_file("frameleaf-inpaint")
        assert source is not None
        assert source.repo == "frameleaf-inpaint"
        assert source.sha256 == "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6"
        assert "lama_fp32.onnx" in source.source

    def test_server_options_are_accepted_and_others_refused(self) -> None:
        assert validate_options(ModelTask.INPAINT, ModelType.VISUAL, {}) == {}
        with pytest.raises(Exception):
            validate_options(ModelTask.INPAINT, ModelType.VISUAL, {"steps": 4})

    def test_fills_the_masked_area_and_keeps_the_rest(self, model: InpaintModel) -> None:
        image = Image.new("RGB", (40, 30), (10, 20, 30))
        result = model.predict(image, half_mask(40, 30))
        assert (result["width"], result["height"]) == (40, 30)
        out = np.asarray(decode(result).convert("RGB"))
        assert decode(result).mode == "RGB"
        # unmasked pixels come back exactly; masked ones carry the model's fill
        assert (out[:, :18] == (10, 20, 30)).all()
        assert (np.abs(out[:, 22:].astype(int) - int(FILL)) <= 2).all()

    def test_feeds_the_model_its_fixed_size_and_a_binary_mask(self, model: InpaintModel) -> None:
        run = mock.Mock(wraps=model.session.run)
        model.session.run = run  # type: ignore[method-assign]
        thin = np.zeros((300, 300), dtype=np.uint8)
        thin[:, 150] = 128  # a one-pixel feathered stroke survives the downscale
        model.predict(Image.new("RGB", (300, 300)), Image.fromarray(thin, mode="L"))
        feed = run.call_args.args[1]
        assert feed["image"].shape == (1, 3, SIZE, SIZE) and feed["image"].dtype == np.float32
        assert feed["mask"].shape == (1, 1, SIZE, SIZE)
        assert set(np.unique(feed["mask"])) == {0.0, 1.0}

    def test_an_empty_mask_returns_the_image_without_running_the_model(self, model: InpaintModel) -> None:
        model.session.run = mock.Mock()  # type: ignore[method-assign]
        image = Image.new("RGB", (16, 12), (1, 2, 3))
        result = model.predict(image, Image.new("L", (16, 12), 0))
        model.session.run.assert_not_called()
        assert decode(result).getpixel((5, 5)) == (1, 2, 3)

    def test_refuses_a_missing_or_mismatched_mask(self, model: InpaintModel) -> None:
        with pytest.raises(ValueError):
            model.predict(Image.new("RGB", (16, 12)))
        with pytest.raises(ValueError):
            model.predict(Image.new("RGB", (16, 12)), Image.new("L", (12, 16)))


class TestInpaintDownload:
    def test_downloads_the_pinned_file_from_the_model_source(self, tmp_path: Path, mocker: MockerFixture) -> None:
        sut = InpaintModel("frameleaf-inpaint", cache_dir=tmp_path)
        content = b"lama"
        mocker.patch(
            "immich_ml.models.inpaint.get_inpaint_model_file",
            return_value=mock.Mock(repo="frameleaf-inpaint", sha256=hashlib.sha256(content).hexdigest()),
        )

        def fake_download(repo: str, **kwargs: Any) -> None:
            assert repo == "frameleaf-inpaint"
            assert kwargs["allow_patterns"] == ["visual/*"]
            sut.model_path.parent.mkdir(parents=True)
            sut.model_path.write_bytes(content)

        mocker.patch.object(sut, "_download_from_source", side_effect=fake_download)
        sut.download()
        assert sut.model_path == tmp_path / "visual" / "model.onnx"
        assert sut.model_path.read_bytes() == content

    def test_rejects_and_removes_a_file_that_fails_its_checksum(self, tmp_path: Path, mocker: MockerFixture) -> None:
        sut = InpaintModel("frameleaf-inpaint", cache_dir=tmp_path)

        def fake_download(repo: str, **kwargs: Any) -> None:
            sut.model_path.parent.mkdir(parents=True)
            sut.model_path.write_bytes(b"not lama")

        mocker.patch.object(sut, "_download_from_source", side_effect=fake_download)
        with pytest.raises(ModelUnavailableError, match="checksum"):
            sut.download()
        assert not sut.model_path.exists()

    def test_an_unknown_model_name_is_unavailable(self, tmp_path: Path, mocker: MockerFixture) -> None:
        sut = InpaintModel("some-other-inpainter", cache_dir=tmp_path)
        download = mocker.patch.object(sut, "_download_from_source")
        with pytest.raises(ModelUnavailableError):
            sut.download()
        download.assert_not_called()


def serve(mocker: MockerFixture, model: Any) -> None:
    """Answer the inpaint entry with `model`, bypassing the shared model cache."""

    async def get(*args: Any, **kwargs: Any) -> Any:
        return model

    mocker.patch("immich_ml.main.model_cache.get", side_effect=get)


class TestInpaintEndpoint:
    entries = json.dumps({"inpaint": {"visual": {"modelName": "frameleaf-inpaint", "options": {}}}})

    def test_answers_the_server_contract(self, tmp_path: Path, mocker: MockerFixture, deployed_app: TestClient) -> None:
        sut = InpaintModel("frameleaf-inpaint", cache_dir=tmp_path)
        tiny_lama(sut.model_path)
        serve(mocker, sut)
        response = deployed_app.post(
            "/predict",
            data={"entries": self.entries},
            files={
                "image": ("blob", png(Image.new("RGB", (24, 16), (5, 6, 7))), "application/octet-stream"),
                "mask": ("blob", png(half_mask(24, 16)), "application/octet-stream"),
            },
        )
        assert response.status_code == 200, response.text
        body = response.json()["inpaint"]
        assert (body["width"], body["height"]) == (24, 16)
        filled = decode(body)
        assert filled.format == "PNG" and filled.size == (24, 16)
        assert filled.convert("RGB").getpixel((0, 0)) == (5, 6, 7)

    def test_requires_a_mask(self, mocker: MockerFixture, deployed_app: TestClient) -> None:
        serve(mocker, mock.Mock(depends=[], loaded=True))
        response = deployed_app.post(
            "/predict",
            data={"entries": self.entries},
            files={"image": ("blob", png(Image.new("RGB", (8, 8))), "application/octet-stream")},
        )
        assert response.status_code == 400

    def test_refuses_a_mask_of_another_size(self, deployed_app: TestClient) -> None:
        response = deployed_app.post(
            "/predict",
            data={"entries": self.entries},
            files={
                "image": ("blob", png(Image.new("RGB", (8, 8))), "application/octet-stream"),
                "mask": ("blob", png(Image.new("L", (4, 4))), "application/octet-stream"),
            },
        )
        assert response.status_code == 400

    def test_a_worker_without_the_model_answers_503(
        self, tmp_path: Path, mocker: MockerFixture, deployed_app: TestClient
    ) -> None:
        sut = InpaintModel("frameleaf-inpaint", cache_dir=tmp_path)
        mocker.patch.object(sut, "_download", side_effect=ModelUnavailableError("not on the mirror"))
        serve(mocker, sut)
        response = deployed_app.post(
            "/predict",
            data={"entries": self.entries},
            files={
                "image": ("blob", png(Image.new("RGB", (8, 8))), "application/octet-stream"),
                "mask": ("blob", png(half_mask(8, 8)), "application/octet-stream"),
            },
        )
        assert response.status_code == 503
