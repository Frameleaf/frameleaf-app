import json
import logging

from frameleaf_ml.worker_logs import WorkerLogs, local_log_reader


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


def test_public_address_cannot_read_worker_logs():
    assert local_log_reader("172.20.0.2")
    assert local_log_reader("::ffff:127.0.0.1")
    assert not local_log_reader("8.8.8.8")
