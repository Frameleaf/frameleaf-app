import json
import logging
import re
from collections import deque
from datetime import datetime, timezone
from ipaddress import IPv6Address, ip_address
from threading import Lock
from uuid import uuid4

_MASK = "[redacted]"
_KEY = re.compile(
    r"""(?P<key>["']?[\w.-]+["']?)(?P<separator>\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|[^\s&,;]+)"""
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
    text = re.sub(r"\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*", _MASK, text, flags=re.I)
    text = re.sub(r"\bBearer\s+\S+|\beyJ[\w-]+\.[\w-]+\.[\w-]+", _MASK, text, flags=re.I)
    text = re.sub(r"""\b(?:https?|s3)://[^\s"'<>]+""", _MASK, text, flags=re.I)
    text = _KEY.sub(_assignment, text)
    text = re.sub(r"[\w.!#$%&'*+/=?^\x60{|}~-]+@[\w.-]+\.[\w-]+", _MASK, text)
    return re.sub(r"[\x00-\x1f\x7f]+", " ", text)[:2048]


def local_log_reader(host: str | None) -> bool:
    try:
        address = ip_address(host or "")
    except ValueError:
        return False
    if isinstance(address, IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return address.is_loopback or (address.is_private and not address.is_unspecified and not address.is_link_local)


class WorkerLogs(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.rows: deque[tuple[str, str]] = deque(maxlen=5000)
        self.rows_lock = Lock()

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
            self.rows.append((at, row))

    def recent(self, since: str) -> str:
        with self.rows_lock:
            return "".join(f"{row}\n" for at, row in self.rows if at >= since)
