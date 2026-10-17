import hashlib
import json
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from frameleaf_ml.config import settings
from frameleaf_ml.models.clip.textual import OpenClipTextualEncoder
from frameleaf_ml.native_qualification import preprocessing_identity


@pytest.fixture
def binding(synthetic_clip_cache, monkeypatch):
    name, cache, hashes = synthetic_clip_cache
    monkeypatch.setattr(settings, "cache_folder", cache.parent.parent)
    monkeypatch.setattr(settings, "ann", False)
    monkeypatch.setattr(settings, "rknn", False)
    monkeypatch.setattr(settings, "model_downloads", True)
    identity = {
        "protocolVersion": 1,
        "models": [{"name": name, "task": "clip", "type": "textual", "artifacts": hashes}],
        "entries": {"clip": {"textual": {"modelName": name}}},
        "preprocessingSha256": preprocessing_identity(),
    }
    encoded = json.dumps(identity, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    return {**identity, "modelKey": "clip:" + hashlib.sha256(encoded).hexdigest()}


def test_offline_load_never_downloads_or_clears_a_verified_cache(synthetic_clip_cache, monkeypatch):
    name, cache, _ = synthetic_clip_cache
    model = OpenClipTextualEncoder(name, cache_dir=cache)
    download = Mock(side_effect=AssertionError("unexpected model download"))
    clear = Mock(side_effect=AssertionError("unexpected cache clearing"))
    monkeypatch.setattr(model, "download", download)
    monkeypatch.setattr(model, "clear_cache", clear)
    model.load(allow_download=False)
    assert json.loads(model.predict("frameleaf fixture")) == [5.0, 5.0]
    download.assert_not_called()
    clear.assert_not_called()


def test_bound_endpoint_returns_only_verified_producer_identity(deployed_app: TestClient, binding):
    response = deployed_app.post("/predict-bound", data={"binding": json.dumps(binding), "text": "frameleaf fixture"})
    assert response.status_code == 200
    assert response.json() == {
        "protocolVersion": 1,
        "modelKey": binding["modelKey"],
        "preprocessingSha256": binding["preprocessingSha256"],
        "result": {"clip": "[5.0,5.0]"},
    }


def test_cached_model_cannot_hide_changed_artifacts(deployed_app: TestClient, binding, synthetic_clip_cache):
    data = {"binding": json.dumps(binding), "text": "frameleaf fixture"}
    assert deployed_app.post("/predict-bound", data=data).status_code == 200
    _, cache, _ = synthetic_clip_cache
    config = cache / "config.json"
    value = json.loads(config.read_text())
    value["unrelatedMarker"] = True
    config.write_text(json.dumps(value))
    response = deployed_app.post("/predict-bound", data=data)
    assert response.status_code == 409
    assert response.json() == {"detail": "model_identity_unavailable"}
    assert str(cache) not in response.text


def test_bound_nas_cache_needs_exact_hashes_not_a_staging_receipt(
    deployed_app: TestClient, binding, synthetic_clip_cache
):
    _, cache, _ = synthetic_clip_cache
    (cache / ".frameleaf-staged.json").unlink()
    response = deployed_app.post("/predict-bound", data={"binding": json.dumps(binding), "text": "frameleaf fixture"})
    assert response.status_code == 200


def test_bound_endpoint_does_not_echo_an_unverified_key(deployed_app: TestClient, binding):
    binding["modelKey"] = "clip:" + "f" * 64
    response = deployed_app.post("/predict-bound", data={"binding": json.dumps(binding), "text": "frameleaf fixture"})
    assert response.status_code == 409


@pytest.mark.parametrize("output", ["[null]", "[true]", '["x"]', "{}", "[]", "[1e999]"])
def test_bound_output_must_be_a_finite_vector(deployed_app, binding, monkeypatch, output):
    monkeypatch.setattr(OpenClipTextualEncoder, "predict", Mock(return_value=output))
    response = deployed_app.post("/predict-bound", data={"binding": json.dumps(binding), "text": "fixture"})
    assert response.status_code == 409
    assert response.json() == {"detail": "model_identity_unavailable"}


def test_inference_mutation_withholds_output(deployed_app, binding, synthetic_clip_cache, monkeypatch):
    _, cache, _ = synthetic_clip_cache
    original = OpenClipTextualEncoder.predict

    def mutate(self, *args, **kwargs):
        result = original(self, *args, **kwargs)
        value = json.loads((cache / "config.json").read_text())
        value["changedDuringInference"] = True
        (cache / "config.json").write_text(json.dumps(value))
        return result

    monkeypatch.setattr(OpenClipTextualEncoder, "predict", mutate)
    response = deployed_app.post("/predict-bound", data={"binding": json.dumps(binding), "text": "fixture"})
    assert response.status_code == 409
    assert "clip" not in response.json()


def test_oversized_image_is_refused_before_accessing_models(deployed_app, binding, monkeypatch):
    import struct
    import zlib

    from frameleaf_ml import producer_binding

    def chunk(kind, data):
        return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data))

    image = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", 8192, 8192, 8, 2, 0, 0, 0))
    image += chunk(b"IDAT", zlib.compress(b"")) + chunk(b"IEND", b"")
    binding["models"][0]["type"] = "visual"
    binding["entries"] = {"clip": {"visual": {"modelName": binding["models"][0]["name"]}}}
    identity = {k: v for k, v in binding.items() if k != "modelKey"}
    binding["modelKey"] = (
        "clip:" + hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    )
    models = Mock(side_effect=AssertionError("oversized image reached model verification"))
    monkeypatch.setattr(producer_binding, "verify_models", models)
    response = deployed_app.post("/predict-bound", data={"binding": json.dumps(binding)}, files={"image": image})
    assert response.status_code == 409
    models.assert_not_called()


