"""The entrypoint drops to the unprivileged user with the groups that own the GPU devices it was given."""

import os
import subprocess
from pathlib import Path

STUBS = {
    "id": 'case "$1" in -u) echo 0;; -G) echo "0 44";; esac',
    # %u: the writable paths already belong to the user; %g: a render node (993) and a root-owned entry.
    "stat": 'case "$2" in %u) echo 10001;; %g) echo 993; echo 0; echo 993; exit 1;; esac',
    "setpriv": 'echo "$@"',
}


def test_joins_the_groups_of_the_gpu_devices(tmp_path: Path) -> None:
    for name, body in STUBS.items():
        stub = tmp_path / name
        stub.write_text(f"#!/bin/sh\n{body}\n")
        stub.chmod(0o755)
    entrypoint = Path(__file__).parent / "scripts" / "entrypoint.sh"
    env = {"PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}"}
    result = subprocess.run(["sh", str(entrypoint), "python"], env=env, capture_output=True, text=True, check=True)
    assert result.stdout.splitlines()[-1] == "--reuid=10001 --regid=10001 --groups=44,993 env HOME=/home/frameleaf python"
