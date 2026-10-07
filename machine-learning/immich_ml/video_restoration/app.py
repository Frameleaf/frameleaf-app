"""HTTP surface of the restoration worker (FL-114).

A dedicated worker, separate from the ``/predict`` container, that the server's destination
model probes like any other endpoint:

* ``GET /ping`` and ``GET /`` — health, unauthenticated so probes and proxies work.
* ``GET /capabilities`` — ``{"protocol": "restoration-v1", "workloads": [...]}``. A workload
  appears only while at least one model for its mode is available; an unqualified worker
  lists none, so the server can never admit restoration work to it.
* ``GET /hardware`` — the shape ``MachineLearningRepository.probe`` reads.
* ``GET /restoration/models`` — every configured model with its state and every reason it
  is unavailable, plus the measured throughput its qualification recorded.
* ``POST /restoration/restore`` — one inference; see ``schemas.py`` for the contract.

Bearer authentication uses the same ``FRAMELEAF_ML_AUTH_TOKEN`` variable (or its deprecated alias
``IMMICH_ML_AUTH_TOKEN``) as the predict container so a LAN destination's stored token works unchanged.
"""

import asyncio
import base64
import logging
import os
import secrets
import shutil
import tempfile
import threading
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from pydantic import ValidationError
from starlette.background import BackgroundTask
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.types import ASGIApp

from ..env_aliases import read_env
from .models import RestorationFailure, RestorationRegistry, adapter_for
from .pipeline import AdapterFactory, restore
from .runtime_pool import RuntimePool
from .schemas import (
    RESTORATION_PROTOCOL,
    RESULT_HEADER,
    CapabilityReport,
    RestorationError,
    RestorationErrorCode,
    RestorationRequest,
    RestorationResult,
)

log = logging.getLogger("frameleaf.restoration")

AUTH_EXEMPT_PATHS = frozenset({"/", "/ping"})
MAX_AUTH_HEADER_LENGTH = 8 * 1024
UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
BUSY_RETRY_AFTER_S = 30
DEFAULT_REFRESH_S = 300


def _int_env(env: Mapping[str, str], name: str, default: int) -> int:
    value = env.get(name, "").strip()
    if not value:
        return default
    try:
        return int(value)
    except ValueError:
        raise ValueError(f"{name} must be a whole number, got {value!r}") from None


@dataclass(frozen=True)
class WorkerSettings:
    manifest: Path
    qualification: Path
    work_root: Path
    auth_token: str | None
    image_revision: str | None
    host: str
    port: int
    # How often the published capability report is rebuilt; 0 verifies at startup only.
    refresh_s: int = DEFAULT_REFRESH_S

    @classmethod
    def from_env(cls) -> "WorkerSettings":
        env = os.environ
        return cls(
            manifest=Path(env.get("FRAMELEAF_RESTORATION_MODELS", "/restoration/config/models.json")),
            qualification=Path(
                env.get("FRAMELEAF_RESTORATION_QUALIFICATION", "/restoration/config/qualification.json")
            ),
            work_root=Path(env.get("FRAMELEAF_RESTORATION_WORKDIR", tempfile.gettempdir())),
            auth_token=read_env(env, "FRAMELEAF_ML_AUTH_TOKEN").strip() or None,
            image_revision=env.get("FRAMELEAF_RESTORATION_IMAGE_REVISION", "").strip() or None,
            host=env.get("FRAMELEAF_RESTORATION_HOST", "0.0.0.0"),
            port=_int_env(env, "FRAMELEAF_RESTORATION_PORT", 3004),
            refresh_s=_int_env(env, "FRAMELEAF_RESTORATION_REFRESH_S", DEFAULT_REFRESH_S),
        )


