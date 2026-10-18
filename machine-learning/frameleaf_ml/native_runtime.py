"""Foreground inference sidecar owned by the desktop supervisor."""

import argparse
import hmac
import os
import sys
import tempfile
from collections.abc import Mapping
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .native_binding import NativeBinding, NativeBindingSet
from dataclasses import dataclass
from pathlib import Path

import orjson
from fastapi import Depends, FastAPI, File, Form, HTTPException
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from .schemas import InferenceEntries


@dataclass(frozen=True)
class NativeRuntimeOptions:
    cache_dir: Path
    port: int
    provider: str = "CPUExecutionProvider"


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
        MACHINE_LEARNING_ANN="false",
        MACHINE_LEARNING_RKNN="false",
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


def create_native_app(binding: "NativeBinding | NativeBindingSet | None") -> FastAPI:
    from . import main

    app = FastAPI(lifespan=main.lifespan)
    app.get("/ping")(main.ping)

    @app.post("/predict", dependencies=[Depends(main.update_state)])
    async def predict(
        entries: str = Form(), image: bytes | None = File(default=None), text: str | None = Form(default=None)
    ) -> JSONResponse:
        if binding is None:
            raise HTTPException(503, "Native model qualification required")
        if (image is None) == (text is None):
            raise HTTPException(422, "Exactly one library input required")
        if image is not None:
            data = image
        else:
            assert text is not None
            data = text.encode("utf-8")
        if not data or len(data) > 16 * 1024 * 1024 or len(entries.encode()) > 65536:
            raise HTTPException(413, "Native inference input too large")
        try:
            value = orjson.loads(entries)
            kind = "image" if image is not None else "text"
            selected = await main.run(binding.check, value, kind)
            response: JSONResponse = await main.predict(entries=selected, image=image, text=text, mask=None)
            # Recheck before publishing; changed bytes or drivers invalidate the whole result.
            await main.run(binding.check, value, kind)
            if len(response.body) > 4 * 1024 * 1024:
                raise HTTPException(413, "Native inference output too large")
            return response
        except ValueError as error:
            raise HTTPException(409, "Native model qualification invalidated") from error

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--spec", type=Path, action="append", default=[])
    parser.add_argument("--qualification-report", type=Path, action="append", default=[])
    parser.add_argument("--binding-set", action="store_true")
    from .native_ort import PROVIDERS

    parser.add_argument("--provider", choices=PROVIDERS, default="CPUExecutionProvider")
    options = parser.parse_args()
    if len(options.spec) != len(options.qualification_report) or (options.binding_set and not options.spec):
        parser.error("native_binding_pair_required")
    if len(options.spec) > 1 and not options.binding_set:
        parser.error("native_binding_set_flag_required")
    configured = configure_runtime(NativeRuntimeOptions(options.cache_dir, options.port, options.provider), os.environ)
    # Settings are module-level singletons: this entry point must configure them before any model import.
    if "frameleaf_ml.config" in sys.modules:
        raise RuntimeError("native_runtime_must_start_in_fresh_process")
    os.environ.clear()
    os.environ.update(configured)

    import uvicorn

    from .native_ort import configure

    configure(options.provider)
    from .native_binding import NativeBindingSet

    binding = (
        NativeBindingSet.load(options.spec, options.qualification_report, options.cache_dir, options.provider)
        if options.spec
        else None
    )
    app = create_native_app(binding)

    previous_temp = tempfile.tempdir
    with tempfile.TemporaryDirectory(prefix="frameleaf-native-") as runtime:
        tempfile.tempdir = runtime
        try:
            uvicorn.run(
                NativeScope(app, configured["FRAMELEAF_ML_AUTH_TOKEN"]),
                host="127.0.0.1",
                port=options.port,
                workers=1,
                access_log=False,
                limit_concurrency=2,
            )
        finally:
            tempfile.tempdir = previous_temp


if __name__ == "__main__":
    main()
