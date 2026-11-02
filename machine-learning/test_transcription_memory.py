"""Input memory admission uses headers and follows native work through cancellation."""

import asyncio
import io
import struct
from threading import Event

import numpy as np
import pytest

from frameleaf_ml.inference_executor import InferenceBusy, InferenceExecutor
from frameleaf_ml.models.transcribe import AudioFormatError, read_wav


def header(data_bytes: int) -> bytes:
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        36 + data_bytes,
        b"WAVE",
        b"fmt ",
        16,
        1,
        1,
        16000,
        32000,
        2,
        16,
        b"data",
        data_bytes,
    )


@pytest.mark.parametrize("data", [header(8) + b"\0\0", header(3) + b"\0\0\0"])
def test_refuses_truncated_or_partial_pcm_frames(data):
    with pytest.raises(AudioFormatError):
        read_wav(data)


def test_normalizes_the_single_float_buffer_in_place(monkeypatch):
    original = np.frombuffer
    converted = []

    class PCM(np.ndarray):
        def astype(self, *args, **kwargs):
            result = super().astype(*args, **kwargs)
            converted.append(result)
            return result

    monkeypatch.setattr(np, "frombuffer", lambda *a, **kw: original(*a, **kw).view(PCM))
    samples = read_wav(header(8) + struct.pack("<hhhh", -32768, -16384, 0, 32767))
    assert samples is converted[0]
    np.testing.assert_array_equal(samples, [-1, -0.5, 0, 32767 / 32768])


def test_header_sizing_restores_offset_and_includes_both_buffers():
    from frameleaf_ml.models.transcribe import wav_memory_bytes

    stream = io.BytesIO(b"prefix" + header(8) + bytes(8))
    stream.seek(6)
    assert wav_memory_bytes(stream) == 24
    assert stream.tell() == 6
    malformed = io.BytesIO(b"prefix" + header(8))
    malformed.seek(6)
    with pytest.raises(AudioFormatError):
        wav_memory_bytes(malformed)
    assert malformed.tell() == 6


def test_four_hour_pcm_is_admissible_without_reading_payload(tmp_path):
    from frameleaf_ml.config import settings
    from frameleaf_ml.models.transcribe import wav_memory_bytes
    from frameleaf_ml.transcription_memory import AudioMemoryBudget

    path = tmp_path / "four-hours.wav"
    with path.open("w+b") as stream:
        stream.write(header(460800000))
        stream.truncate(460800044)
        stream.seek(0)
        required = wav_memory_bytes(stream)
    assert required == 1382400000
    lease = AudioMemoryBudget(settings.transcription_max_memory_mb * 1024 * 1024).reserve(required)
    lease.release()


def test_budget_refuses_overload_and_releases_only_once():
    from frameleaf_ml.transcription_memory import AudioMemoryBudget

    budget = AudioMemoryBudget(24)
    lease = budget.reserve(24)
    with pytest.raises(InferenceBusy, match="ml_worker_busy"):
        budget.reserve(1)
    lease.release()
    lease.release()
    second = budget.reserve(24)
    with pytest.raises(InferenceBusy):
        budget.reserve(1)
    second.release()


@pytest.mark.asyncio
async def test_cancelled_native_operation_keeps_audio_memory_reserved():
    from frameleaf_ml.transcription_memory import AudioMemoryBudget

    started, finish = Event(), Event()
    budget = AudioMemoryBudget(24)
    lease = budget.reserve(24)

    def blocking():
        started.set()
        assert finish.wait(5)

    with InferenceExecutor(1) as pool:
        task = asyncio.create_task(lease.run(pool, blocking))
        while not started.is_set():
            await asyncio.sleep(0)
        try:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            lease.release()
            with pytest.raises(InferenceBusy):
                budget.reserve(24)
        finally:
            finish.set()
    replacement = budget.reserve(24)
    replacement.release()


@pytest.mark.asyncio
async def test_native_completion_keeps_request_owner_and_submission_failure_releases_operation():
    from frameleaf_ml.transcription_memory import AudioMemoryBudget

    budget = AudioMemoryBudget(24)
    lease = budget.reserve(24)
    with InferenceExecutor(1) as pool:
        assert await lease.run(pool, lambda: 7) == 7
    with pytest.raises(InferenceBusy):
        budget.reserve(1)
    with pytest.raises(RuntimeError):
        await lease.run(pool, lambda: None)
    lease.release()
    budget.reserve(24).release()


@pytest.mark.parametrize("offset,value", [(4, 10), (16, 1000), (28, 1), (32, 4), (40, 10)])
def test_refuses_inconsistent_riff_or_pcm_header(offset, value):
    data = bytearray(header(8) + bytes(8))
    struct.pack_into("<H" if offset == 32 else "<I", data, offset, value)
    with pytest.raises(AudioFormatError):
        read_wav(bytes(data))


