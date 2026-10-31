import hashlib
import json
from pathlib import Path

import numpy as np
import onnx
import pytest
from onnx import TensorProto, helper, numpy_helper

from frameleaf_ml.config import settings
from frameleaf_ml.sessions.ort import OrtSession


def graph(path: Path, batch: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    shape = [1, 3, 2, 2] if batch else [1, 2]
    nodes = [
        helper.make_node("Flatten", ["input"], ["flat"]),
        helper.make_node("MatMul", ["flat", "weights"], ["output"]),
    ]
    weights = numpy_helper.from_array(np.ones((12 if batch else 2, 4), dtype=np.float32), name="weights")
    model = helper.make_model(
        helper.make_graph(
            nodes,
            "fixture",
            [helper.make_tensor_value_info("input", TensorProto.FLOAT, shape)],
            [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 4])],
            [weights],
        ),
        opset_imports=[helper.make_opsetid("", 17)],
        ir_version=9,
    )
    onnx.save(model, path)


def test_native_provider_requires_availability_and_records_executed_cpu_nodes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from frameleaf_ml import native_ort
    from frameleaf_ml.qualification import execution_evidence

    monkeypatch.setattr(native_ort, "_policy", None)
    with pytest.raises(ValueError, match="provider_unavailable"):
        native_ort.configure("MissingExecutionProvider", tmp_path)
    policy = native_ort.configure("CPUExecutionProvider", tmp_path)
    model = tmp_path / "model.onnx"
    graph(model)
    session = OrtSession(model)
    output = session.run(None, {"input": np.ones((1, 2), dtype=np.float32)})[0]
    assert output.shape == (1, 4)
    profile = Path(session.session.end_profiling())
    evidence = execution_evidence(json.loads(profile.read_text()), policy.provider)
    assert evidence["state"] == "ready-cpu"
    assert evidence["nodes"]["CPUExecutionProvider"] > 0
    with pytest.raises(RuntimeError, match="fresh_process"):
        native_ort.configure("CPUExecutionProvider", tmp_path)


@pytest.mark.parametrize(
    ("providers", "requested", "state"),
    [
        (["CPUExecutionProvider"], "CUDAExecutionProvider", "incompatible"),
        (["CUDAExecutionProvider"], "CUDAExecutionProvider", "ready-accelerator"),
        (["CUDAExecutionProvider", "CPUExecutionProvider"], "CUDAExecutionProvider", "ready-mixed"),
        ([], "CPUExecutionProvider", "incompatible"),
        (["CoreMLExecutionProvider"], "CoreMLExecutionProvider", "incompatible"),
    ],
)
def test_registered_provider_without_executed_work_never_proves_acceleration(
    providers: list[str], requested: str, state: str
) -> None:
    from frameleaf_ml.qualification import execution_evidence

    events = [
        {"cat": "Node", "ph": "X", "name": "node_kernel_time", "dur": 5, "args": {"provider": provider}}
        for provider in providers
    ]
    assert execution_evidence(events, requested)["state"] == state


def test_native_disables_python_provider_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from unittest.mock import Mock

    from frameleaf_ml import native_ort

    monkeypatch.setattr(native_ort, "_policy", None)
    native_ort.configure("CPUExecutionProvider", None)
    session = Mock()
    session.get_providers.return_value = ["CPUExecutionProvider"]
    factory = Mock(return_value=session)
    monkeypatch.setattr("onnxruntime.InferenceSession", factory)
    OrtSession(tmp_path / "model.onnx")
    session.disable_fallback.assert_called_once()


