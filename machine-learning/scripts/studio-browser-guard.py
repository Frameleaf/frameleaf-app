#!/usr/bin/env python3
import os
import signal
import sys
import time
from pathlib import Path


def identity(pid: int) -> str | None:
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return fields[19] if fields[0] not in {"Z", "X"} else None
    except (OSError, IndexError):
        return None


def main() -> None:
    browser_pid = os.getpid()
    owner = int(os.environ.get("FRAMELEAF_STUDIO_OWNER_PID", "0"))
    owner_identity = identity(owner)
    if owner <= 1 or owner != os.getppid() or owner_identity is None or os.getpgrp() != browser_pid:
        raise RuntimeError("Studio browser requires its live direct owner and a detached process group")
    browser_identity = identity(browser_pid)
    if os.fork() == 0:
        # Staying in this group anchors its identity until the guardian kills only its own group.
        for event in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(event, signal.SIG_IGN)
        try:
            # The real browser keeps Playwright's pipes; the guardian must not hold them open.
            for descriptor in os.listdir("/proc/self/fd"):
                try:
                    os.close(int(descriptor))
                except OSError:
                    pass
            while identity(owner) == owner_identity and identity(browser_pid) == browser_identity:
                time.sleep(0.1)
        finally:
            os.killpg(os.getpgrp(), signal.SIGKILL)
            os._exit(1)
    os.execv(str(Path(__file__).with_name("frameleaf-studio-chromium")), sys.argv)


if __name__ == "__main__":
    main()