def test_header_sizing_reads_only_fixed_headers_even_for_large_fmt_chunk(tmp_path):
    from frameleaf_ml.models.transcribe import wav_memory_bytes

    # The format extension is skipped, never read into a request-sized buffer.
    fmt_size = 512 * 1024 * 1024
    path = tmp_path / "large-format.wav"
    with path.open("w+b") as stream:
        stream.write(header(8)[:36])
        stream.seek(16)
        stream.write(struct.pack("<I", fmt_size))
        stream.seek(4)
        stream.write(struct.pack("<I", 4 + 8 + fmt_size + 8 + 8))
        stream.seek(20 + fmt_size)
        stream.write(b"data" + struct.pack("<I", 8) + bytes(8))
        stream.seek(0)

        class HeaderOnly:
            def read(self, size):
                assert 0 <= size <= 40
                return stream.read(size)

            def seek(self, *args):
                return stream.seek(*args)

            def tell(self):
                return stream.tell()

        assert wav_memory_bytes(HeaderOnly()) == 24
        assert stream.tell() == 0


def test_refuses_over_four_hours_without_allocating_audio(tmp_path):
    from frameleaf_ml.models.transcribe import wav_memory_bytes

    with (tmp_path / "too-long.wav").open("w+b") as stream:
        stream.write(header(460800002))
        stream.truncate(460800046)
        stream.seek(0)
        with pytest.raises(AudioFormatError, match="longer"):
            wav_memory_bytes(stream)
        assert stream.tell() == 0


@pytest.mark.asyncio
async def test_busy_executor_does_not_leak_an_audio_owner():
    from frameleaf_ml.transcription_memory import AudioMemoryBudget

    started, finish = Event(), Event()
    budget = AudioMemoryBudget(24)
    lease = budget.reserve(24)

    def blocking():
        started.set()
        assert finish.wait(5)

    with InferenceExecutor(1) as pool:
        operation = pool.submit(blocking)
        assert started.wait(2)
        try:
            with pytest.raises(InferenceBusy):
                await lease.run(pool, lambda: None)
            lease.release()
            budget.reserve(24).release()
        finally:
            finish.set()
        operation.result(2)


@pytest.mark.asyncio
async def test_native_error_releases_operation_but_not_live_request_owner():
    from frameleaf_ml.transcription_memory import AudioMemoryBudget

    budget = AudioMemoryBudget(24)
    lease = budget.reserve(24)

    def failing():
        raise ValueError("native failure")

    with InferenceExecutor(1) as pool:
        with pytest.raises(ValueError, match="native failure"):
            await lease.run(pool, failing)
    with pytest.raises(InferenceBusy):
        budget.reserve(1)
    lease.release()
    budget.reserve(24).release()


@pytest.mark.parametrize("value", [0, -1])
def test_invalid_budget_setting_is_rejected(value):
    from pydantic import ValidationError

    from frameleaf_ml.config import Settings

    with pytest.raises(ValidationError):
        Settings(transcription_max_memory_mb=value)


@pytest.mark.asyncio
async def test_cancelled_stream_closes_iterator_before_returning_memory_capacity():
    import weakref

    from frameleaf_ml.transcription_memory import AudioMemoryBudget

    class Payload:
        pass

    started, finish, cleaned = Event(), Event(), Event()
    payload_ref = None

    def stream():
        nonlocal payload_ref
        payload = Payload()
        payload_ref = weakref.ref(payload)
        yield None
        started.set()
        assert finish.wait(5)
        yield None

    budget = AudioMemoryBudget(24)
    lease = budget.reserve(24)
    items = stream()
    next(items)

    def cleanup():
        items.close()
        assert payload_ref() is None
        with pytest.raises(InferenceBusy):
            budget.reserve(24)
        cleaned.set()

    lease.set_cleanup(cleanup)
    with InferenceExecutor(1) as pool:
        task = asyncio.create_task(lease.run(pool, next, items, None))
        while not started.is_set():
            await asyncio.sleep(0)
        try:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            lease.release()
            assert not cleaned.is_set()
            assert payload_ref() is not None
            with pytest.raises(InferenceBusy):
                budget.reserve(24)
        finally:
            finish.set()
    assert cleaned.is_set()
    assert payload_ref() is None
    budget.reserve(24).release()


@pytest.mark.parametrize("raises", [False, True])
def test_final_cleanup_runs_once_before_capacity_returns_without_native_operations(raises):
    from frameleaf_ml.transcription_memory import AudioMemoryBudget

    budget = AudioMemoryBudget(24)
    lease = budget.reserve(24)
    cleanups = []

    def cleanup():
        cleanups.append(True)
        with pytest.raises(InferenceBusy):
            budget.reserve(24)
        if raises:
            raise ValueError("cleanup failed")

    lease.set_cleanup(cleanup)
    if raises:
        with pytest.raises(ValueError, match="cleanup failed"):
            lease.release()
    else:
        lease.release()
    lease.release()
    assert cleanups == [True]
    budget.reserve(24).release()
