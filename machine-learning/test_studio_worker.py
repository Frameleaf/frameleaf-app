"""FL-408: the bundled Studio render worker starts by default, can be turned off, and is supervised."""

import errno
import os
import signal
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from unittest import mock

import psutil
import pytest

from frameleaf_ml.studio_worker import (
    MAX_BACKOFF_S,
    MIN_BACKOFF_S,
    STABLE_RUN_S,
    StudioWorkerSupervisor,
    next_backoff,
    studio_worker_command,
    studio_worker_enabled,
    worker_env,
)


@pytest.fixture
def installed(tmp_path: Path) -> dict[str, str]:
    entry = tmp_path / "bundled-worker.mjs"
    entry.write_text("")
    browser = tmp_path / "browser"
    browser.write_text("")
    return {"FRAMELEAF_STUDIO_WORKER_ENTRY": str(entry), "FRAMELEAF_STUDIO_CHROMIUM": str(browser)}


class TestStudioWorkerCommand:
    def test_on_by_default(self, installed: dict[str, str]) -> None:
        assert studio_worker_enabled({}) is True
        assert studio_worker_command(installed) == ["node", installed["FRAMELEAF_STUDIO_WORKER_ENTRY"]]

    @pytest.mark.parametrize("value", ["false", "FALSE", "0", "no", "off", " false "])
    def test_turned_off(self, installed: dict[str, str], value: str) -> None:
        assert studio_worker_command({**installed, "FRAMELEAF_STUDIO_WORKER": value}) is None

    @pytest.mark.parametrize("value", ["true", "1", "yes", ""])
    def test_other_values_keep_it_on(self, installed: dict[str, str], value: str) -> None:
        assert studio_worker_command({**installed, "FRAMELEAF_STUDIO_WORKER": value}) is not None

    def test_not_installed(self, installed: dict[str, str]) -> None:
        assert studio_worker_command({**installed, "FRAMELEAF_STUDIO_WORKER_ENTRY": "/nonexistent.mjs"}) is None
        assert studio_worker_command({}) is None

    def test_no_browser(self, installed: dict[str, str]) -> None:
        assert studio_worker_command({**installed, "FRAMELEAF_STUDIO_CHROMIUM": "/nonexistent-browser"}) is None


def test_worker_env_drops_the_allocator_preload() -> None:
    assert worker_env({"LD_PRELOAD": "/usr/lib/libmimalloc.so.3", "PATH": "/bin"}) == {"PATH": "/bin"}


class TestBackoff:
    def test_grows_after_quick_failures_and_caps(self) -> None:
        assert next_backoff(MIN_BACKOFF_S, 1) == MIN_BACKOFF_S * 2
        assert next_backoff(MAX_BACKOFF_S, 1) == MAX_BACKOFF_S

    def test_resets_after_a_stable_run(self) -> None:
        assert next_backoff(MAX_BACKOFF_S, STABLE_RUN_S) == MIN_BACKOFF_S


@pytest.fixture
def process_groups() -> Iterator[mock.Mock]:
    with mock.patch("frameleaf_ml.studio_worker.os.killpg") as killpg:
        yield killpg


