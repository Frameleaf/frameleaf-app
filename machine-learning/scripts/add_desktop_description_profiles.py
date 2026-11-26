"""Add FD-31's desktop photo-description profiles and processor twins for a desktop runtime source.

Run with the runtime source's own environment, so its binding and preprocessing identity are the ones qualified:

    cd <runtime source>/machine-learning
    uv run --extra cpu python <this tree>/machine-learning/scripts/add_desktop_description_profiles.py \\
        --catalogue <this tree>/server/resources/desktop/model-catalogue.json \\
        --source-revision <runtime source commit> --twin-from <released source commit> \\
        --binary <llama-server built from the pinned llama.cpp> --work <empty folder> \\
        --model Qwen3.5-4B=<folder>=<mirror revision> --model Qwen2.5-VL-7B-Instruct=<folder>=<mirror revision>

Each model folder holds exactly what the model mirror serves for it: `visual/model.gguf`, `visual/mmproj.gguf` and
`LICENSE`. They are staged as a desktop stages them (with the mirror ref `models--frameleaf--<name>/refs/main`), the
reference description comes from this source's binding on the fixture, and `frameleaf_ml.native_qualification`
must then reproduce it in two cold runs (`ready-cpu`) before a profile is written.

The processor twins: every processor profile of `--twin-from`, under the runtime source, with the same model key,
fixture and reference output. That is right only when the source changes no file of the ONNX preprocessing
identity, which is checked: the running tree's identity must be the twinned profiles' own.

Nothing already in the catalogue changes; its epoch goes up by one.
"""

import argparse
import base64
import hashlib
import json
import os
import shutil
import struct
import sys
import zlib
from pathlib import Path

PROVIDER = "CPUExecutionProvider"
TASK = "image-description-tagging"
# Memory floor (measured peak resident memory plus 25%, rounded up to a quarter GiB) and the deadline of one
# description, per model. The 7B's floor is what a 16 GB computer can still offer while idle.
LIMITS = {"Qwen3.5-4B": (8.0, 120), "Qwen2.5-VL-7B-Instruct": (11.75, 300)}


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def fixture() -> bytes:
    """A red square on white, 128 pixels: the photo every description profile is qualified with."""
    raw = bytearray()
    for y in range(128):
        raw.append(0)
        for x in range(128):
            raw.extend((224, 24, 32) if 30 <= x < 98 and 30 <= y < 98 else (255, 255, 255))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", 128, 128, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def stage(cache: Path, name: str, files: Path, revision: str) -> Path:
    """The model as a desktop stages it from the mirror, with its staging receipt."""
    from frameleaf_ml.staging import RECEIPT, cache_hashes

    directory = cache / TASK / name
    (directory / "visual").mkdir(parents=True)
    for item in ("visual/model.gguf", "visual/mmproj.gguf", "LICENSE"):
        os.link(files / item, directory / item)
    ref = directory / f"models--frameleaf--{name}" / "refs" / "main"
    ref.parent.mkdir(parents=True)
    ref.write_text(revision)
    (directory / RECEIPT).write_text(json.dumps(cache_hashes(directory)))
    return directory


