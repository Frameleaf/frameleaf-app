"""The Hugging Face key the Frameleaf server passes with its requests, for faster model downloads (FL-1825).

The server sends its saved key (or an empty value when none is saved) in ``x-frameleaf-model-download-key``
with each request to this service. The key is only ever attached to requests to https://huggingface.co
(see ``privacy._bind_download_credentials``); MACHINE_LEARNING_HUGGING_FACE_TOKEN, when set, takes
precedence. This module lives outside the preprocessing identity on purpose: changing how a key reaches
the service must not change which model results it may produce.
"""

from __future__ import annotations

import os
import re
import secrets
from typing import Any

HEADER = b"x-frameleaf-model-download-key"
_PATTERN = re.compile(r"^hf_[A-Za-z0-9]{20,200}$")
_server_key: str | None = None


def server_key() -> str | None:
    """The key the server last passed, or None."""
    return _server_key


def set_server_key(value: str | None) -> None:
    global _server_key
    _server_key = value if value and _PATTERN.match(value) else None


class ModelDownloadKeyMiddleware:
    """Pure ASGI: remember the server's key from a request that may make this service do work.

    When FRAMELEAF_ML_AUTH_TOKEN is set, only a request carrying that bearer token may change the key,
    the same rule the service applies to inference.
    """

    def __init__(self, app: Any, expected_token: str | None = None) -> None:
        self.app = app
        token = expected_token if expected_token is not None else os.environ.get("FRAMELEAF_ML_AUTH_TOKEN", "")
        self._expected = token.strip().encode() or None

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") == "http":
            headers = dict(scope.get("headers") or [])
            value = headers.get(HEADER)
            if value is not None and len(value) <= 512 and self._authorized(headers.get(b"authorization", b"")):
                set_server_key(value.decode("ascii", "ignore").strip() or None)
        await self.app(scope, receive, send)

    def _authorized(self, header: bytes) -> bool:
        if self._expected is None:
            return True
        scheme, _, token = header.partition(b" ")
        return scheme.lower() == b"bearer" and secrets.compare_digest(token, self._expected)
