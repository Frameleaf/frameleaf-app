import ctypes
import sys

_process = ctypes.CDLL(None) if sys.platform != "win32" else None


def release() -> None:
    if hasattr(_process, "mi_collect"):
        _process.mi_collect(True)
    elif hasattr(_process, "malloc_trim"):
        _process.malloc_trim(0)
