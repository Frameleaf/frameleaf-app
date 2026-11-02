#!/usr/bin/env python3
"""Smoke-test the container's installed Studio runtime and guarded browser."""

import os
import subprocess
from pathlib import Path

assert Path(os.environ["FRAMELEAF_STUDIO_WORKER_ENTRY"]).is_file(), "Studio worker entry is missing"
subprocess.run(["node", "--version"], check=True, timeout=10)
probe = subprocess.run(["ffprobe", "-version"], check=True, capture_output=True, text=True, timeout=10)
print(probe.stdout.splitlines()[0], flush=True)

browser = os.environ["FRAMELEAF_STUDIO_CHROMIUM"]
owner_env = {**os.environ, "FRAMELEAF_STUDIO_OWNER_PID": str(os.getpid())}
for detached, owner in ((True, "1"), (False, str(os.getpid()))):
    denied = subprocess.run(
        [browser, "--version"],
        env={**os.environ, "FRAMELEAF_STUDIO_OWNER_PID": owner},
        start_new_session=detached,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert denied.returncode != 0 and "requires its live direct owner" in denied.stderr, denied

# Match the worker's direct owner and detached process group, including for version checks.
for arguments, expected in (
    (["--version"], "Chrom"),
    (
        ["--headless=new", "--no-sandbox", "--disable-gpu", "--dump-dom", "data:text/html,<p>studio-ok</p>"],
        "<p>studio-ok</p>",
    ),
):
    result = subprocess.run(
        [browser, *arguments],
        env=owner_env,
        start_new_session=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    assert expected in result.stdout, result.stdout
    print(result.stdout.strip(), flush=True)
