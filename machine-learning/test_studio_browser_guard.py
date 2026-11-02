import ctypes
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


@unittest.skipUnless(sys.platform == "linux", "container browser guard uses Linux process identities")
class TestStudioBrowserGuard(unittest.TestCase):
    def test_detached_browser_children_stop_after_owner_or_browser_crash(self) -> None:
        libc = ctypes.CDLL(None, use_errno=True)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)  # Reap adopted fixture descendants without relying on PID 1.
        try:
            for crashed in ("owner", "browser"):
                with self.subTest(crashed=crashed), tempfile.TemporaryDirectory() as temporary:
                    folder = Path(temporary)
                    guard = folder / "frameleaf-studio-browser"
                    shutil.copyfile(Path(__file__).parent / "scripts/studio-browser-guard.py", guard)
                    guard.chmod(0o755)
                    browser = folder / "frameleaf-studio-chromium"
                    browser.write_text(
                        f"#!{sys.executable}\n"
                        "import json, os, signal, sys, time\n"
                        "child = os.fork()\n"
                        "if child == 0:\n"
                        " signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                        " while True: time.sleep(1)\n"
                        "with open(sys.argv[1] + '.tmp', 'w') as output:\n"
                        " json.dump({'browser': os.getpid(), 'child': child, 'args': sys.argv[2:]}, output)\n"
                        "os.replace(sys.argv[1] + '.tmp', sys.argv[1])\n"
                        "while True: time.sleep(1)\n"
                    )
                    browser.chmod(0o755)
                    pids_file = folder / "pids.json"
                    owner = subprocess.Popen(
                        [
                            sys.executable,
                            "-c",
                            "import os, subprocess, sys; "
                            "os.environ['FRAMELEAF_STUDIO_OWNER_PID'] = str(os.getpid()); "
                            "sys.exit(subprocess.Popen(sys.argv[1:], start_new_session=True).wait())",
                            str(guard),
                            str(pids_file),
                            "--no-sandbox",
                        ],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                    )
                    pids = {}
                    try:
                        deadline = time.monotonic() + 5
                        while not pids_file.exists() and time.monotonic() < deadline:
                            time.sleep(0.01)
                        self.assertTrue(pids_file.exists(), "detached browser never launched")
                        pids = json.loads(pids_file.read_text())
                        self.assertEqual(pids["args"], ["--no-sandbox"])
                        time.sleep(0.2)
                        for key in ("browser", "child"):
                            fields = Path(f"/proc/{pids[key]}/stat").read_text().rsplit(")", 1)[1].split()
                            self.assertNotIn(fields[0], {"Z", "X"}, "healthy browser was terminated")
                        os.kill(owner.pid if crashed == "owner" else pids["browser"], signal.SIGKILL)
                        owner.wait(timeout=5)
                        deadline = time.monotonic() + 3
                        while time.monotonic() < deadline:
                            self.reap()
                            if not any(Path(f"/proc/{pids[key]}").exists() for key in ("browser", "child")):
                                break
                            time.sleep(0.01)
                        self.assertFalse(Path(f"/proc/{pids['browser']}").exists(), "browser survived owner loss")
                        self.assertFalse(Path(f"/proc/{pids['child']}").exists(), "browser child survived cleanup")
                    finally:
                        if pids:
                            try:
                                os.killpg(pids["browser"], signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                        if owner.poll() is None:
                            owner.kill()
                        owner.wait(timeout=5)
                        assert owner.stderr is not None
                        owner.stderr.close()
                        self.reap()
        finally:
            libc.prctl(36, 0, 0, 0, 0)

    @staticmethod
    def reap() -> None:
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            pass

    def test_refuses_unowned_or_shared_process_groups(self) -> None:
        guard = Path(__file__).parent / "scripts/studio-browser-guard.py"
        for detached, owner in ((True, "1"), (False, str(os.getpid()))):
            with self.subTest(detached=detached, owner=owner):
                result = subprocess.run(
                    [sys.executable, str(guard)],
                    env={**os.environ, "FRAMELEAF_STUDIO_OWNER_PID": owner},
                    start_new_session=detached,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("requires its live direct owner and a detached process group", result.stderr)


if __name__ == "__main__":
    unittest.main()
