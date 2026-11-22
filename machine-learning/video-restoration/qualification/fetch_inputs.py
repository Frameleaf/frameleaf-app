"""Fetch what a photo qualification run needs (FL-933): the pinned weights and the scan set.

    python fetch_inputs.py weights <upstream.json> <dir>
    python fetch_inputs.py scans <scan-set.json> <dir> [--limit N]

Every file is kept only when it hashes to its pinned sha256. Scans are fetched one at a time
with a pause; one that is gone or changed is reported and left out. Standard library only.
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

# Wikimedia answers 429 to the default curl agent. Generic on purpose: no personal details.
USER_AGENT = "photo-qualification-fetch/1.0 (public-domain test images; sequential)"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(url: str, target: Path, expected: str) -> bool:
    if target.is_file() and sha256(target) == expected:
        return True
    curl = shutil.which("curl") or "curl"
    partial = target.with_name(target.name + ".part")
    for wait in (0, 20, 90):
        time.sleep(wait)
        done = subprocess.run(
            [curl, "-sS", "--fail", "-L", "-A", USER_AGENT, "--max-time", "1800", "-o", str(partial), url],
            check=False,
        )
        if done.returncode == 0 and sha256(partial) == expected:
            partial.replace(target)
            return True
    partial.unlink(missing_ok=True)
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("what", choices=("weights", "scans"))
    parser.add_argument("manifest", type=Path)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    args.directory.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))

    if args.what == "weights":
        for role, weight in manifest["weights"].items():
            if not fetch(weight["url"], args.directory / weight["file"], weight["sha256"]):
                print(f"weight {role} could not be fetched with its pinned sha256", file=sys.stderr)
                return 1
            print(f"weight {role}: {weight['file']} verified")
        return 0

    scans = manifest["scans"][: args.limit or None]
    missing = []
    for scan in scans:
        if not fetch(scan["url"], args.directory / f"{scan['id']}.jpg", scan["sha256"]):
            missing.append(scan["id"])
        time.sleep(3.0)
    print(json.dumps({"scans": len(scans), "fetched": len(scans) - len(missing), "missing": missing}))
    return 0 if len(missing) <= len(scans) // 10 else 1


if __name__ == "__main__":
    sys.exit(main())
