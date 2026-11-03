"""Bound native work until its concurrent future finishes, even after HTTP cancellation."""

from concurrent.futures import Future, ThreadPoolExecutor
from threading import BoundedSemaphore, Lock
from typing import Any, Callable, TypeVar

T = TypeVar("T")


class InferenceBusy(RuntimeError):
    pass


class InferenceExecutor(ThreadPoolExecutor):
    def __init__(self, max_workers: int, **kwargs: Any) -> None:
        super().__init__(max_workers, **kwargs)
        # Admit only worker slots; overload stays in the durable server queue.
        self._slots = BoundedSemaphore(max_workers)
        self._pending_lock = Lock()
        self._pending = 0

    @property
    def busy(self) -> bool:
        with self._pending_lock:
            return self._pending > 0

    def submit(self, fn: Callable[..., T], /, *args: Any, **kwargs: Any) -> Future[T]:
        if not self._slots.acquire(blocking=False):
            raise InferenceBusy("ml_worker_busy")
        with self._pending_lock:
            self._pending += 1
        try:
            future = super().submit(fn, *args, **kwargs)
        except BaseException:
            self._release()
            raise
        future.add_done_callback(lambda _: self._release())
        return future

    def _release(self) -> None:
        with self._pending_lock:
            self._pending -= 1
        self._slots.release()