@pytest.mark.usefixtures("process_groups")
class TestSupervisor:
    def test_restarts_a_crashed_worker_and_stops_on_clean_exit(self) -> None:
        processes = [mock.Mock(wait=mock.Mock(return_value=1)), mock.Mock(wait=mock.Mock(return_value=0))]
        popen = mock.Mock(side_effect=processes)
        supervisor = StudioWorkerSupervisor(["node", "worker.mjs"], popen=popen, clock=lambda: 0.0)
        with mock.patch.object(supervisor.stopping, "wait") as wait:
            supervisor.run()
        assert popen.call_count == 2
        assert all(call.kwargs["start_new_session"] for call in popen.call_args_list)
        wait.assert_called_once_with(MIN_BACKOFF_S * 2)

    def test_stop_terminates_the_running_worker(self, process_groups: mock.Mock) -> None:
        process = mock.Mock(poll=mock.Mock(return_value=None))
        supervisor = StudioWorkerSupervisor(["node", "worker.mjs"], popen=mock.Mock())
        supervisor.process = process
        supervisor.stop()
        process_groups.assert_has_calls(
            [mock.call(process.pid, signal.SIGTERM), mock.call(process.pid, signal.SIGKILL)]
        )
        assert supervisor.stopping.is_set()

    def test_stop_kills_a_worker_that_does_not_exit(self, process_groups: mock.Mock) -> None:
        process = mock.Mock(
            poll=mock.Mock(return_value=None), wait=mock.Mock(side_effect=[subprocess.TimeoutExpired("node", 1), None])
        )
        supervisor = StudioWorkerSupervisor(["node", "worker.mjs"], popen=mock.Mock())
        supervisor.process = process
        supervisor.stop(timeout=0.01)
        process_groups.assert_has_calls(
            [mock.call(process.pid, signal.SIGTERM), mock.call(process.pid, signal.SIGKILL)]
        )
        assert process.wait.call_args_list == [mock.call(timeout=0.01), mock.call(timeout=0.01)]

    def test_does_not_restart_after_stop(self) -> None:
        supervisor = StudioWorkerSupervisor(["node", "worker.mjs"], popen=mock.Mock())

        def exit_after_stop(*_args: object, **_kwargs: object) -> mock.Mock:
            supervisor.stopping.set()
            return mock.Mock(wait=mock.Mock(return_value=1))

        supervisor.popen = mock.Mock(side_effect=exit_after_stop)
        supervisor.run()
        assert supervisor.popen.call_count == 1

    def test_stop_during_spawn_terminates_the_new_worker(self, process_groups: mock.Mock) -> None:
        # stop() can run after the loop's check but before the new process is recorded; it then sees no
        # process to terminate, so the loop itself must not leave the fresh worker running.
        process = mock.Mock(wait=mock.Mock(return_value=-15))
        supervisor = StudioWorkerSupervisor(["node", "worker.mjs"], popen=mock.Mock())

        def stopped_while_spawning(*_args: object, **_kwargs: object) -> mock.Mock:
            supervisor.stop()
            return process

        supervisor.popen = mock.Mock(side_effect=stopped_while_spawning)
        supervisor.run()
        process_groups.assert_has_calls(
            [mock.call(process.pid, signal.SIGTERM), mock.call(process.pid, signal.SIGKILL)]
        )

    def test_stop_does_not_block_when_killed_worker_cannot_be_reaped(self, process_groups: mock.Mock) -> None:
        process = mock.Mock(wait=mock.Mock(side_effect=subprocess.TimeoutExpired("node", 0.01)))
        supervisor = StudioWorkerSupervisor(["node", "worker.mjs"])
        supervisor.process = process
        supervisor.stop(timeout=0.01)
        assert supervisor.process is process
        assert process.wait.call_args_list == [mock.call(timeout=0.01), mock.call(timeout=0.01)]

    @pytest.mark.parametrize("failure", ["permission", "reap"])
    def test_failed_cleanup_prevents_restart(self, process_groups: mock.Mock, failure: str) -> None:
        process = mock.Mock(wait=mock.Mock(return_value=1))
        popen = mock.Mock(side_effect=[process, AssertionError("must not restart before cleanup")])
        if failure == "permission":
            process_groups.side_effect = PermissionError("group is not signalable")
        else:
            process.wait.side_effect = [1, 1, subprocess.TimeoutExpired("node", 10)]
        supervisor = StudioWorkerSupervisor(["node", "worker.mjs"], popen=popen)
        supervisor.run()
        assert popen.call_count == 1
        assert supervisor.process is process

    def test_stop_cleans_an_exited_group_once(self, process_groups: mock.Mock) -> None:
        process = mock.Mock(poll=mock.Mock(return_value=1))
        process_groups.side_effect = ProcessLookupError
        supervisor = StudioWorkerSupervisor(["node", "worker.mjs"])
        supervisor.process = process
        supervisor.stop()
        supervisor.stop()
        assert supervisor.process is None
        assert process_groups.call_args_list == [
            mock.call(process.pid, signal.SIGTERM),
            mock.call(process.pid, signal.SIGKILL),
        ]
        process.wait.assert_any_call(timeout=10.0)