def test_bound_runtime_files_are_private_temporary_and_do_not_change_global_settings(
    binding, synthetic_clip_cache, monkeypatch
):
    from tempfile import TemporaryDirectory

    from frameleaf_ml import producer_binding
    from frameleaf_ml.sessions import runtime_cache_dir
    from frameleaf_ml.staging import cache_hashes

    paths = []

    def temporary(*args, **kwargs):
        directory = TemporaryDirectory(*args, **kwargs)
        paths.append(Path(directory.name))
        return directory

    monkeypatch.setattr(producer_binding, "TemporaryDirectory", temporary)
    _, cache, hashes = synthetic_clip_cache
    result = producer_binding.BoundPredictor().predict(json.dumps(binding), None, "frameleaf fixture")
    assert result["modelKey"] == binding["modelKey"]
    assert cache_hashes(cache) == hashes
    assert settings.model_downloads is True
    assert runtime_cache_dir(cache / "textual/model.onnx") == cache / "textual"
    assert paths and all(not path.exists() for path in paths)


def test_bound_prediction_does_not_reuse_an_unverified_legacy_model(deployed_app, binding, monkeypatch):
    from frameleaf_ml import main

    legacy = Mock(side_effect=AssertionError("legacy model cache accessed"))
    monkeypatch.setattr(main.model_cache, "get", legacy)
    response = deployed_app.post("/predict-bound", data={"binding": json.dumps(binding), "text": "fixture"})
    assert response.status_code == 200
    legacy.assert_not_called()


