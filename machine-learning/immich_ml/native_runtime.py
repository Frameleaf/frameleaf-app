"""Foreground inference sidecar owned by the desktop supervisor."""

import argparse
import hmac
import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import orjson
from fastapi import Form, HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .schemas import InferenceEntries


@dataclass(frozen=True)
class NativeRuntimeOptions:
    cache_dir: Path
    port: int


def configure_runtime(options: NativeRuntimeOptions, environment: Mapping[str, str]) -> dict[str, str]:
    token = environment.get("FRAMELEAF_ML_AUTH_TOKEN", "")
    if len(token) < 48 or not token.isascii() or not token.isalnum():
        raise ValueError("auth_token_required: provide a random alphanumeric token of at least 48 characters")
    if not 1024 <= options.port <= 65535:
        raise ValueError("invalid_native_port")
    configured = {key: value for key, value in environment.items() if not key.startswith("MACHINE_LEARNING_PRELOAD")}
    configured.update(
        MACHINE_LEARNING_MODEL_DOWNLOADS="false",
        MACHINE_LEARNING_CACHE_FOLDER=str(options.cache_dir.resolve()),
        MACHINE_LEARNING_WORKERS="1",
        MACHINE_LEARNING_REQUEST_THREADS="1",
        FRAMELEAF_HOST="127.0.0.1",
        FRAMELEAF_PORT=str(options.port),
    )
    return configured


def native_path_allowed(path: str) -> bool:
    return path in {"/predict", "/ping"}


def library_entries(entries: str = Form()) -> InferenceEntries:
    try:
        payload = orjson.loads(entries)
    except orjson.JSONDecodeError as error:
        raise HTTPException(422, "Invalid library inference request") from error
    allowed = {"clip", "facial-recognition", "ocr", "image-description-tagging", "nsfw-detection"}
    if not isinstance(payload, dict) or not payload or not set(payload).issubset(allowed):
        raise HTTPException(422, "Native worker accepts library inference only")
    from .main import get_entries

    return get_entries(entries)


class NativeScope:
    def __init__(self, app: ASGIApp, token: str) -> None:
        self.app = app
        self.authorization = f"Bearer {token}".encode("ascii")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope["type"] != "http":
            await send({"type": "websocket.close", "code": 1008})
            return
        headers = [value for key, value in scope.get("headers", []) if key.lower() == b"authorization"]
        if len(headers) != 1 or not hmac.compare_digest(headers[0], self.authorization):
            await JSONResponse({"message": "Unauthorized"}, status_code=401)(scope, receive, send)
            return
        path = scope.get("path", "")
        method = "POST" if path == "/predict" else "GET"
        if not native_path_allowed(path) or scope.get("method") != method:
            await JSONResponse({"message": "Not found"}, status_code=404)(scope, receive, send)
            return
        await self.app(scope, receive, send)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    options = parser.parse_args()
    configured = configure_runtime(NativeRuntimeOptions(options.cache_dir, options.port), os.environ)
    # Settings are module-level singletons: this entry point must configure them before any model import.
    if "immich_ml.config" in sys.modules:
        raise RuntimeError("native_runtime_must_start_in_fresh_process")
    os.environ.clear()
    os.environ.update(configured)

    import uvicorn

    from .main import app, get_entries

    app.dependency_overrides[get_entries] = library_entries

    uvicorn.run(
        NativeScope(app, configured["FRAMELEAF_ML_AUTH_TOKEN"]),
        host="127.0.0.1",
        port=options.port,
        workers=1,
        access_log=False,
        limit_concurrency=2,
    )


if __name__ == "__main__":
    main()
