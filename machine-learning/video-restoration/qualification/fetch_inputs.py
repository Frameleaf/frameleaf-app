"""Fetch what a photo qualification run needs (FL-933): the pinned weights and the scan set.

    python fetch_inputs.py weights <upstream.json> <dir>
    python fetch_inputs.py scans <scan-set.json> <dir> [--limit N]

Every file is kept only when it hashes to its pinned sha256. Scans come as one tar from the
private Forgejo package named in the scan set, read with the token in ``PACKAGE_TOKEN``; only
members the scan set names are extracted, by name, and each is checked. Standard library only.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path

# Generic on purpose: no personal details.
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
    curl = shutil.which("curl")
    partial = target.with_name(target.name + ".part")
    for wait in (0, 20):
        time.sleep(wait)
        if curl:
            # With no --retry-delay, curl waits as long as a 429's Retry-After header asks.
            done = subprocess.run(
                [curl, "-sS", "--fail", "-L", "-A", USER_AGENT, "--retry", "2", "--max-time", "1800"]
                + ["-o", str(partial), url],
                check=False,
            )
            fetched = done.returncode == 0
        else:  # the worker image has no curl
            fetched = download(url, partial)
        if fetched and sha256(partial) == expected:
            partial.replace(target)
            return True
    partial.unlink(missing_ok=True)
    return False


def download(url: str, target: Path) -> bool:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=120) as response, target.open("wb") as out:
            shutil.copyfileobj(response, out, 8 * 1024 * 1024)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        print(f"download failed: {error}", file=sys.stderr)
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("what", choices=("weights", "scans"))
    parser.add_argument("manifest", type=Path)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--check-only", action="store_true", help="only confirm the scan package is readable")
    parser.add_argument("--from-tar", type=Path, help="read the scans from this copy of the package")
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
    package = manifest["package"]
    if args.from_tar:  # a copy of the package already on this machine: same pinned hash
        archive = args.from_tar
    else:
        token = os.environ.get("PACKAGE_TOKEN", "")
        if not token:
            print("PACKAGE_TOKEN is not set", file=sys.stderr)
            return 1
        archive = args.directory / package["file"]
        request = urllib.request.Request(
            f"{package['registry']}/{package['file']}",
            headers={"Authorization": f"token {token}", "User-Agent": USER_AGENT},
            method="HEAD" if args.check_only else "GET",
        )
        if args.check_only:  # proves the job can read the package before the long setup steps
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    print(f"scan package readable: HTTP {response.status}")
                return 0
            except (urllib.error.URLError, TimeoutError) as error:
                print(f"the scan package could not be read: {getattr(error, 'code', error)}", file=sys.stderr)
                return 1
        try:
            with urllib.request.urlopen(request, timeout=120) as response, archive.open("wb") as out:
                shutil.copyfileobj(response, out, 8 * 1024 * 1024)
        except urllib.error.HTTPError as error:
            print(f"the scan package could not be read: HTTP {error.code}", file=sys.stderr)
            return 1
    if sha256(archive) != package["sha256"]:
        print("the scan package does not match its pinned sha256", file=sys.stderr)
        return 1

    wanted = {f"{scan['id']}.jpg": scan["sha256"] for scan in scans}
    with tarfile.open(archive, "r:") as tar:
        for member in tar:
            if member.isfile() and member.name in wanted:
                source = tar.extractfile(member)
                with (args.directory / member.name).open("wb") as out:
                    shutil.copyfileobj(source, out, 8 * 1024 * 1024)
    if not args.from_tar:
        archive.unlink()
    missing = [name for name, digest in wanted.items() if not (args.directory / name).is_file()]
    wrong = [name for name, digest in wanted.items() if name not in missing and sha256(args.directory / name) != digest]
    for name in wrong:
        (args.directory / name).unlink()
    print(
        json.dumps(
            {
                "scans": len(scans),
                "verified": len(scans) - len(missing) - len(wrong),
                "missing": missing,
                "wrong": wrong,
            }
        )
    )
    return 0 if not missing and not wrong else 1


if __name__ == "__main__":
    sys.exit(main())
