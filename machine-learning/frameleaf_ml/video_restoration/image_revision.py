"""A photo worker image's revision, derived from what can change a model's output (FL-933).

A commit SHA changes on every release, so a qualification record naming one would switch the models
off at the next release. This revision is a hash of the runtime entry points, the worker's still
input and output code, the hashed package lock, the Python version, the pinned checkouts, the base
image digest and the pinned weight hashes. It changes when any of them does and stays the same
across unrelated releases.

The image build writes it with its inputs to a file. The worker recomputes it from the files
actually in the container when it starts, and reports no revision if anything differs or is
missing, so the qualification gate refuses.

    python -m frameleaf_ml.video_restoration.image_revision write --root /usr/src --out <file> \
        --base-image <image@sha256:...> --python <interpreter> --checkout name=<path> ...
    python -m frameleaf_ml.video_restoration.image_revision verify <file> --root /usr/src

Standard library only.
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

SCHEME = "photo-sha256"
REVISION_RE = re.compile(rf"^{SCHEME}:[0-9a-f]{{64}}$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
BASE_IMAGE_RE = re.compile(r"^[^@\s]+@sha256:[0-9a-f]{64}$")
PYTHON_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
MANIFEST = "video-restoration/qualification/models.qualified.photo.json"
# Every file whose content can change the pixels a photo workload returns.
OUTPUT_FILES = (
    "video-restoration/runtimes/photo_repair.py",
    "video-restoration/runtimes/colourise.py",
    "video-restoration/runtimes/photo.lock",
    "frameleaf_ml/video_restoration/media.py",
    "frameleaf_ml/video_restoration/pipeline.py",
)


def file_digests(root: Path) -> dict[str, str]:
    digests = {}
    for name in OUTPUT_FILES:
        path = root / name
        if not path.is_file():
            raise ValueError(f"{name} is missing")
        digests[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return digests


def weight_pins(root: Path) -> tuple[list[list[str]], set[str]]:
    """Each model's pinned weight hashes and upstream commits. Notes and limits are not inputs."""
    try:
        models = json.loads((root / MANIFEST).read_text(encoding="utf-8"))["models"]
    except (OSError, ValueError, KeyError) as error:
        raise ValueError(f"{MANIFEST} cannot be read: {error}") from error
    pins, commits = [], set()
    for model in models:
        commits.add(model["revision"])
        for weight in model["weights"]:
            if not SHA256_RE.match(weight["sha256"]):
                raise ValueError(f"{model['id']} weight {weight['role']} has no pinned sha256")
            pins.append([model["id"], weight["role"], weight["sha256"]])
    if not pins:
        raise ValueError(f"{MANIFEST} pins no weights")
    return sorted(pins), commits


def compute_revision(root: Path, *, base_image: str, python_version: str, checkouts: dict[str, str]) -> str:
    if not BASE_IMAGE_RE.match(base_image):
        raise ValueError("the base image must be pinned by digest")
    if not PYTHON_VERSION_RE.match(python_version):
        raise ValueError("the runtime's Python version could not be read")
    if not checkouts or not all(COMMIT_RE.match(commit) for commit in checkouts.values()):
        raise ValueError("every checkout must be at an exact commit")
    pins, pinned_commits = weight_pins(root)
    if not pinned_commits <= set(checkouts.values()):
        raise ValueError("a checkout is not at the commit the manifest pins")
    payload = {
        "scheme": SCHEME,
        "files": file_digests(root),
        "weights": pins,
        "checkouts": dict(sorted(checkouts.items())),
        # The digest alone: the same image stays the same whatever tag it was reached through.
        "baseImage": base_image.split("@", 1)[1],
        "python": python_version,
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    return f"{SCHEME}:{hashlib.sha256(canonical).hexdigest()}"


def checkout_commit(path: Path) -> str:
    done = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
        env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
    )
    if done.returncode != 0:
        raise ValueError(f"{path} has no readable commit")
    return done.stdout.strip()


def interpreter_version(python: Path) -> str:
    done = subprocess.run(
        [str(python), "-I", "-c", "import platform; print(platform.python_version())"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if done.returncode != 0:
        raise ValueError(f"{python} could not report its version")
    return done.stdout.strip()


def measure(root: Path, base_image: str, python: Path, checkouts: dict[str, Path]) -> str:
    return compute_revision(
        root,
        base_image=base_image,
        python_version=interpreter_version(python),
        checkouts={name: checkout_commit(path) for name, path in checkouts.items()},
    )


def write_revision(root: Path, out: Path, base_image: str, python: Path, checkouts: dict[str, Path]) -> str:
    revision = measure(root, base_image, python, checkouts)
    record = {
        "revision": revision,
        "baseImage": base_image,
        "python": str(python),
        "checkouts": {name: str(path) for name, path in checkouts.items()},
    }
    out.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return revision


def verified_revision(path: Path, root: Path) -> str | None:
    """The recorded revision if the container still measures to it, otherwise None."""
    try:
        record: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        revision = record["revision"]
        if not isinstance(revision, str) or not REVISION_RE.match(revision):
            return None
        measured = measure(
            root,
            record["baseImage"],
            Path(record["python"]),
            {name: Path(checkout) for name, checkout in record["checkouts"].items()},
        )
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired):
        return None
    return revision if measured == revision else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    write = commands.add_parser("write")
    write.add_argument("--root", required=True, type=Path)
    write.add_argument("--out", required=True, type=Path)
    write.add_argument("--base-image", required=True)
    write.add_argument("--python", required=True, type=Path)
    write.add_argument("--checkout", action="append", required=True, metavar="NAME=PATH")
    verify = commands.add_parser("verify")
    verify.add_argument("file", type=Path)
    verify.add_argument("--root", required=True, type=Path)
    args = parser.parse_args()
    if args.command == "verify":
        revision = verified_revision(args.file, args.root)
        if revision is None:
            print("the image revision does not match this container", file=sys.stderr)
            return 1
        print(revision)
        return 0
    checkouts = {name: Path(path) for name, path in (item.split("=", 1) for item in args.checkout)}
    try:
        print(write_revision(args.root, args.out, args.base_image, args.python, checkouts))
    except ValueError as error:
        print(f"cannot derive the image revision: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