class BearerAuthMiddleware(BaseHTTPMiddleware):
    """Enforce ``Authorization: Bearer`` when a token is configured; health stays open."""

    def __init__(self, app: ASGIApp, expected_token: str | None) -> None:
        super().__init__(app)
        self._expected = expected_token.encode("utf-8") if expected_token else None

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        if self._expected is None:
            return await call_next(request)
        path = request.url.path.lower()
        if len(path) > 1:
            path = path.rstrip("/")
        if path in AUTH_EXEMPT_PATHS:
            return await call_next(request)
        header = request.headers.get("authorization", "")
        scheme, _, token = header.partition(" ")
        if (
            len(header) > MAX_AUTH_HEADER_LENGTH
            or scheme.lower() != "bearer"
            or not secrets.compare_digest(token.encode("utf-8"), self._expected)
        ):
            return JSONResponse({"message": "Unauthorized"}, status_code=401)
        return await call_next(request)


def remove_work_dir(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)


def encode_result(result: RestorationResult) -> str:
    """base64url without padding, as ``Buffer.from(value, 'base64url')`` reads it."""
    return base64.urlsafe_b64encode(result.model_dump_json().encode("utf-8")).rstrip(b"=").decode("ascii")


def error_response(failure: RestorationFailure) -> JSONResponse:
    body = RestorationError(code=failure.code, message=failure.message, modelId=failure.model_id)
    headers = {"Retry-After": str(BUSY_RETRY_AFTER_S)} if failure.code == RestorationErrorCode.BUSY else None
    return JSONResponse(body.model_dump(mode="json"), status_code=failure.status_code, headers=headers)


