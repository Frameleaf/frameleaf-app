"""Run through the launcher in a local Linux container."""
import errno
import os
import socket
import subprocess
import sys
import tempfile
from pathlib import Path


def check():
    assert os.getuid() != 0
    try:
        os.fstat(int(sys.argv[3]))
        raise AssertionError("launcher inherited an open IP socket")
    except OSError as error:
        assert error.errno == errno.EBADF
    for family in (socket.AF_INET, socket.AF_INET6, socket.AF_NETLINK):
        for method in (socket.socket, socket.socketpair):
            try:
                with method(family):
                    raise AssertionError(f"network socket allowed: {family}")
            except PermissionError as error:
                assert error.errno == errno.EPERM
    unix = socket.socket(socket.AF_UNIX)
    unix.connect(sys.argv[2])
    unix.sendall(b"local")
    unix.close()
    result = subprocess.run(
        [sys.executable, "-c", "import socket; socket.socket(socket.AF_INET)"],
        capture_output=True, check=False,
    )
    assert result.returncode and b"PermissionError" in result.stderr


def run(launcher):
    with tempfile.TemporaryDirectory(prefix="flmd-native-", dir="/tmp") as workspace:
        parent = Path(workspace)
        parent.chmod(0o711)
        stage = parent / "stage"
        stage.mkdir(mode=0o700)
        path = parent / "s"
        with socket.socket(socket.AF_UNIX) as broker, socket.socket(socket.AF_INET) as inherited:
            broker.bind(str(path))
            path.chmod(0o666)
            broker.listen(1)
            broker.settimeout(10)
            child = subprocess.Popen(
                [launcher, str(stage), "204107", sys.executable, __file__, "check", str(path), str(inherited.fileno())],
                pass_fds=(inherited.fileno(),),
            )
            with child:
                connection, _ = broker.accept()
                with connection:
                    assert connection.recv(16) == b"local"
                assert child.wait(timeout=10) == 0


if __name__ == "__main__":
    if sys.argv[1] == "check":
        check()
    else:
        run(sys.argv[1])
