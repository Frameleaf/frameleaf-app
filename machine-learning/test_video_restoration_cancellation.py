"""Exercise transport cancellation and the production server's SIGTERM ordering over TCP."""

import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from test_video_restoration import request_payload

SERVER = """
import os, sys, time
from pathlib import Path
from types import SimpleNamespace
from immich_ml.video_restoration import app, __main__ as entrypoint
from immich_ml.video_restoration.models import RuntimeInvocation, SelectedModel
from test_video_restoration_runtime import warm_spec, invocation
from test_video_restoration import TestRegistry, evaluate, passing_record, fake_result

root = Path(sys.argv[1])
spec = warm_spec(root)
(root / 'fake_model.py').write_text('''
import os, signal, sys, time
from pathlib import Path
def init_model(config, checkpoint=None):
    return object()
def main():
    init_model(sys.argv[1], sys.argv[2])
    if sys.argv[3] == 'blocked':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        Path('active-pid').write_text(str(os.getpid()))
        time.sleep(90)
if __name__ == '__main__':
    main()
''')
registry = TestRegistry().write_config(root, spec, passing_record(spec))
selected = SelectedModel(spec=spec, capability=evaluate(spec), weights_root=root)
def restore(registry, request, media_path, work_dir, *, adapter_factory):
    runner = adapter_factory(selected).runner
    call = invocation(spec, root, request.requestId)
    if sys.argv[3] == 'process':
        call = RuntimeInvocation(
            [sys.executable, 'fake_model.py', 'config', 'checkpoint', request.requestId],
            root, dict(os.environ), 90,
        )
    try:
        runner(call)
    except Exception:
        # Hold cleanup after the model has closed to prove the HTTP admission slot
        # remains owned until the synchronous request thread actually finishes.
        (root / 'cleanup-started').touch()
        deadline = time.monotonic() + 15
        while not (root / 'cleanup-release').exists() and time.monotonic() < deadline:
            time.sleep(.02)
        raise
    output = work_dir / 'restored.mp4'
    output.write_bytes(b'restored')
    return fake_result(output), output
app.restore = restore
work = root / 'work'
work.mkdir()
application = app.create_app(registry, work_root=work, refresh_on_startup=False)
entrypoint.create_app_from_env = lambda: (application, SimpleNamespace(host='127.0.0.1', port=int(sys.argv[2])))
entrypoint.main()
"""


def wait_for_file(path: Path, server: subprocess.Popen[bytes], timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while not path.exists():
        assert server.poll() is None, "HTTP worker exited unexpectedly"
        assert time.monotonic() < deadline, f"worker did not reach {path.name}"
        time.sleep(0.02)


@pytest.mark.parametrize("protocol", ["warm-v1", "process"])
@pytest.mark.parametrize("cancel", ["disconnect", "sigterm"])
def test_http_cancellation_closes_runtime_before_releasing_admission(
    tmp_path: Path, protocol: str, cancel: str
) -> None:
    with socket.socket() as reserve:
        reserve.bind(("127.0.0.1", 0))
        port = reserve.getsockname()[1]
    with (tmp_path / "server.log").open("wb") as log:
        server = subprocess.Popen(
            [sys.executable, "-c", SERVER, str(tmp_path), str(port), protocol],
            stdout=log,
            stderr=log,
            start_new_session=True,
        )
        connection: socket.socket | None = None
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5) as client:
                deadline = time.monotonic() + 15
                while True:
                    assert server.poll() is None, (tmp_path / "server.log").read_text()
                    try:
                        if client.get("/ping").status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    assert time.monotonic() < deadline, "HTTP worker did not start"
                    time.sleep(0.02)
                request = client.build_request(
                    "POST",
                    "/restoration/restore",
                    data={"request": json.dumps(request_payload(requestId="blocked"))},
                    files={"media": ("clip.mp4", b"video", "video/mp4")},
                )
                body = request.read()
                headers = b"\r\n".join(name + b": " + value for name, value in request.headers.raw)
                connection = socket.create_connection(("127.0.0.1", port), timeout=5)
                connection.sendall(b"POST /restoration/restore HTTP/1.1\r\n" + headers + b"\r\n\r\n" + body)
                wait_for_file(tmp_path / "active-pid", server)
                runtime_pid = int((tmp_path / "active-pid").read_text())
                if cancel == "disconnect":
                    connection.close()
                else:
                    server.terminate()  # Real SIGTERM, while the HTTP request and model are blocked.
                wait_for_file(tmp_path / "cleanup-started", server)
                with pytest.raises(ProcessLookupError):
                    os.kill(runtime_pid, 0)
                assert server.poll() is None
                assert list((tmp_path / "work").iterdir())
                if cancel == "disconnect":
                    response = client.send(request)
                    assert response.json()["code"] == "busy", response.text
                (tmp_path / "cleanup-release").touch()
                if cancel == "sigterm":
                    server.wait(timeout=10)
                else:
                    deadline = time.monotonic() + 10
                    while list((tmp_path / "work").iterdir()):
                        assert time.monotonic() < deadline, "cancelled request did not clean up"
                        time.sleep(0.02)
                    response = client.post(
                        "/restoration/restore",
                        data={"request": json.dumps(request_payload(requestId="recovered"))},
                        files={"media": ("clip.mp4", b"video", "video/mp4")},
                    )
                    assert response.status_code == 200, response.text
                    # FileResponse cleanup runs after its last bytes have reached the client.
                    deadline = time.monotonic() + 10
                    while list((tmp_path / "work").iterdir()):
                        assert time.monotonic() < deadline, "response did not clean up"
                        time.sleep(0.02)
                assert list((tmp_path / "work").iterdir()) == []
        finally:
            if connection is not None:
                connection.close()
            # A red test must not leave its deliberately blocked, separately-sessioned model alive.
            pid_file = tmp_path / "active-pid"
            if pid_file.exists():
                try:
                    os.killpg(int(pid_file.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass
            (tmp_path / "cleanup-release").touch()
            if server.poll() is None:
                server.kill()
            server.wait(timeout=10)
