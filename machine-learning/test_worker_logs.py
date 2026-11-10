import json
import logging

import pytest

from frameleaf_ml.worker_logs import WorkerLogs, initialize_worker_log_spool, local_log_reader, redact_worker_message


def test_recent_worker_logs_redact_secrets_and_filter_by_time():
    logs = WorkerLogs()
    record = logging.LogRecord(
        "test",
        logging.WARNING,
        "test_worker_logs.py",
        1,
        "Request from user@example.com with token=private-value",
        (),
        None,
    )
    logs.emit(record)
    row = json.loads(logs.recent(""))
    assert row["level"] == "warn"
    assert row["message"] == "Request from [redacted] with token=[redacted]"
    assert not logs.recent("2999-01-01T00:00:00.000Z")


@pytest.mark.parametrize(
    "message",
    [
        "x-immich-share-key: private-share-key",
        "x-frameleaf-share-key=private-share-key",
        '{"shareKey": "private-share-key"}',
        "sharedLinkKey=private-share-key",
        "shared_link_key: private-share-key",
        "GET /api/shared-links/me?key=private-share-key&slug=private-slug",
    ],
)
def test_share_keys_are_redacted(message: str) -> None:
    redacted = redact_worker_message(message)
    assert "[redacted]" in redacted
    assert "private-share-key" not in redacted
    assert "private-slug" not in redacted


def test_public_address_cannot_read_worker_logs():
    assert local_log_reader("172.20.0.2")
    assert local_log_reader("::ffff:127.0.0.1")
    assert not local_log_reader("8.8.8.8")


def test_separate_workers_share_the_latest_5000_redacted_events(tmp_path):
    path = tmp_path / "logs.sqlite3"
    initialize_worker_log_spool(path)
    first = WorkerLogs(path)
    second = WorkerLogs(path)
    try:
        for index in range(5002):
            record = logging.LogRecord(
                "test",
                logging.INFO,
                "test_worker_logs.py",
                1,
                "worker-%d token=private",
                (index,),
                None,
            )
            (first if index % 2 else second).emit(record)
        rows = [json.loads(row) for row in second.recent("").splitlines()]
        assert len(rows) == 5000
        assert rows[0]["message"] == "worker-2 token=[redacted]"
        assert rows[-1]["message"] == "worker-5001 token=[redacted]"
    finally:
        first.close()
        second.close()
