"""Run through the launcher in a local Linux container."""
import ctypes
import errno
import os
import platform
import resource
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

HIGH = 3000
RUNNER = 204107
# clone and clone3 syscall numbers, and the namespace flags the filter refuses.
SYSCALLS = {"x86_64": (56, 435), "aarch64": (220, 435)}
CLONE_NEWUSER, CLONE_NEWNS, SIGCHLD = 0x10000000, 0x00020000, 17


def namespaces_refused():
    """clone with namespace flags fails with EPERM and clone3 with ENOSYS, so libc falls back to plain clone."""
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    clone, clone3 = SYSCALLS[platform.machine()]
    child = libc.syscall(ctypes.c_long(clone), ctypes.c_ulong(CLONE_NEWUSER | CLONE_NEWNS | SIGCHLD),
                         ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0))
    if child == 0:
        os._exit(0)
    if child > 0:
        os.waitpid(child, 0)
        raise AssertionError("clone made new namespaces")
    assert ctypes.get_errno() == errno.EPERM, ctypes.get_errno()
    assert libc.syscall(ctypes.c_long(clone3), ctypes.c_void_p(0), ctypes.c_ulong(0)) == -1
    assert ctypes.get_errno() == errno.ENOSYS, ctypes.get_errno()


def check():
    """Runs inside the launcher: no inherited descriptor, no IP networking, the local socket still works."""
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
    namespaces_refused()
    # A fresh runner UID (root caller) gets a task limit; a rootless runner shares the server's UID and does not.
    if os.getuid() == RUNNER:
        assert resource.getrlimit(resource.RLIMIT_NPROC) == (1024, 1024)


def run(launcher):
    """Starts the launcher with an inherited socket and waits for the child to report over the local socket."""
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
            # A descriptor numbered above a hard limit that is lowered after it was opened must be closed too.
            soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
            resource.setrlimit(resource.RLIMIT_NOFILE, (max(soft, HIGH + 1), hard))
            os.dup2(inherited.fileno(), HIGH, inheritable=True)
            child = subprocess.Popen(
                [launcher, str(stage), str(RUNNER), sys.executable, __file__, "check", str(path), str(HIGH)],
                pass_fds=(HIGH,),
                preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_NOFILE, (1024, 1024)),
            )
            os.close(HIGH)
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
