"""Add this tree's machine-learning build to the desktop model catalogue, as smart-search profiles.

    uv run --extra cpu python scripts/recut_desktop_catalogue.py \\
        --source-revision <commit this build's sources come from> --work <empty folder>

A catalogue profile carries the hash of the service's preprocessing sources (`preprocessing_identity()`),
and the service only produces under a model identity whose hash is its own. When those sources change, this
tree's build is no longer any revision the catalogue names, and once a desktop is granted smart search the
server's own AI refuses every catalogue identity (see server/scripts/check-ml-catalogue-identity.mjs).

For each smart-search profile of the newest processor revision this appends a twin for this build: the same
model files, fixture and reference output, under this build's preprocessing identity and so a new model
key. A twin is appended only after the model was staged from the model source (by default the Frameleaf organisation on Hugging Face) and
`frameleaf_ml.native_qualification`, run from this tree, reproduced the reference output (`ready-cpu`).
Each model's twins get their own space in `model-spaces.json`. Nothing already in either file is changed
or removed; both epochs go up by one. It only ever adds processor (CPU) profiles.

What this does not make: a factory-signed desktop runtime for the source revision. Until one is built and
signed, no desktop can qualify under these profiles; they are there for the server's own AI.
"""

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT.parent / "server" / "resources" / "desktop"
PROVIDER = "CPUExecutionProvider"


