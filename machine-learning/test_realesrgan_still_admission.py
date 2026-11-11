import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from frameleaf_ml.video_restoration.models import (
    STILL_ARGV,
    STILL_SCRIPT,
    STILL_WEIGHT_SHA256,
    ModelSpec,
    RestorationFailure,
    RestorationRegistry,
)
from frameleaf_ml.video_restoration.pipeline import restore
from frameleaf_ml.video_restoration.schemas import RestorationErrorCode, RestorationMode, RestorationRequest
from frameleaf_ml.video_restoration.still_approval import SignedStillApproval, approval_statement
from test_realesrgan_still_candidate import SCRIPT, fixture_image
from test_video_restoration import IMAGE_REVISION, make_spec, passing_record


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def test_signed_still_selection_and_new_render(tmp_path):
    checkpoint = os.getenv("FRAMELEAF_TEST_REALESRGAN_CHECKPOINT")
    openssl = os.getenv("FRAMELEAF_TEST_OPENSSL")
    python = Path(os.getenv("FRAMELEAF_TEST_REALESRGAN_PYTHON", sys.executable))
    if not checkpoint or not openssl:
        pytest.skip("requires the pinned checkpoint and an OpenSSL 3 verifier")
    root = tmp_path / "runtime"
    script = root / STILL_SCRIPT
    script.parent.mkdir(parents=True)
    shutil.copyfile(SCRIPT, script)
    git(root, "init", "-q")
    git(root, "add", STILL_SCRIPT)
    git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture runtime")
    base = make_spec(tmp_path).model_dump(mode="json")
    spec = ModelSpec.model_validate(
        {
            **base,
            "id": "realesr-general-x4v3",
            "family": "realesrgan",
            "revision": git(root, "rev-parse", "HEAD"),
            "runtime": {"root": root, "python": python, "argv": list(STILL_ARGV), "timeoutSeconds": 60},
            "requiresGpu": False,
            "weights": [{"role": "model", "path": checkpoint, "sha256": STILL_WEIGHT_SHA256}],
            "limits": {"maxInputLongEdge": 1024, "maxFrames": 1, "maxFramesPerChunk": 1, "minVramBytes": 0},
        }
    )
    record = passing_record(spec)
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        json.dumps({"schemaVersion": 1, "weightsRoot": str(tmp_path), "models": [spec.model_dump(mode="json")]})
    )
    qualification = tmp_path / "qualification.json"
    qualification.write_text(json.dumps({"schemaVersion": 1, "records": [record.model_dump(mode="json")]}))
    (tmp_path / "statement").write_bytes(approval_statement(spec, record, IMAGE_REVISION))
    for args in (
        ["genpkey", "-algorithm", "ED25519", "-out", "private"],
        ["pkey", "-in", "private", "-pubout", "-outform", "DER", "-out", "public"],
        ["pkeyutl", "-sign", "-rawin", "-inkey", "private", "-in", "statement", "-out", "signature"],
    ):
        subprocess.run([openssl, *args], cwd=tmp_path, check=True)
    approval = SignedStillApproval(
        Path(openssl), (tmp_path / "public").read_bytes(), (tmp_path / "signature").read_bytes()
    )

    def registry(admission=None):
        return RestorationRegistry(
            manifest, qualification, gpu_query=list, container_revision=IMAGE_REVISION, still_admission=admission
        )

    def rejected(registry, kind="image", model=spec.id):
        with pytest.raises(RestorationFailure) as error:
            registry.select(RestorationMode.FAITHFUL, model, None, kind=kind)
        assert error.value.code == RestorationErrorCode.MODEL_UNAVAILABLE

    assert registry().refresh().models == []
    rejected(registry())
    admitted = registry(approval)
    assert admitted.refresh().workloads == []
    rejected(admitted, kind="video")
    rejected(admitted, model=None)
    wrong = SignedStillApproval(approval.openssl, approval.public_key, bytes(64))
    rejected(registry(wrong))
    assert admitted.select(RestorationMode.FAITHFUL, spec.id, None, kind="image").spec == spec

    original = tmp_path / "original.png"
    fixture_image().save(original)
    source_bytes = original.read_bytes()
    request = RestorationRequest.model_validate(
        {
            "protocol": "restoration-v1",
            "requestId": "still-preview",
            "kind": "image",
            "mode": "faithful",
            "modelId": spec.id,
            "source": {"width": 139, "height": 113},
            "maxWidth": 96,
            "maxHeight": 96,
        }
    )
    preview_dir, render_dir = tmp_path / "preview", tmp_path / "render"
    preview_dir.mkdir()
    render_dir.mkdir()
    preview, preview_path = restore(admitted, request, original, preview_dir)
    preview_bytes = preview_path.read_bytes()
    full_request = request.model_copy(
        update={
            "requestId": "still-full",
            "modelFingerprint": preview.model.fingerprint,
            "maxWidth": 384,
            "maxHeight": 384,
        }
    )
    result, version_path = restore(admitted, full_request, original, render_dir)
    assert result.model == preview.model
    assert result.output.width > preview.output.width
    assert version_path.parent == render_dir
    assert original.read_bytes() == source_bytes
    assert preview_path.read_bytes() == preview_bytes

    with pytest.raises(RestorationFailure) as error:
        admitted.select(RestorationMode.FAITHFUL, spec.id, "0" * 64, kind="image")
    assert error.value.code == RestorationErrorCode.MODEL_CHANGED
    qualification.write_text(
        json.dumps({"schemaVersion": 1, "records": [{**record.model_dump(mode="json"), "notes": "changed"}]})
    )
    rejected(admitted)
