"""Bound decoded audio buffers across HTTP lifetimes and uncancellable native operations."""

import asyncio
from concurrent.futures import Executor
from threading import Lock
from typing import Any, Callable, TypeVar

from .inference_executor import InferenceBusy

T = TypeVar("T")


class AudioMemoryBudget:
    def __init__(self, limit: int) -> None:
        if limit <= 0:
            raise ValueError("Audio memory budget must be positive")
        self.limit = limit
        self._used = 0
        self._lock = Lock()

    def reserve(self, size: int) -> "AudioMemoryReservation":
        if size <= 0:
            raise ValueError("Audio reservation must be positive")
        with self._lock:
            if size > self.limit - self._used:
                raise InferenceBusy("ml_worker_busy")
            self._used += size
        return AudioMemoryReservation(self, size)


class AudioMemoryReservation:
    def __init__(self, budget: AudioMemoryBudget, size: int) -> None:
        self._budget = budget
        self._size = size
        self._owners = 1
        self._released = False
        self._cleanup: Callable[[], None] | None = None

    def set_cleanup(self, cleanup: Callable[[], None]) -> None:
        """Register final buffer cleanup while the request still owns the reservation."""
        with self._budget._lock:
            if self._released or self._cleanup is not None:
                raise RuntimeError("Audio cleanup is already registered or reservation is released")
            self._cleanup = cleanup

    def release(self) -> None:
        """Drop the HTTP owner once; native operations retain their own ownership."""
        with self._budget._lock:
            if self._released:
                return
            self._released = True
        self._operation_done()

    def _operation_done(self) -> None:
        with self._budget._lock:
            self._owners -= 1
            if self._owners:
                return
        try:
            if self._cleanup is not None:
                self._cleanup()
        finally:
            self._cleanup = None
            with self._budget._lock:
                self._budget._used -= self._size

    async def run(self, executor: Executor | None, func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        with self._budget._lock:
            if self._released:
                raise RuntimeError("Audio reservation is released")
            self._owners += 1
        if executor is None:
            try:
                return func(*args, **kwargs)
            finally:
                self._operation_done()
        try:
            future = executor.submit(func, *args, **kwargs)
        except BaseException:
            self._operation_done()
            raise
        # An asyncio Future can cancel while the underlying thread is still using the audio.
        future.add_done_callback(lambda _: self._operation_done())
        return await asyncio.wrap_future(future)