@pytest.mark.usefixtures("process_groups")
@pytest.mark.parametrize("code", [errno.EAGAIN, errno.ENOMEM, errno.EINTR, errno.EMFILE, errno.ENFILE])
def test_transient_spawn_error_retries_after_backoff(code: int) -> None:
    process = mock.Mock(wait=mock.Mock(return_value=0))
    supervisor = StudioWorkerSupervisor(
        ["node", "worker.mjs"], popen=mock.Mock(side_effect=[OSError(code, "resource exhausted"), process])
    )
    with mock.patch.object(supervisor.stopping, "wait") as wait:
        supervisor.run()
    assert supervisor.process is None
    wait.assert_called_once_with(10.0)


@pytest.mark.parametrize("code", [errno.ENOENT, errno.EACCES, errno.ENOEXEC, errno.EINVAL])
def test_permanent_spawn_error_stops_without_retry(code: int) -> None:
    supervisor = StudioWorkerSupervisor(
        ["missing", "worker.mjs"], popen=mock.Mock(side_effect=OSError(code, "bad config"))
    )
    with mock.patch.object(supervisor.stopping, "wait") as wait:
        supervisor.run()
    assert supervisor.process is None
    wait.assert_not_called()


@pytest.mark.usefixtures("process_groups")
def test_transient_spawn_failures_use_capped_backoff() -> None:
    process = mock.Mock(wait=mock.Mock(return_value=0))
    supervisor = StudioWorkerSupervisor(
        ["node", "worker.mjs"],
        popen=mock.Mock(side_effect=[OSError(errno.EAGAIN, "busy")] * 7 + [process]),
    )
    with mock.patch.object(supervisor.stopping, "wait") as wait:
        supervisor.run()
    assert supervisor.process is None
    assert wait.call_args_list == [mock.call(delay) for delay in (10, 20, 40, 80, 160, 300, 300)]


def test_stop_during_spawn_backoff_prevents_another_worker() -> None:
    popen = mock.Mock(side_effect=OSError(errno.EAGAIN, "busy"))
    supervisor = StudioWorkerSupervisor(["node", "worker.mjs"], popen=popen)
    with mock.patch.object(supervisor.stopping, "wait", side_effect=lambda _: supervisor.stop()):
        supervisor.run()
    assert supervisor.stopping.is_set()
    assert popen.call_count == 1


@pytest.mark.skipif(os.name != "posix", reason="Studio workers run in POSIX containers")
@pytest.mark.parametrize("exit_mode", ["stop", "crash", "clean"])
def test_worker_exit_cleans_up_descendants(tmp_path: Path, exit_mode: str) -> None:
    pid_file = tmp_path / "child-pid"
    release = tmp_path / "release"
    script = """
import os, signal, subprocess, sys, time
from pathlib import Path
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
pid_file = Path(sys.argv[1])
pid_file.with_suffix(".tmp").write_text(str(child.pid))
pid_file.with_suffix(".tmp").replace(pid_file)
while not Path(sys.argv[2]).exists():
    time.sleep(.01)
os._exit(int(sys.argv[3]))
"""
    supervisor = StudioWorkerSupervisor(
        [sys.executable, "-c", script, str(pid_file), str(release), "1" if exit_mode == "crash" else "0"]
    )
    child_pid = None
    try:
        # Stop at the restart delay so cleanup must finish before a replacement can start.
        with mock.patch.object(supervisor.stopping, "wait", side_effect=lambda _: supervisor.stopping.set()):
            supervisor.start()
            deadline = time.monotonic() + 5
            while not pid_file.exists():
                assert time.monotonic() < deadline, "worker did not spawn its child"
                time.sleep(0.01)
            child_pid = int(pid_file.read_text())
            if exit_mode == "stop":
                supervisor.stop(timeout=0.05)
            else:
                release.touch()
            supervisor.thread.join(timeout=5)
            assert not supervisor.thread.is_alive()
            deadline = time.monotonic() + 2
            while True:
                try:
                    if psutil.Process(child_pid).status() == psutil.STATUS_ZOMBIE:
                        break
                except psutil.NoSuchProcess:
                    break
                assert time.monotonic() < deadline, "Studio descendant survived worker exit"
                time.sleep(0.01)
    finally:
        supervisor.stop(timeout=0.05)
        if child_pid is not None:
            try:
                os.kill(child_pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        supervisor.thread.join(timeout=5)