def test_offline_face_batching_does_not_rewrite_approved_weights(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from frameleaf_ml import native_ort
    from frameleaf_ml.models.facial_recognition.recognition import FaceRecognizer
    from frameleaf_ml.staging import RECEIPT, cache_hashes

    monkeypatch.setattr(native_ort, "_policy", None)
    monkeypatch.setattr(settings, "model_downloads", False)
    monkeypatch.setattr("frameleaf_ml.sessions.gettempdir", lambda: str(tmp_path / "runtime"))
    monkeypatch.setattr("onnxruntime.get_available_providers", lambda: ["CPUExecutionProvider"])
    model = FaceRecognizer("buffalo_s", cache_dir=tmp_path / "approved")
    graph(model.model_path, batch=True)
    (model.cache_dir / RECEIPT).write_text(json.dumps(cache_hashes(model.cache_dir)))
    before = hashlib.sha256(model.model_path.read_bytes()).hexdigest()
    model.load()
    assert hashlib.sha256(model.model_path.read_bytes()).hexdigest() == before
    assert model.session.model_path != model.model_path
    assert model.session.source_model_path == model.model_path
    assert model.session.get_inputs()[0].shape[0] == "batch"


@pytest.mark.parametrize(
    ("actual", "expected"),
    [
        ({"clip": "[1,NaN]"}, {"clip": "[1,2]"}),
        ({"clip": "[1]"}, {"clip": "[1,2]"}),
        ({"score": float("inf")}, {"score": 1}),
        ({"score": True}, {"score": 1}),
        ({"other": 1}, {"score": 1}),
    ],
)
def test_fixture_output_rejects_changed_shapes_nonfinite_values_and_types(actual: object, expected: object) -> None:
    from frameleaf_ml.qualification import compare_output

    with pytest.raises(ValueError):
        compare_output(actual, expected)


def test_fixture_output_allows_only_bounded_numeric_backend_tolerance() -> None:
    from frameleaf_ml.qualification import compare_output

    compare_output({"clip": "[0.5,0.3]"}, {"clip": "[0.50001,0.3]"})
    with pytest.raises(ValueError):
        compare_output({"clip": "[0.8,0.3]"}, {"clip": "[0.5,0.3]"})


@pytest.mark.parametrize("require_staged", [True, False])
def test_verified_model_uses_one_fresh_hash_scan_for_receipt_and_approved_manifest(
    tmp_path, monkeypatch, synthetic_clip_cache, require_staged
):
    from frameleaf_ml import staging
    from frameleaf_ml.config import settings
    from frameleaf_ml.native_qualification import ModelBindingSpec, preprocessing_identity, verify_models

    name, cache, hashes = synthetic_clip_cache
    monkeypatch.setattr(settings, "cache_folder", tmp_path / "cache")
    spec = ModelBindingSpec.model_validate(
        {
            "protocolVersion": 1,
            "modelKey": "fixture",
            "preprocessingSha256": preprocessing_identity(),
            "entries": {"clip": {"textual": {"modelName": name}}},
            "models": [{"name": name, "task": "clip", "type": "textual", "artifacts": hashes}],
        }
    )
    calls = []
    original = staging.cache_hashes

    def observed(path):
        calls.append(path)
        return original(path)

    monkeypatch.setattr(staging, "cache_hashes", observed)
    verify_models(spec, tmp_path / "cache", require_staged=require_staged)
    assert calls == [cache]
    (cache / "unapproved.bin").write_bytes(b"not approved")
    (cache / staging.RECEIPT).write_text(json.dumps(original(cache)))
    with pytest.raises(ValueError, match="native_staged_hash_mismatch"):
        verify_models(spec, tmp_path / "cache", require_staged=require_staged)


def test_driver_changes_invalidate_fingerprint_without_using_free_memory() -> None:
    from frameleaf_ml.native_hardware import fingerprint

    assert fingerprint({"driver": "1", "model": "hash"}) != fingerprint({"driver": "2", "model": "hash"})


def test_production_text_pipeline_qualification_binds_artifacts_fixture_and_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, synthetic_clip_cache: tuple[str, Path, dict[str, str]]
) -> None:
    import os
    import subprocess
    import sys

    from frameleaf_ml.native_qualification import preprocessing_identity
    from frameleaf_ml.staging import RECEIPT, cache_hashes

    name, cache, hashes = synthetic_clip_cache
    textual = cache / "textual"
    fixture = tmp_path / "fixture.txt"
    fixture.write_text("frameleaf fixture")
    spec = {
        "protocolVersion": 1,
        "modelKey": "synthetic-clip-fixture",
        "provider": "CPUExecutionProvider",
        "models": [{"name": name, "task": "clip", "type": "textual", "artifacts": hashes}],
        "entries": {"clip": {"textual": {"modelName": name}}},
        "preprocessingSha256": preprocessing_identity(),
        "fixtureFile": fixture.name,
        "fixtureKind": "text",
        "fixtureSha256": hashlib.sha256(fixture.read_bytes()).hexdigest(),
        "expectedOutput": {"clip": "[5.0,5.0]"},
        "minMemoryBytes": 1,
        "deadlineSeconds": 30,
    }
    spec_path = tmp_path / "spec.json"
    report = tmp_path / "report.json"

    def run(value: dict[str, object]) -> subprocess.CompletedProcess[str]:
        spec_path.write_text(json.dumps(value))
        return subprocess.run(
            [
                sys.executable,
                "-m",
                "frameleaf_ml.native_qualification",
                "--spec",
                str(spec_path),
                "--cache-dir",
                str(tmp_path / "cache"),
                "--output",
                str(report),
            ],
            env={**os.environ, "MACHINE_LEARNING_MODEL_DOWNLOADS": "false"},
            capture_output=True,
            text=True,
            timeout=40,
        )

    passed = run(spec)
    assert passed.returncode == 0, passed.stderr
    result = json.loads(report.read_text())
    assert result["state"] == "ready-cpu"
    assert result["bindingSha256"] == hashlib.sha256(spec_path.read_bytes()).hexdigest()
    assert result["execution"][0]["nodes"]["CPUExecutionProvider"] > 0
    assert cache_hashes(cache) == hashes
    from fastapi.testclient import TestClient

    from frameleaf_ml import native_ort
    from frameleaf_ml.native_binding import NativeBinding
    from frameleaf_ml.native_runtime import create_native_app

    with monkeypatch.context() as patch:
        patch.setattr(native_ort, "_policy", None)
        native_ort.configure("CPUExecutionProvider", tmp_path / "live-profiles")
        patch.setattr(settings, "cache_folder", tmp_path / "cache")
        patch.setattr(settings, "model_downloads", False)
        binding = NativeBinding.load(spec_path, report, tmp_path / "cache", "CPUExecutionProvider")
        with TestClient(create_native_app(binding)) as client:
            from frameleaf_ml import main

            assert main.model_cache.cache._cache
            assert all(model.loaded for model in main.model_cache.cache._cache.values())
            data = {"entries": json.dumps(spec["entries"]), "text": "frameleaf fixture"}
            response = client.post("/predict", data=data)
            assert response.status_code == 200, response.text
            assert json.loads(response.json()["clip"]) == [5.0, 5.0]
            assert client.post("/predict", data={**data, "entries": "{}"}).status_code == 409
            original = (textual / "model.onnx").read_bytes()
            (textual / "model.onnx").write_bytes(b"changed after qualification")
            assert client.post("/predict", data=data).status_code == 409
            (textual / "model.onnx").write_bytes(original)
    changed = {**spec, "preprocessingSha256": "0" * 64}
    assert run(changed).returncode == 1
    assert json.loads(report.read_text())["reason"] == "native_preprocessing_changed"
    assert run({**spec, "minMemoryBytes": 2**62}).returncode == 1
    assert json.loads(report.read_text())["reason"] == "native_memory_insufficient"
    corrupt = textual / "model.onnx"
    corrupt.write_bytes(b"corrupt staged bytes")
    (cache / RECEIPT).write_text(json.dumps(cache_hashes(cache)))
    assert run(spec).returncode == 1
    assert json.loads(report.read_text())["reason"] == "native_staged_hash_mismatch"


