"""Foreground inference sidecar owned by the desktop supervisor."""

from __future__ import annotations

import argparse
import asyncio
import hmac
import os
import sys
import tempfile
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from io import BytesIO
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .native_binding import NativeBinding, NativeBindingSet
    from .native_device import DeviceObserver
from dataclasses import dataclass
from pathlib import Path

import orjson
from fastapi import Depends, FastAPI, File, Form, HTTPException
from PIL import Image, UnidentifiedImageError
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .schemas import InferenceEntries

# Room for the 16 MiB input, bounded entries and multipart framing before parsing.
MAX_REQUEST_BYTES = 17 * 1024 * 1024
REQUEST_BODY_SECONDS = 30
MAX_IMAGE_EDGE = 8192
MAX_IMAGE_PIXELS = 16 * 1024 * 1024


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
    # Keep admitted models resident until their supervisor stops this process.
    enforced = {
        "MACHINE_LEARNING_MODEL_DOWNLOADS": "false",
        "MACHINE_LEARNING_CACHE_FOLDER": str(options.cache_dir.resolve()),
        "MACHINE_LEARNING_WORKERS": "1",
        "MACHINE_LEARNING_ANN": "false",
        "MACHINE_LEARNING_RKNN": "false",
        "MACHINE_LEARNING_REQUEST_THREADS": "1",
        "MACHINE_LEARNING_MODEL_TTL": "0",
        "FRAMELEAF_HOST": "127.0.0.1",
        "FRAMELEAF_PORT": str(options.port),
    }
    configured = {
        key: value
        for key, value in environment.items()
        if key.upper() not in enforced and not key.upper().startswith("MACHINE_LEARNING_PRELOAD")
    }
    configured.update(enforced)
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
        if path == "/predict":
            body = bytearray()
            oversized = False
            try:
                async with asyncio.timeout(REQUEST_BODY_SECONDS):
                    while True:
                        message = await receive()
                        if message["type"] == "http.disconnect":
                            return
                        chunk = message.get("body", b"")
                        if len(body) + len(chunk) > MAX_REQUEST_BYTES:
                            oversized = True
                            break
                        body.extend(chunk)
                        if not message.get("more_body", False):
                            break
            except TimeoutError:
                await JSONResponse({"message": "Native inference input timed out"}, status_code=408)(
                    scope, receive, send
                )
                return
            if oversized:
                await JSONResponse({"message": "Native inference input too large"}, status_code=413)(
                    scope, receive, send
                )
                return

            payload: bytes | None = bytes(body)
            del body, message, chunk

            async def replay() -> Message:
                nonlocal payload
                if payload is None:
                    return await receive()
                value = payload
                payload = None
                return {"type": "http.request", "body": value, "more_body": False}

            await self.app(scope, replay, send)
            return
        await self.app(scope, receive, send)


def check_dimensions(width: int, height: int) -> None:
    if width <= 0 or height <= 0:
        raise HTTPException(422, "Native inference image invalid")
    if max(width, height) > MAX_IMAGE_EDGE or width * height > MAX_IMAGE_PIXELS:
        raise HTTPException(413, "Native inference image dimensions too large")


def check_png_header(data: bytes) -> None:
    if len(data) < 33 or data[8:16] != b"\0\0\0\rIHDR":
        raise HTTPException(422, "Native inference image invalid")
    check_dimensions(int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big"))
    offset = 33
    for _ in range(4096):
        if offset + 12 > len(data):
            break
        size = int.from_bytes(data[offset : offset + 4], "big")
        tag = data[offset + 4 : offset + 8]
        if offset + 12 + size > len(data) or tag == b"IHDR":
            break
        if tag == b"IDAT":
            return
        offset += size + 12
    raise HTTPException(422, "Native inference image invalid")


def check_webp_header(data: bytes) -> None:
    invalid = HTTPException(422, "Native inference image invalid")
    if len(data) < 12 or int.from_bytes(data[4:8], "little") + 8 != len(data):
        raise invalid
    pending = [(12, len(data), 0)]
    count = 0
    found = False
    while pending:
        offset, end, depth = pending.pop()
        while offset < end:
            count += 1
            if count > 4096 or offset + 8 > end:
                raise invalid
            tag = data[offset : offset + 4]
            size = int.from_bytes(data[offset + 4 : offset + 8], "little")
            start = offset + 8
            stop = start + size
            offset = stop + size % 2
            if offset > end:
                raise invalid
            if tag == b"VP8X" and size == 10:
                check_dimensions(
                    int.from_bytes(data[start + 4 : start + 7], "little") + 1,
                    int.from_bytes(data[start + 7 : start + 10], "little") + 1,
                )
                found = True
            elif tag == b"VP8L" and size >= 5 and data[start] == 0x2F:
                bits = int.from_bytes(data[start + 1 : start + 5], "little")
                check_dimensions((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
                found = True
            elif tag == b"VP8 " and size >= 10 and data[start + 3 : start + 6] == b"\x9d\x01\x2a":
                check_dimensions(
                    int.from_bytes(data[start + 6 : start + 8], "little") & 0x3FFF,
                    int.from_bytes(data[start + 8 : start + 10], "little") & 0x3FFF,
                )
                found = True
            elif tag == b"ANMF" and size >= 16 and depth == 0:
                width = int.from_bytes(data[start + 6 : start + 9], "little") + 1
                height = int.from_bytes(data[start + 9 : start + 12], "little") + 1
                check_dimensions(
                    width + 2 * int.from_bytes(data[start : start + 3], "little"),
                    height + 2 * int.from_bytes(data[start + 3 : start + 6], "little"),
                )
                pending.append((start + 16, stop, 1))
                found = True
            elif tag in {b"VP8X", b"VP8L", b"VP8 ", b"ANMF"}:
                raise invalid
    if not found:
        raise invalid


def check_image_envelope(data: bytes) -> None:
    # PNG animation/WebP opening may allocate a canvas before Pillow returns dimensions.
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        check_png_header(data)
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        check_webp_header(data)
    try:
        # NAS preview formats plus catalogue PNG fixtures; other plugins have not been admitted.
        with Image.open(BytesIO(data), formats=["JPEG", "PNG", "WEBP", "AVIF"]) as image:
            check_dimensions(image.width, image.height)
    except Image.DecompressionBombError as error:
        raise HTTPException(413, "Native inference image dimensions too large") from error
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise HTTPException(422, "Native inference image invalid") from error


def create_native_app(binding: "NativeBinding | NativeBindingSet | None") -> FastAPI:
    from . import main

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with main.lifespan(app):
            if binding is not None:
                await binding.preload()
            yield

    app = FastAPI(lifespan=lifespan)
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
            if image is not None:
                await main.run(check_image_envelope, image)
            response: JSONResponse = await main.predict(entries=selected, image=image, text=text, mask=None)
            # Recheck before publishing; changed bytes or drivers invalidate the whole result.
            await main.run(binding.check, value, kind)
            if len(response.body) > 4 * 1024 * 1024:
                raise HTTPException(413, "Native inference output too large")
            return response
        except ValueError as error:
            raise HTTPException(409, "Native model qualification invalidated") from error

    return app


def main(observer: DeviceObserver | None = None) -> None:
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

    configure(options.provider, observer=observer)
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
