"""One bounded, isolated model process, shared by consecutive admitted requests."""

import json
import os
import signal
import subprocess
import threading
import time
from contextlib import suppress
from pathlib import Path

from .gpu import VramSampler
from .models import RestorationFailure, RuntimeInvocation, RuntimeOutcome, classify_runtime_failure
from .schemas import RestorationErrorCode


class RuntimePool:
    # ponytail: one resident model; add a pool only if GPU admission ever allows concurrency.
    def __init__(self) -> None:
        self._call_lock = threading.Lock()
        self._state_lock = threading.RLock()
        self._process: subprocess.Popen[bytes] | None = None
        self._worker_pid: int | None = None
        self._active_request: object | None = None
        self._key: str | None = None
        self._requests = 0
        self._idle: threading.Timer | None = None
        self._cancelled = threading.Event()

    def begin_request(self) -> None:
        # The HTTP admission lock owns this reset; a cancelled request cannot start
        # another model while its synchronous pipeline is still unwinding.
        self._cancelled.clear()

    def cancel(self) -> None:
        self._cancelled.set()
        self.close()

    def _check_cancelled(self) -> None:
        if self._cancelled.is_set():
            raise RestorationFailure(RestorationErrorCode.RUNTIME_FAILED, "the restoration was cancelled")

    @staticmethod
    def _child_groups(parent: int) -> list[int]:
        # Legacy torchrun and a warm worker cancelled before its handshake can
        # have ranks in separate sessions. Capture only this launcher's descendants.
        if Path("/proc/self").exists():
            descendants: set[int] = set()
            pending = [parent]
            while pending:
                pid = pending.pop()
                with suppress(FileNotFoundError, ProcessLookupError):
                    for task in Path(f"/proc/{pid}/task").iterdir():
                        with suppress(FileNotFoundError, ProcessLookupError):
                            children = {int(child) for child in (task / "children").read_text().split()}
                            pending.extend(children - descendants)
                            descendants.update(children)
            groups = []
            for pid in descendants:
                with suppress(ProcessLookupError):
                    if os.getpgid(pid) == pid:
                        groups.append(pid)
            return groups
        # macOS developer checks; the Linux worker needs no ps/procps dependency.
        rows = subprocess.check_output(["ps", "-axo", "pid=,ppid=,pgid="], text=True, timeout=5)
        processes = [tuple(map(int, row.split())) for row in rows.splitlines()]
        descendants = {parent}
        while True:
            children = {pid for pid, ppid, _ in processes if ppid in descendants}
            if children <= descendants:
                break
            descendants.update(children)
        return [pid for pid, _, group in processes if pid in descendants and pid == group and pid != parent]

    def close(self) -> None:
        with self._state_lock:
            if self._idle is not None:
                self._idle.cancel()
                self._idle = None
            process, self._process = self._process, None
            worker_pid, self._worker_pid = self._worker_pid, None
            self._active_request = None
            self._key = None
            if process is None:
                return
            # The supported single-rank torchrun puts its worker in a separate session.
            # Both groups are owned, even when the launcher exits before its rank.
            groups = [pid for pid in dict.fromkeys((worker_pid, process.pid)) if pid is not None]
            if worker_pid is None and process.poll() is None:
                groups = [*self._child_groups(process.pid), *groups]
            for sig in (signal.SIGTERM, signal.SIGKILL):
                for pid in groups:
                    assert pid is not None
                    try:
                        os.killpg(pid, sig)
                    except ProcessLookupError:
                        pass
                    except PermissionError:
                        # Darwin reports EPERM for some already-exited process groups.
                        # Fall back to the owned leader; a live permission error propagates.
                        with suppress(ProcessLookupError):
                            os.kill(pid, sig)
                    if sig == signal.SIGKILL and pid != process.pid:
                        # Give torchrun a chance to reap its forcibly stopped rank.
                        with suppress(subprocess.TimeoutExpired):
                            process.wait(timeout=1)
                if sig == signal.SIGTERM:
                    with suppress(subprocess.TimeoutExpired):
                        process.wait(timeout=1)
            process.wait()
            for pipe in (process.stdin, process.stdout, process.stderr):
                if pipe is not None:
                    with suppress(OSError):
                        pipe.close()

    def _run_process(self, invocation: RuntimeInvocation) -> RuntimeOutcome:
        started = time.monotonic()
        with self._state_lock:
            self._check_cancelled()
            self.close()
            try:
                process = subprocess.Popen(
                    invocation.argv,
                    cwd=invocation.cwd,
                    env=invocation.env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    start_new_session=True,
                )
            except OSError as error:
                raise RestorationFailure(RestorationErrorCode.RUNTIME_FAILED, f"runtime start failed: {error}")
            self._process = process
        try:
            with VramSampler() as sampler:
                _, stderr = process.communicate(timeout=invocation.timeout_s)
            self._check_cancelled()
            if process.returncode != 0:
                raise classify_runtime_failure(process.returncode, (stderr or b"").decode(errors="replace"))
            return RuntimeOutcome(int((time.monotonic() - started) * 1000), sampler.peak)
        except subprocess.TimeoutExpired:
            raise RestorationFailure(RestorationErrorCode.TIMEOUT, "the runtime exceeded its deadline") from None
        except (OSError, ValueError) as error:
            raise RestorationFailure(RestorationErrorCode.RUNTIME_FAILED, f"runtime communication failed: {error}")
        finally:
            self.close()

    def __call__(self, invocation: RuntimeInvocation) -> RuntimeOutcome:
        with self._call_lock:
            if invocation.payload is None:
                return self._run_process(invocation)
            started = time.monotonic()
            timed_out = threading.Event()
            with self._state_lock:
                self._check_cancelled()
                if self._idle is not None:
                    self._idle.cancel()
                    self._idle = None
                if self._process is not None and (
                    self._key != invocation.cache_key or self._process.poll() is not None
                ):
                    self.close()
                if self._process is None:
                    try:
                        self._process = subprocess.Popen(
                            invocation.argv,
                            cwd=invocation.cwd,
                            env=invocation.env,
                            stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL,
                            start_new_session=True,
                        )
                    except OSError as error:
                        raise RestorationFailure(RestorationErrorCode.RUNTIME_FAILED, f"runtime start failed: {error}")
                    self._key = invocation.cache_key
                    self._requests = 0
                process = self._process
                request_token = object()
                self._active_request = request_token

            def expire() -> None:
                with self._state_lock:
                    if self._process is process and self._active_request is request_token:
                        timed_out.set()
                        self.close()

            deadline = threading.Timer(invocation.timeout_s, expire)
            deadline.daemon = True
            deadline.start()
            try:
                with VramSampler() as sampler:
                    assert process.stdin is not None and process.stdout is not None

                    def read_reply() -> dict[str, object]:
                        assert process.stdout is not None
                        line = process.stdout.readline(8193)
                        if timed_out.is_set():
                            raise RestorationFailure(
                                RestorationErrorCode.TIMEOUT, "the warm runtime exceeded its deadline"
                            )
                        if len(line) > 8192 or not line.endswith(b"\n"):
                            raise RestorationFailure(
                                RestorationErrorCode.RUNTIME_FAILED, "warm runtime protocol failed"
                            )
                        reply = json.loads(line)
                        if not isinstance(reply, dict):
                            raise ValueError("invalid runtime response")
                        return reply

                    if self._worker_pid is None:
                        ready = read_reply()
                        pid = ready.get("pid")
                        if ready.get("ready") is not True or type(pid) is not int or pid <= 1 or os.getpgid(pid) != pid:
                            raise ValueError("invalid runtime startup handshake")
                        if pid != process.pid:
                            # Never trust a PID from model stdout to name an unrelated process.
                            stat = Path(f"/proc/{pid}/stat")
                            if stat.exists():
                                parent_pid = int(stat.read_text().rpartition(")")[2].split()[1])
                            else:
                                parent_pid = int(
                                    subprocess.check_output(
                                        ["ps", "-o", "ppid=", "-p", str(pid)], text=True, timeout=5
                                    ).strip()
                                )
                            if parent_pid != process.pid:
                                raise ValueError("runtime handshake is not from the launched worker")
                        with self._state_lock:
                            if self._process is not process:
                                raise RestorationFailure(RestorationErrorCode.TIMEOUT, "runtime stopped during startup")
                            self._worker_pid = pid
                    process.stdin.write((json.dumps(invocation.payload) + "\n").encode())
                    process.stdin.flush()
                    reply = read_reply()
                    if reply.get("ok") is not True:
                        detail = reply.get("error", "invalid response")
                        raise classify_runtime_failure(1, str(detail))
                self._requests += 1
            except (OSError, ValueError) as error:
                self.close()
                code = RestorationErrorCode.TIMEOUT if timed_out.is_set() else RestorationErrorCode.RUNTIME_FAILED
                raise RestorationFailure(code, f"warm runtime communication failed: {error}") from error
            except BaseException:
                self.close()
                raise
            finally:
                deadline.cancel()
                with self._state_lock:
                    if self._active_request is request_token:
                        self._active_request = None
                if process.poll() is not None:
                    for pipe in (process.stdin, process.stdout):
                        if pipe is not None:
                            pipe.close()
            if timed_out.is_set():
                raise RestorationFailure(RestorationErrorCode.TIMEOUT, "the warm runtime exceeded its deadline")
            with self._state_lock:
                if self._requests >= invocation.max_requests:
                    self.close()
                elif self._process is process:

                    def expire_idle() -> None:
                        with self._state_lock:
                            if self._idle is idle:
                                self.close()

                    idle = threading.Timer(invocation.idle_s, expire_idle)
                    self._idle = idle
                    idle.daemon = True
                    idle.start()
            return RuntimeOutcome(int((time.monotonic() - started) * 1000), sampler.peak)
