"""FL-408: run the bundled Studio render worker next to the inference server.

The worker is a Node process (``studio/tools/bundled-worker.mjs``) that enrols with this deployment's
server through the private trust volume and renders Studio exports. It is on by default and
``FRAMELEAF_STUDIO_WORKER=false`` turns it off. It never shares a process with inference: a crash
in either leaves the other running, and the worker is restarted with a growing back-off.
"""

import errno
import os
import signal
import subprocess
import threading
from collections.abc import Callable, Mapping
from contextlib import suppress
from pathlib import Path

from .config import log

FALSE_VALUES = {"false", "0", "no", "off"}
MIN_BACKOFF_S = 5.0
MAX_BACKOFF_S = 300.0
STABLE_RUN_S = 600.0


def studio_worker_enabled(env: Mapping[str, str]) -> bool:
    return env.get("FRAMELEAF_STUDIO_WORKER", "true").strip().lower() not in FALSE_VALUES


def studio_worker_command(env: Mapping[str, str]) -> list[str] | None:
    """The command that runs the worker, or None when it is off or not installed in this image."""
    if not studio_worker_enabled(env):
        log.info("Studio worker disabled (FRAMELEAF_STUDIO_WORKER=false)")
        return None
    entry = env.get("FRAMELEAF_STUDIO_WORKER_ENTRY", "")
    if not entry or not Path(entry).is_file():
        return None
    browser = env.get("FRAMELEAF_STUDIO_CHROMIUM", "")
    if browser and not Path(browser).exists():
        log.warning("Studio worker not started: this image has no browser for the Studio engine")
        return None
    return [env.get("FRAMELEAF_STUDIO_NODE", "node"), entry]


def worker_env(env: Mapping[str, str]) -> dict[str, str]:
    """The worker's environment: the container's, without the inference allocator preload."""
    return {key: value for key, value in env.items() if key != "LD_PRELOAD"}


def next_backoff(previous: float, ran_for: float) -> float:
    """Back off after quick failures; a run that lasted resets the delay."""
    if ran_for >= STABLE_RUN_S:
        return MIN_BACKOFF_S
    return min(MAX_BACKOFF_S, max(MIN_BACKOFF_S, previous * 2))


class StudioWorkerSupervisor:
    def __init__(
        self,
        command: list[str],
        popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
        clock: Callable[[], float] | None = None,
    ) -> None:
        import time

        self.command = command
        self.popen = popen
        self.clock = clock or time.monotonic
        self.stopping = threading.Event()
        self.process: subprocess.Popen[bytes] | None = None
        self._process_lock = threading.Lock()
        self.thread = threading.Thread(target=self.run, name="studio-worker", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def run(self) -> None:
        backoff = MIN_BACKOFF_S
        while not self.stopping.is_set():
            started = self.clock()
            try:
                process = self.popen(self.command, env=worker_env(os.environ), start_new_session=True)
                with self._process_lock:
                    self.process = process
            except OSError as error:
                log.warning(f"Studio worker could not start: {error}")
                if error.errno not in {errno.EAGAIN, errno.ENOMEM, errno.EINTR, errno.EMFILE, errno.ENFILE}:
                    return
                backoff = next_backoff(backoff, 0)
                log.warning(f"Retrying Studio worker startup in {backoff:.0f} s")
                self.stopping.wait(backoff)
                continue
            # stop() may have run before this process was recorded, when it had nothing to terminate.
            if self.stopping.is_set() and not self._cleanup(process):
                return
            code = process.wait()
            if not self._cleanup(process):
                return
            if self.stopping.is_set():
                return
            if code == 0:
                log.info("Studio worker exited")
                return
            backoff = next_backoff(backoff, self.clock() - started)
            log.warning(f"Studio worker stopped (exit {code}); restarting in {backoff:.0f} s")
            self.stopping.wait(backoff)

    def stop(self, timeout: float = 10.0) -> None:
        self.stopping.set()
        process = self.process
        if process is not None:
            self._cleanup(process, timeout)

    def _cleanup(self, process: subprocess.Popen[bytes], timeout: float = 10.0) -> bool:
        with self._process_lock:
            if self.process is not process:
                return True
            # The session belongs to this worker, including children left behind after its leader exits.
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(process.pid, sig)
                except ProcessLookupError:
                    pass
                except OSError as error:
                    log.warning(f"Studio worker group cleanup failed; restart held: {error}")
                    return False
                if sig == signal.SIGTERM:
                    with suppress(subprocess.TimeoutExpired):
                        process.wait(timeout=timeout)
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                log.warning("Studio worker did not exit after SIGKILL; restart held")
                return False
            self.process = None
            return True


def start_studio_worker(env: Mapping[str, str] | None = None) -> StudioWorkerSupervisor | None:
    command = studio_worker_command(os.environ if env is None else env)
    if command is None:
        return None
    supervisor = StudioWorkerSupervisor(command)
    supervisor.start()
    log.info("Studio worker started")
    return supervisor