def canonical(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def preprocessing_identity() -> str:
    """The same files, in the same order, as frameleaf_ml.native_qualification.preprocessing_identity()."""
    root = ROOT / "frameleaf_ml"
    files = sorted((root / "models").rglob("*.py")) + [
        root / name for name in ("main.py", "schemas.py", "config.py", "producer_binding.py")
    ]
    value = hashlib.sha256()
    for path in files:
        value.update(path.relative_to(root).as_posix().encode() + b"\0" + path.read_bytes())
    return value.hexdigest()


def model_key(workload: str, spec: dict, preprocessing: str) -> str:
    identity = {
        "protocolVersion": 1,
        "entries": spec["entries"],
        "models": spec["models"],
        "preprocessingSha256": preprocessing,
    }
    return f"{workload}:{digest(identity)}"


def write(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def run(arguments: list, *, cache: Path, cwd: Path, timeout: int) -> int:
    environment = {**os.environ, "MACHINE_LEARNING_CACHE_FOLDER": str(cache), "HF_HUB_DISABLE_TELEMETRY": "1"}
    return subprocess.run(
        [sys.executable, "-m", *arguments], env=environment, cwd=cwd, timeout=timeout, check=False
    ).returncode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source-revision", required=True, help="40-character commit of this build's sources")
    parser.add_argument("--work", type=Path, required=True, help="Folder for model files and reports")
    parser.add_argument("--model", action="append", help="Only this smart-search model (repeatable)")
    arguments = parser.parse_args()
    revision = arguments.source_revision
    if len(revision) != 40 or any(character not in "0123456789abcdef" for character in revision):
        parser.error("--source-revision must be a full commit hash")

    catalogue_path, spaces_path = RESOURCES / "model-catalogue.json", RESOURCES / "model-spaces.json"
    catalogue, spaces = json.loads(catalogue_path.read_text()), json.loads(spaces_path.read_text())
    identity = preprocessing_identity()
    work = arguments.work.resolve()
    cache = work / "cache"
    cache.mkdir(parents=True, exist_ok=True)

    # The newest processor profile of each smart-search request: the twin's model files, fixture and reference.
    newest: dict[str, dict] = {}
    for profile in catalogue["profiles"]:
        if profile["workload"] == "clip" and profile["spec"]["provider"] == PROVIDER:
            if not arguments.model or profile["modelName"] in arguments.model:
                newest[canonical(profile["spec"]["entries"])] = profile
    known = {(p["modelKey"], p["spec"]["provider"], p["runtimeSourceRevision"]) for p in catalogue["profiles"]}

    appended: list[dict] = []
    failed = False
    for index, source in enumerate(newest.values()):
        spec = dict(source["spec"], preprocessingSha256=identity)
        spec["modelKey"] = model_key(source["workload"], spec, identity)
        label = f"{source['modelName']} ({spec['fixtureKind']}, {canonical(spec['entries'])})"
        if model_key(source["workload"], source["spec"], source["spec"]["preprocessingSha256"]) != source["modelKey"]:
            print(f"{label}: the catalogue's own key does not follow from its identity; nothing was added")
            return 1
        if spec["modelKey"] == source["modelKey"]:
            print(f"{label}: this build is already revision {source['runtimeSourceRevision'][:8]} of the catalogue")
            continue
        if (spec["modelKey"], PROVIDER, revision) in known:
            print(f"{label}: already in the catalogue for {revision[:8]}")
            continue
        for model in spec["models"]:
            options = spec["entries"][model["task"]][model["type"]].get("options", {})
            staging = ["frameleaf_ml.staging", "--task", model["task"], "--type", model["type"]]
            staging += ["--model", model["name"], "--options", json.dumps(options)]
            if run(staging, cache=cache, cwd=work, timeout=3600):
                print(f"{label}: the model could not be staged")
                failed = True
                break
        else:
            folder = work / f"profile-{index}"
            folder.mkdir(exist_ok=True)
            (folder / "spec.json").write_text(json.dumps(spec))
            (folder / spec["fixtureFile"]).write_bytes(base64.b64decode(source["fixtureBase64"]))
            report_path = folder / "report.json"
            report_path.unlink(missing_ok=True)
            qualification = ["frameleaf_ml.native_qualification", "--spec", str(folder / "spec.json")]
            qualification += ["--cache-dir", str(cache), "--output", str(report_path)]
            code = run(qualification, cache=cache, cwd=folder, timeout=spec["deadlineSeconds"] + 120)
            report = json.loads(report_path.read_text()) if report_path.is_file() else {}
            passed = (
                code == 0
                and report.get("state") == "ready-cpu"
                and report.get("modelKey") == spec["modelKey"]
                and report.get("preprocessingSha256") == identity
            )
            runtime = report.get("runtime", {})
            print(
                f"{label}: {report.get('state')} {report.get('reason') or ''} "
                f"onnxruntime {runtime.get('ort')} {runtime.get('architecture')} -> {spec['modelKey'][:18]}"
            )
            if not passed:
                failed = True
                continue
            appended.append({**source, "modelKey": spec["modelKey"], "runtimeSourceRevision": revision, "spec": spec})

    if failed:
        print("Nothing was written: every profile of this build must qualify.")
        return 1
    if not appended:
        print("Nothing to add.")
        return 0

    # One space per model: its image encoder and its text encoders, as the existing spaces are built.
    new_spaces = []
    for name in dict.fromkeys(profile["modelName"] for profile in appended):
        ours = [profile for profile in appended if profile["modelName"] == name]
        visual = [profile["modelKey"] for profile in ours if profile["spec"]["fixtureKind"] == "image"]
        text = [profile["modelKey"] for profile in ours if profile["spec"]["fixtureKind"] == "text"]
        if len(visual) != 1 or not text:
            print(f"{name}: a space needs one image encoder and at least one text encoder; nothing was written")
            return 1
        key = digest({"visualModelKey": visual[0], "textModelKeys": sorted(text)})
        new_spaces.append({"spaceKey": f"clip-space:{key}", "visualModelKey": visual[0], "textModelKeys": text})

    catalogue["profiles"].extend(appended)
    catalogue["epoch"] += 1
    spaces["spaces"].extend(new_spaces)
    spaces["epoch"] += 1
    write(catalogue_path, catalogue)
    write(spaces_path, spaces)
    print(
        f"Added {len(appended)} profiles and {len(new_spaces)} spaces for {identity[:12]} at {revision[:8]}: "
        f"catalogue epoch {catalogue['epoch']}, spaces epoch {spaces['epoch']}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