def test_bound_visual_pipeline_returns_verified_dimensions(deployed_app, binding, synthetic_clip_cache):
    from io import BytesIO

    import onnx
    from PIL import Image

    from frameleaf_ml.staging import cache_hashes
    from test_native_qualification import graph

    name, cache, _ = synthetic_clip_cache
    model_path = cache / "visual/model.onnx"
    graph(model_path, batch=True)
    model = onnx.load(model_path)
    model.graph.input[0].name = "image"
    model.graph.node[0].input[0] = "image"
    onnx.save(model, model_path)
    (cache / "visual/preprocess_cfg.json").write_text(
        json.dumps(
            {
                "size": 2,
                "interpolation": "bicubic",
                "mean": [0, 0, 0],
                "std": [1, 1, 1],
            }
        )
    )
    binding["models"] = [{"name": name, "task": "clip", "type": "visual", "artifacts": cache_hashes(cache)}]
    binding["entries"] = {"clip": {"visual": {"modelName": name}}}
    identity = {k: v for k, v in binding.items() if k != "modelKey"}
    binding["modelKey"] = (
        "clip:" + hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    )
    image = BytesIO()
    Image.new("RGB", (2, 2), (255, 255, 255)).save(image, format="PNG")
    response = deployed_app.post(
        "/predict-bound", data={"binding": json.dumps(binding)}, files={"image": image.getvalue()}
    )
    assert response.status_code == 200
    result = response.json()
    assert result["modelKey"] == binding["modelKey"]
    assert result["result"]["imageWidth"] == result["result"]["imageHeight"] == 2
    assert json.loads(result["result"]["clip"]) == [12.0] * 4


def test_bound_endpoint_preserves_existing_bearer_auth(binding):
    from frameleaf_ml.main import BearerAuthMiddleware, app

    with TestClient(BearerAuthMiddleware(app, expected_token="synthetic-test-token")) as client:
        data = {"binding": json.dumps(binding), "text": "fixture"}
        assert client.post("/predict-bound", data=data).status_code == 401
        assert (
            client.post(
                "/predict-bound", data=data, headers={"Authorization": "Bearer synthetic-test-token"}
            ).status_code
            == 200
        )


def test_nas_javascript_catalogue_keys_match_python_canonical_identity(monkeypatch):
    from io import BytesIO

    from PIL import Image

    from frameleaf_ml import producer_binding

    rows = json.loads((Path(__file__).parent / "test-fixtures/producer-bindings.json").read_text())
    image = BytesIO()
    Image.new("RGB", (1, 1)).save(image, format="PNG")
    for row in rows:
        spec = row["binding"]
        monkeypatch.setattr(producer_binding, "preprocessing_identity", lambda: spec["preprocessingSha256"])
        verified = Mock(side_effect=RuntimeError("canonical identity accepted"))
        monkeypatch.setattr(producer_binding, "verify_models", verified)
        with pytest.raises(ValueError, match="producer_identity_unavailable"):
            producer_binding.BoundPredictor().predict(
                json.dumps(spec),
                image.getvalue() if row["inputKind"] == "image" else None,
                "fixture" if row["inputKind"] == "text" else None,
            )
        verified.assert_called_once()


@pytest.mark.parametrize("version", [True, "1", 1.0])
def test_bound_protocol_version_is_a_strict_json_integer(deployed_app, binding, version):
    binding["protocolVersion"] = version
    response = deployed_app.post("/predict-bound", data={"binding": json.dumps(binding), "text": "fixture"})
    assert response.status_code == 409


@pytest.mark.parametrize("chained", [False, True])
def test_failed_inference_releases_sessions_before_removing_runtime_files(binding, monkeypatch, chained):
    import weakref
    from tempfile import TemporaryDirectory

    from frameleaf_ml import producer_binding

    references = []
    original_load = OpenClipTextualEncoder._load

    def load(self):
        references.append(weakref.ref(self))
        return original_load(self)

    class CheckedTemporary:
        def __init__(self, *args, **kwargs):
            self.directory = TemporaryDirectory(*args, **kwargs)

        def __enter__(self):
            return self.directory.name

        def __exit__(self, *args):
            assert references and all(reference() is None for reference in references)
            self.directory.cleanup()

    monkeypatch.setattr(producer_binding, "TemporaryDirectory", CheckedTemporary)
    monkeypatch.setattr(OpenClipTextualEncoder, "_load", load)
    failure = ValueError("synthetic inference failure")
    if chained:
        failure.__cause__ = RuntimeError("synthetic cause")
        failure.__context__ = failure
    monkeypatch.setattr(OpenClipTextualEncoder, "predict", Mock(side_effect=failure))
    with pytest.raises(ValueError, match="producer_identity_unavailable"):
        producer_binding.BoundPredictor().predict(json.dumps(binding), None, "fixture")
