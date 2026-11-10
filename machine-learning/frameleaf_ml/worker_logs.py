import json
import logging
import re
import sqlite3
from collections import deque
from contextlib import closing
from datetime import datetime, timezone
from ipaddress import IPv6Address, ip_address
from pathlib import Path
from threading import Lock
from uuid import uuid4

_MASK = "[redacted]"
_KEY = re.compile(
    r"""(?<![\w.-])(?P<key>["']?[\w.-]{1,128}["']?)(?P<separator>\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|[^\s&,;]+)"""
)
_SECRET = re.compile(r"authorization|cookie|password|passphrase|pin(code)?|token|secret|apikey|privatekey|sessionkey")


def _assignment(match: re.Match[str]) -> str:
    key = re.sub(r"[^a-z0-9]", "", match["key"].lower())
    if _SECRET.search(key) or key in {"key", "code", "state", "slug"}:
        return f"{match['key']}{match['separator']}{_MASK}"
    return match[0]


def redact_worker_message(message: str) -> str:
    if len(message) > 16_384:
        return "[oversized log message omitted]"
    text = re.sub(r"-----BEGIN [^\r\n-]*PRIVATE KEY-----[\s\S]*", _MASK, message, flags=re.I)
    text = re.sub(
        r"\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*", _MASK, text, flags=re.I
    )
    text = re.sub(r"\bBearer\s+\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+", _MASK, text, flags=re.I)
    text = re.sub(r"""\b(?:https?|s3)://[^\s"'<>]+""", _MASK, text, flags=re.I)
    text = _KEY.sub(_assignment, text)
    text = re.sub(r"(?<![\w.!#$%&'*+/=?^\x60{|}~-])[\w.!#$%&'*+/=?^\x60{|}~-]{1,128}@[\w.-]+\.[\w-]+", _MASK, text)
    return re.sub(r"[\x00-\x1f\x7f]+", " ", text)[:2048]


def local_log_reader(host: str | None) -> bool:
    try:
        address = ip_address(host or "")
    except ValueError:
        return False
    if isinstance(address, IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return address.is_loopback or (address.is_private and not address.is_unspecified and not address.is_link_local)


def initialize_worker_log_spool(path: Path) -> None:
    with closing(sqlite3.connect(path)) as database:
        database.execute("PRAGMA journal_mode = WAL")
        database.execute("CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY, at TEXT NOT NULL, row TEXT NOT NULL)")
        database.commit()


class WorkerLogs(logging.Handler):
    def __init__(self, shared_path: Path | None = None) -> None:
        super().__init__()
        self.rows: deque[tuple[str, str]] = deque(maxlen=5000)
        self.rows_lock = Lock()
        self.database = None
        if shared_path is not None:
            self.database = sqlite3.connect(shared_path, timeout=0.1, check_same_thread=False)
            self.database.execute("PRAGMA synchronous = NORMAL")

    def close(self) -> None:
        with self.rows_lock:
            if self.database is not None:
                self.database.close()
                self.database = None
        super().close()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            at = datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat(timespec="milliseconds")
            at = at.replace("+00:00", "Z")
            row = json.dumps(
                {
                    "id": str(uuid4()),
                    "at": at,
                    "level": {"info": "log", "warning": "warn", "critical": "fatal"}.get(
                        record.levelname.lower(), record.levelname.lower()
                    ),
                    "context": "MachineLearning",
                    "message": redact_worker_message(record.getMessage()),
                },
                ensure_ascii=False,
            )
        except Exception:
            return
        with self.rows_lock:
            if self.database is None:
                self.rows.append((at, row))
            else:
                try:
                    with self.database:
                        result = self.database.execute("INSERT INTO log (at, row) VALUES (?, ?)", (at, row))
                        if result.lastrowid is not None:
                            self.database.execute("DELETE FROM log WHERE id <= ?", (result.lastrowid - 5000,))
                except sqlite3.Error:
                    # A busy log spool must never fail an inference request.
                    return

    def recent(self, since: str) -> str:
        with self.rows_lock:
            if self.database is None:
                return "".join(f"{row}\n" for at, row in self.rows if at >= since)
            return "".join(
                f"{row}\n"
                for (row,) in self.database.execute("SELECT row FROM log WHERE at >= ? ORDER BY id", (since,))
            )
