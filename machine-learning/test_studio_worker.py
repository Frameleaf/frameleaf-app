"""FL-408: the bundled Studio render worker starts by default, can be turned off, and is supervised."""

import errno
import subprocess
from pathlib import Path
from unittest import mock

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


class TestSupervisor:
    def test_restarts_a_crashed_worker_and_stops_on_clean_exit(self) -> None:
        processes = [mock.Mock(wait=mock.Mock(return_value=1)), mock.Mock(wait=mock.Mock(return_value=0))]
        popen = mock.Mock(side_effect=processes)
        supervisor = StudioWorkerSupervisor(["node", "worker.mjs"], popen=popen, clock=lambda: 0.0)
        with mock.patch.object(supervisor.stopping, "wait") as wait:
            supervisor.run()
        assert popen.call_count == 2
        wait.assert_called_once_with(MIN_BACKOFF_S * 2)

    def test_stop_terminates_the_running_worker(self) -> None:
        process = mock.Mock(poll=mock.Mock(return_value=None))
        supervisor = StudioWorkerSupervisor(["node", "worker.mjs"], popen=mock.Mock())
        supervisor.process = process
        supervisor.stop()
        process.terminate.assert_called_once()
        assert supervisor.stopping.is_set()

    def test_stop_kills_a_worker_that_does_not_exit(self) -> None:
        process = mock.Mock(
            poll=mock.Mock(return_value=None), wait=mock.Mock(side_effect=subprocess.TimeoutExpired("node", 1))
        )
        supervisor = StudioWorkerSupervisor(["node", "worker.mjs"], popen=mock.Mock())
        supervisor.process = process
        supervisor.stop(timeout=0.01)
        process.kill.assert_called_once()

    def test_does_not_restart_after_stop(self) -> None:
        supervisor = StudioWorkerSupervisor(["node", "worker.mjs"], popen=mock.Mock())

        def exit_after_stop(*_args: object, **_kwargs: object) -> mock.Mock:
            supervisor.stopping.set()
            return mock.Mock(wait=mock.Mock(return_value=1))

        supervisor.popen = mock.Mock(side_effect=exit_after_stop)
        supervisor.run()
        assert supervisor.popen.call_count == 1

    def test_stop_during_spawn_terminates_the_new_worker(self) -> None:
        # stop() can run after the loop's check but before the new process is recorded; it then sees no
        # process to terminate, so the loop itself must not leave the fresh worker running.
        process = mock.Mock(wait=mock.Mock(return_value=-15))
        supervisor = StudioWorkerSupervisor(["node", "worker.mjs"], popen=mock.Mock())

        def stopped_while_spawning(*_args: object, **_kwargs: object) -> mock.Mock:
            supervisor.stop()
            return process

        supervisor.popen = mock.Mock(side_effect=stopped_while_spawning)
        supervisor.run()
        process.terminate.assert_called_once()


@pytest.mark.parametrize("code", [errno.EAGAIN, errno.ENOMEM, errno.EINTR, errno.EMFILE, errno.ENFILE])
def test_transient_spawn_error_retries_after_backoff(code: int) -> None:
    process = mock.Mock(wait=mock.Mock(return_value=0))
    supervisor = StudioWorkerSupervisor(
        ["node", "worker.mjs"], popen=mock.Mock(side_effect=[OSError(code, "resource exhausted"), process])
    )
    with mock.patch.object(supervisor.stopping, "wait") as wait:
        supervisor.run()
    assert supervisor.process is process
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


def test_transient_spawn_failures_use_capped_backoff() -> None:
    process = mock.Mock(wait=mock.Mock(return_value=0))
    supervisor = StudioWorkerSupervisor(
        ["node", "worker.mjs"],
        popen=mock.Mock(side_effect=[OSError(errno.EAGAIN, "busy")] * 7 + [process]),
    )
    with mock.patch.object(supervisor.stopping, "wait") as wait:
        supervisor.run()
    assert supervisor.process is process
    assert wait.call_args_list == [mock.call(delay) for delay in (10, 20, 40, 80, 160, 300, 300)]


def test_stop_during_spawn_backoff_prevents_another_worker() -> None:
    supervisor = StudioWorkerSupervisor(
        ["node", "worker.mjs"], popen=mock.Mock(side_effect=OSError(errno.EAGAIN, "busy"))
    )
    with mock.patch.object(supervisor.stopping, "wait", side_effect=lambda _: supervisor.stop()):
        supervisor.run()
    assert supervisor.stopping.is_set()
    assert supervisor.popen.call_count == 1