def create_app(
    registry: RestorationRegistry,
    *,
    work_root: Path,
    auth_token: str | None = None,
    refresh_on_startup: bool = True,
    refresh_s: int = DEFAULT_REFRESH_S,
    adapter_factory: AdapterFactory = adapter_for,
) -> FastAPI:
    busy = threading.Lock()
    stop = threading.Event()
    runtimes = RuntimePool()
    if adapter_factory is adapter_for:
        adapter_factory = partial(adapter_for, runner=runtimes)

    async def shutdown_restoration() -> None:
        stop.set()
        await asyncio.to_thread(runtimes.cancel)

    def refresh_in_background() -> None:
        # Verify at startup, then keep the advertised workloads current: a model whose weights,
        # checkout or evidence changed stops being advertised without waiting for a request.
        # Every request re-verifies its model regardless.
        while True:
            try:
                registry.refresh()
            except Exception:
                log.exception("Restoration model verification failed")
            if refresh_s <= 0 or stop.wait(refresh_s):
                return

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if refresh_on_startup:
            threading.Thread(target=refresh_in_background, name="restoration-verify", daemon=True).start()
        try:
            yield
        finally:
            await shutdown_restoration()

    app = FastAPI(lifespan=lifespan)
    # The CLI server calls this before Uvicorn waits for active HTTP requests.
    app.state.shutdown_restoration = shutdown_restoration
    app.add_middleware(BearerAuthMiddleware, expected_token=auth_token)

    @app.get("/")
    def root() -> JSONResponse:
        return JSONResponse({"message": "Frameleaf restoration worker"})

    @app.get("/ping")
    def ping() -> PlainTextResponse:
        return PlainTextResponse("pong")

    @app.get("/capabilities")
    def capabilities() -> JSONResponse:
        return JSONResponse({"protocol": RESTORATION_PROTOCOL, "workloads": registry.report().workloads})

    @app.get("/hardware")
    def hardware() -> JSONResponse:
        gpus = registry.report().gpus
        # The worker process does not import torch; the model runtimes do. Report what the
        # driver shows rather than claiming a torch CUDA context this process never opened.
        return JSONResponse(
            {
                "providers": [],
                "openvinoDeviceIds": [],
                "torchCudaAvailable": False,
                "cudaDeviceCount": len(gpus),
                "preferredAcceleration": "cuda" if gpus else "auto",
            }
        )

    @app.get("/restoration/models")
    def models(refresh: bool = False) -> JSONResponse:
        report: CapabilityReport = registry.refresh() if refresh else registry.report()
        return JSONResponse(report.model_dump(mode="json"))

    @app.post("/restoration/restore")
    async def restore_endpoint(
        http_request: Request, request: Annotated[str, Form()], media: Annotated[UploadFile, File()]
    ) -> Response:
        try:
            parsed = RestorationRequest.model_validate_json(request)
        except ValidationError as error:
            return error_response(
                RestorationFailure(RestorationErrorCode.INVALID_REQUEST, f"invalid restoration request: {error}")
            )

        if stop.is_set() or not busy.acquire(blocking=False):
            return error_response(
                RestorationFailure(RestorationErrorCode.BUSY, "another restoration is running on this worker")
            )

        work_dir: Path | None = None
        inference: asyncio.Task[tuple[RestorationResult, Path]] | None = None
        disconnected: asyncio.Task[None] | None = None

        async def watch_disconnect() -> None:
            # Multipart parsing has consumed the upload before this handler runs.
            while (await http_request.receive())["type"] != "http.disconnect":
                pass

        async def cancel_inference() -> None:
            await asyncio.to_thread(runtimes.cancel)
            if inference is not None:
                with suppress(Exception):
                    await asyncio.shield(inference)

        try:
            runtimes.begin_request()
            work_dir = Path(tempfile.mkdtemp(prefix="restoration-", dir=work_root))
            media_path = work_dir / "upload"

            def perform() -> tuple[RestorationResult, Path]:
                assert work_dir is not None
                with media_path.open("wb") as handle:
                    shutil.copyfileobj(media.file, handle, UPLOAD_CHUNK_BYTES)
                return restore(registry, parsed, media_path, work_dir, adapter_factory=adapter_factory)

            inference = asyncio.create_task(asyncio.to_thread(perform))
            disconnected = asyncio.create_task(watch_disconnect())
            done, _ = await asyncio.wait((inference, disconnected), return_when=asyncio.FIRST_COMPLETED)
            if disconnected in done:
                await cancel_inference()
                remove_work_dir(work_dir)
                return Response(status_code=499)
            result, output_path = inference.result()
        except asyncio.CancelledError:
            # Cancelling an asyncio waiter does not stop its native/thread work.
            # Shield cleanup and keep admission until that work and its child have closed.
            await asyncio.shield(cancel_inference())
            if work_dir is not None:
                remove_work_dir(work_dir)
            raise
        except RestorationFailure as failure:
            await asyncio.to_thread(runtimes.close)
            if work_dir is not None:
                remove_work_dir(work_dir)
            log.warning("Restoration %s refused or failed: %s (%s)", parsed.requestId, failure.code, failure.message)
            return error_response(failure)
        except Exception:
            await cancel_inference()
            if work_dir is not None:
                remove_work_dir(work_dir)
            log.exception("Restoration %s failed unexpectedly", parsed.requestId)
            return error_response(
                RestorationFailure(RestorationErrorCode.RUNTIME_FAILED, "the restoration failed unexpectedly")
            )
        finally:
            if disconnected is not None:
                disconnected.cancel()
                with suppress(asyncio.CancelledError):
                    await disconnected
            busy.release()

        # The upload and intermediate frames are no longer needed; the whole working
        # directory goes once the restored file has been streamed.
        media_path.unlink(missing_ok=True)
        return FileResponse(
            output_path,
            media_type="video/mp4",
            headers={RESULT_HEADER: encode_result(result)},
            background=BackgroundTask(remove_work_dir, work_dir),
        )

    return app


def create_app_from_env() -> tuple[FastAPI, WorkerSettings]:
    settings = WorkerSettings.from_env()
    registry = RestorationRegistry(
        settings.manifest,
        settings.qualification,
        container_revision=settings.image_revision,
    )
    app = create_app(
        registry,
        work_root=settings.work_root,
        auth_token=settings.auth_token,
        refresh_s=settings.refresh_s,
    )
    return app, settings