def test_external_tensor_paths_cannot_read_outside_approved_model(tmp_path: Path) -> None:
    from frameleaf_ml.native_qualification import validate_external_weights

    tensor = onnx.TensorProto(
        name="weights", data_type=TensorProto.FLOAT, dims=[2, 4], data_location=TensorProto.EXTERNAL
    )
    entry = tensor.external_data.add()
    entry.key = "location"
    entry.value = "../private.bin"
    proto = helper.make_model(helper.make_graph([], "unsafe", [], [], [tensor]), ir_version=9)
    path = tmp_path / "model.onnx"
    path.write_bytes(proto.SerializeToString())
    with pytest.raises(ValueError, match="native_artifact_path_invalid"):
        validate_external_weights(path, tmp_path, {"model.onnx": "0" * 64})


def test_qualification_watchdog_terminates_blocked_inference(tmp_path: Path) -> None:
    import subprocess
    import sys

    spec = tmp_path / "spec.json"
    spec.write_text(
        json.dumps(
            {
                "protocolVersion": 1,
                "modelKey": "blocked-fixture",
                "provider": "CPUExecutionProvider",
                "models": [
                    {"name": "fixture", "task": "clip", "type": "textual", "artifacts": {"model.onnx": "0" * 64}}
                ],
                "entries": {},
                "preprocessingSha256": "0" * 64,
                "fixtureFile": "fixture.txt",
                "fixtureKind": "text",
                "fixtureSha256": "0" * 64,
                "expectedOutput": {},
                "minMemoryBytes": 1,
                "deadlineSeconds": 1,
            }
        )
    )
    script = """
import asyncio
from frameleaf_ml import native_qualification as module
async def blocked(*args, **kwargs):
    await asyncio.Event().wait()
module.qualify = blocked
module.main()
"""
    report = tmp_path / "report.json"
    result = subprocess.run(
        [sys.executable, "-c", script, "--spec", str(spec), "--cache-dir", str(tmp_path), "--output", str(report)],
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 124
    assert not report.exists()