def description_profile(args: argparse.Namespace, name: str, files: Path, revision: str) -> dict:
    import asyncio

    from frameleaf_ml import native_qualification, native_qwen
    from frameleaf_ml.staging import cache_hashes

    native_qwen.BINARY = args.binary
    work = args.work / name
    cache = work / "cache"
    directory = stage(cache, name, files, revision)
    artifacts = cache_hashes(directory)
    image = fixture()
    memory, deadline = LIMITS[name]
    entries = {TASK: {"visual": {"modelName": name, "options": {}}}}
    models = [{"name": name, "task": TASK, "type": "visual", "artifacts": artifacts}]
    preprocessing = native_qualification.preprocessing_identity("qwen-gguf")
    key = "description:" + digest(
        {"protocolVersion": 1, "entries": entries, "models": models, "preprocessingSha256": preprocessing}
    )
    spec = {
        "protocolVersion": 1,
        "engine": "qwen-gguf",
        "modelKey": key,
        "provider": PROVIDER,
        "models": models,
        "entries": entries,
        "preprocessingSha256": preprocessing,
        "fixtureFile": "fixture.png",
        "fixtureKind": "image",
        "fixtureSha256": hashlib.sha256(image).hexdigest(),
        "expectedOutput": {},
        "minMemoryBytes": int(memory * 1024**3),
        "deadlineSeconds": deadline,
    }
    # The reference: this source's binding on the fixture. The qualifier below must reproduce it exactly, twice.
    output, _ = asyncio.run(native_qwen.predict_qwen(cache, name, image, native_qwen.binary_sha256()))
    spec["expectedOutput"] = output
    (work / "fixture.png").write_bytes(image)
    (work / "spec.json").write_text(json.dumps(spec))
    report_path = work / "report.json"
    argv, cwd = sys.argv, Path.cwd()
    try:
        os.chdir(work)
        sys.argv = ["native_qualification", "--spec", "spec.json", "--cache-dir", str(cache), "--output", "report.json"]
        native_qualification.main()
    except SystemExit as exit:
        if exit.code:
            raise
    finally:
        sys.argv = argv
        os.chdir(cwd)
    report = json.loads(report_path.read_text())
    if report.get("state") != "ready-cpu" or report.get("modelKey") != key:
        raise SystemExit(f"{name}: qualification {report.get('state')} {report.get('reason')}")
    print(
        f"{name}: ready-cpu in {report['qwenExecution']['coldMilliseconds']} ms, build "
        f"{report['qwenExecution']['build']}: {output[TASK]['description']!r} -> {key[:24]}"
    )
    sizes = {path: (directory / path).stat().st_size for path in artifacts}
    return {
        "modelKey": key,
        "modelName": name,
        "workload": "description",
        "runtimeSourceRevision": args.source_revision,
        "modelSnapshotRevision": revision,
        "spec": spec,
        "fixtureBase64": base64.b64encode(image).decode(),
        "artifactBytes": sizes,
    }


def main() -> int:
    from frameleaf_ml.native_qualification import preprocessing_identity

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--catalogue", type=Path, required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--twin-from", required=True)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--model", action="append", required=True, help="NAME=FOLDER=MIRROR_REVISION")
    args = parser.parse_args()
    for revision in (args.source_revision, args.twin_from):
        if len(revision) != 40 or any(character not in "0123456789abcdef" for character in revision):
            parser.error("revisions must be full commit hashes")
    args.binary, args.work = args.binary.resolve(), args.work.resolve()
    if args.work.exists():
        parser.error("--work must be a new folder")
    catalogue = json.loads(args.catalogue.read_text())
    present = [profile for profile in catalogue["profiles"] if profile["runtimeSourceRevision"] == args.source_revision]
    # A second run for the same source (a model that could not qualify the first time) adds only its descriptions.
    twins = (
        []
        if present
        else [
            {**profile, "runtimeSourceRevision": args.source_revision}
            for profile in catalogue["profiles"]
            if profile["runtimeSourceRevision"] == args.twin_from and profile["spec"]["provider"] == PROVIDER
        ]
    )
    identity = preprocessing_identity()
    twinned = [profile for profile in present if profile["workload"] != "description"] or twins
    if not twinned or any(profile["spec"]["preprocessingSha256"] != identity for profile in twinned):
        print(
            f"This source's ONNX preprocessing identity ({identity[:12]}) is not "
            f"{args.twin_from[:8]}'s; nothing was added"
        )
        return 1

    descriptions = []
    for item in args.model:
        name, folder, revision = item.split("=")
        if name not in LIMITS or len(revision) != 40:
            parser.error(f"unknown model or revision: {item}")
        if any(profile["modelName"] == name for profile in present):
            parser.error(f"{name} already has a profile for {args.source_revision[:8]}")
        descriptions.append(description_profile(args, name, Path(folder).resolve(), revision))

    catalogue["profiles"].extend(twins + descriptions)
    catalogue["epoch"] += 1
    args.catalogue.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2) + "\n")
    print(
        f"Added {len(twins)} processor twins of {args.twin_from[:8]} and {len(descriptions)} description profiles "
        f"for {args.source_revision[:8]}: catalogue epoch {catalogue['epoch']}."
    )
    shutil.rmtree(args.work)
    return 0


if __name__ == "__main__":
    sys.exit(main())
