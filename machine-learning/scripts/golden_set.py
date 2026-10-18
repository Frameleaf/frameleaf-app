"""FL-455: record the golden set for the Frameleaf Cloud release parity gate.

Runs this repository's own ML service model classes (the same ones `/predict` uses) on the fixture
images listed in test-fixtures/golden-set/images.json, with the server defaults:

- smart search: the CLIP visual encoder of ViT-B-16-SigLIP-384__webli;
- faces: buffalo_l detection (minScore 0.7) followed by recognition.

Models come from the configured model source (the Frameleaf model mirror by default) at the
revisions pinned in server/resources/desktop/model-catalogue.json, and each downloaded model file is
checked against the byte sizes recorded there. Vectors are the raw model output rows, exactly as the
service returns them and the server stores them (not L2 normalised).

Output: one <id>.json per image plus manifest.json in --output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
from importlib.metadata import version
from pathlib import Path
from typing import Any

import orjson

from frameleaf_ml.config import clean_name, model_source
from frameleaf_ml.models import from_model_type
from frameleaf_ml.models.base import InferenceModel
from frameleaf_ml.models.transforms import decode_pil
from frameleaf_ml.schemas import ModelFormat, ModelTask, ModelType, ORJSONResponse

REPO_ROOT = Path(__file__).resolve().parents[2]
CATALOGUE = REPO_ROOT / "server" / "resources" / "desktop" / "model-catalogue.json"
FIXTURES = REPO_ROOT / "machine-learning" / "test-fixtures" / "golden-set" / "images.json"

CLIP_MODEL = "ViT-B-16-SigLIP-384__webli"
FACE_MODEL = "buffalo_l"
FACE_MIN_SCORE = 0.7
CLIP_PREPROCESS = "frameleaf-clip-visual/1"
FACE_PREPROCESS = "frameleaf-face/1"
# Only the files each run needs: the CLIP text encoder is not downloaded.
CLIP_FILES = ["config.json", "visual/model.onnx", "visual/preprocess_cfg.json"]
FACE_FILES = ["detection/model.onnx", "recognition/model.onnx"]
IGNORED_FILES = {CLIP_MODEL: ["*.armnn", "*.rknn", "textual/*"], FACE_MODEL: ["*.armnn", "*.rknn"]}
LIBRARIES = ["pillow", "opencv-python-headless", "onnxruntime", "numpy"]


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def pinned_profile(catalogue: dict[str, Any], model_name: str) -> tuple[str, dict[str, int]]:
    """The single snapshot revision the release catalogue pins for a model, and its file sizes."""
    profiles = [profile for profile in catalogue["profiles"] if profile["modelName"] == model_name]
    revisions = {profile["modelSnapshotRevision"] for profile in profiles}
    if len(revisions) != 1:
        raise SystemExit(f"Expected one pinned revision for {model_name} in {CATALOGUE}, found {sorted(revisions)}")
    artifact_bytes: dict[str, int] = profiles[0]["artifactBytes"]
    return revisions.pop(), artifact_bytes


def fetch(model: InferenceModel, revision: str, files: list[str], artifact_bytes: dict[str, int]) -> dict[str, str]:
    """Download the pinned snapshot into the service cache layout and verify it against the catalogue."""
    if not all((model.cache_dir / name).is_file() for name in files):
        model._download_from_source(
            clean_name(model.model_name), revision=revision, ignore_patterns=IGNORED_FILES[model.model_name]
        )
    hashes = {}
    for name in files:
        path = model.cache_dir / name
        if not path.is_file():
            raise SystemExit(f"{model.model_name}: {name} is missing after download")
        size, pinned = path.stat().st_size, artifact_bytes[name]
        if size != pinned:
            raise SystemExit(
                f"{model.model_name}: {name} is {size} bytes, the catalogue pins {pinned}; "
                "use an empty --cache-dir (loading may rewrite a cached recognizer)"
            )
        # Hashed before loading: loading the recognizer may rewrite its model file with a batch axis.
        hashes[name] = sha256(path)
    return hashes


def wire(content: Any) -> Any:
    """What the service sends over HTTP: the same ORJSONResponse rendering `/predict` uses."""
    return orjson.loads(ORJSONResponse(content).body)


def git_sha() -> str:
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, required=True, help="Model cache root (service layout)")
    args = parser.parse_args()

    catalogue = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    clip_revision, clip_bytes = pinned_profile(catalogue, CLIP_MODEL)
    face_revision, face_bytes = pinned_profile(catalogue, FACE_MODEL)

    def model(name: str, model_type: ModelType, task: ModelTask) -> InferenceModel:
        cache_dir = args.cache_dir / task.value / clean_name(name)
        return from_model_type(name, model_type, task, cache_dir=cache_dir, model_format=ModelFormat.ONNX)

    clip = model(CLIP_MODEL, ModelType.VISUAL, ModelTask.SEARCH)
    detector = model(FACE_MODEL, ModelType.DETECTION, ModelTask.FACIAL_RECOGNITION)
    recognizer = model(FACE_MODEL, ModelType.RECOGNITION, ModelTask.FACIAL_RECOGNITION)
    clip_hashes = fetch(clip, clip_revision, CLIP_FILES, clip_bytes)
    face_hashes = fetch(detector, face_revision, FACE_FILES, face_bytes)

    fixtures = json.loads(FIXTURES.read_text(encoding="utf-8"))["images"]
    if len({fixture["id"] for fixture in fixtures}) != len(fixtures):
        raise SystemExit(f"Duplicate image ids in {FIXTURES}")
    args.output.mkdir(parents=True, exist_ok=True)
    inputs = []
    for fixture in fixtures:
        path = REPO_ROOT / fixture["path"]
        data = path.read_bytes()
        # Decoded as `/predict` decodes an uploaded image; every model receives the same decoded image.
        image = decode_pil(data)
        if image.width == 0 or image.height == 0:
            raise SystemExit(f"{fixture['path']} has zero width or height")
        size = {"imageHeight": image.height, "imageWidth": image.width}

        embedding = wire({"clip": clip.predict(image), **size})
        faces = detector.predict(image, minScore=FACE_MIN_SCORE)
        recognized = wire({"facial-recognition": recognizer.predict(image, faces), **size})
        result = {
            "id": fixture["id"],
            "path": fixture["path"],
            "sha256": hashlib.sha256(data).hexdigest(),
            "smartSearch": {
                "modelName": CLIP_MODEL,
                "embedding": orjson.loads(embedding["clip"]),
                "imageWidth": embedding["imageWidth"],
                "imageHeight": embedding["imageHeight"],
            },
            "faces": {
                "modelName": FACE_MODEL,
                "minScore": FACE_MIN_SCORE,
                "faces": [
                    {**face, "embedding": orjson.loads(face["embedding"])}
                    for face in recognized["facial-recognition"]
                ],
                "imageWidth": recognized["imageWidth"],
                "imageHeight": recognized["imageHeight"],
            },
        }
        (args.output / f"{fixture['id']}.json").write_bytes(orjson.dumps(result, option=orjson.OPT_INDENT_2))
        inputs.append({"id": fixture["id"], "path": fixture["path"], "sha256": result["sha256"], **size})
        print(f"{fixture['id']}: {len(result['faces']['faces'])} face(s)")

    source_url, source_setting = model_source()
    manifest = {
        "gitSha": git_sha(),
        "models": {
            "smartSearch": {
                "modelName": CLIP_MODEL,
                "modelType": ModelType.VISUAL.value,
                "revision": clip_revision,
                "preprocess": CLIP_PREPROCESS,
                "files": clip_hashes,
            },
            "faces": {
                "modelName": FACE_MODEL,
                "minScore": FACE_MIN_SCORE,
                "revision": face_revision,
                "preprocess": FACE_PREPROCESS,
                "files": face_hashes,
            },
        },
        "modelSource": {"url": source_url, "setting": source_setting},
        "libraries": {name: version(name) for name in LIBRARIES},
        "runtime": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "machine": platform.machine(),
            "onnxruntimeProviders": list(getattr(clip.session, "providers", [])),
            "intraOpThreads": os.environ.get("MACHINE_LEARNING_MODEL_INTRA_OP_THREADS", "default"),
        },
        "images": inputs,
    }
    (args.output / "manifest.json").write_bytes(orjson.dumps(manifest, option=orjson.OPT_INDENT_2))
    print(f"Wrote {len(inputs)} golden results and manifest.json to {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
