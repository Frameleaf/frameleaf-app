"""Local Qwen candidate execution for a supervisor-bound native request."""

import asyncio
import base64
import hashlib
import json
import os
import re
import secrets
import socket
import tempfile
from contextlib import AsyncExitStack
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx2
import orjson

if TYPE_CHECKING:
    from .native_qualification import QualificationSpec

TASK = "image-description-tagging"
MODEL = "Qwen3.5-4B"
BUILD = r"b[0-9]+-7fe450e19[a-f0-9]{0,31}"
ARTIFACTS = ("visual/model.gguf", "visual/mmproj.gguf")
BINARY = Path(__file__).parent / "native-bin" / ("llama-server.exe" if os.name == "nt" else "llama-server")
LIMIT = 64 * 1024


def model_directory(cache: Path) -> Path:
    return cache / TASK / MODEL


def verify_qwen(spec: "QualificationSpec", cache: Path) -> None:
    from .staging import verify_staged

    entries = {TASK: {"visual": {"modelName": MODEL, "options": {}}}}
    if (
        spec.entries != entries
        or spec.fixture_kind != "image"
        or spec.provider != "CPUExecutionProvider"
        or len(spec.models) != 1
    ):
        raise ValueError("native_qwen_binding_invalid")
    item = spec.models[0]
    if (item.name, item.task, item.type) != (MODEL, TASK, "visual") or set(item.artifacts) != set(ARTIFACTS):
        raise ValueError("native_qwen_inventory_invalid")
    directory = model_directory(cache)
    if directory.is_symlink() or directory.parent.is_symlink():
        raise ValueError("native_qwen_directory_invalid")
    if verify_staged(directory) != item.artifacts:
        raise ValueError("native_qwen_artifact_changed")
    for artifact in ARTIFACTS:
        with (directory / artifact).open("rb") as stream:
            if stream.read(4) != b"GGUF":
                raise ValueError("native_qwen_artifact_invalid")


def worker_output(raw: bytes) -> dict[str, Any]:
    def unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result = dict(pairs)
        if len(result) != len(pairs):
            raise ValueError("native_qwen_output_invalid")
        return result

    try:
        envelope = json.loads(raw, object_pairs_hook=unique)
        choices = envelope["choices"]
        if not isinstance(choices, list) or len(choices) != 1:
            raise ValueError("native_qwen_output_invalid")
        choice = choices[0]
        message = choice["message"]
        if choice["finish_reason"] != "stop" or any(
            message.get(field) for field in ("reasoning", "reasoning_content", "tool_calls", "function_call")
        ):
            raise ValueError("native_qwen_output_invalid")
        value = json.loads(message["content"], object_pairs_hook=unique)
        if not isinstance(value, dict) or set(value) != {"description"}:
            raise ValueError("native_qwen_output_invalid")
        description = value["description"]
        if (
            not isinstance(description, str)
            or not description.strip()
            or len(description) > 240
            or re.search(r"[\x00-\x1f\x7f]|<\s*/?\s*think\b", description, re.IGNORECASE)
        ):
            raise ValueError("native_qwen_output_invalid")
    except (AttributeError, KeyError, TypeError, UnicodeError) as error:
        raise ValueError("native_qwen_output_invalid") from error
    return {
        TASK: {
            "description": description.strip(),
            "people": [],
            "environment": "",
            "objects": [],
            "visible_text": [],
            "context": "",
            "tags": [],
        }
    }


def request_body(image: bytes) -> dict[str, Any]:
    if image.startswith(b"\x89PNG\r\n\x1a\n"):
        media_type = "image/png"
    elif image.startswith(b"\xff\xd8\xff"):
        media_type = "image/jpeg"
    else:
        raise ValueError("native_qwen_input_invalid")
    return {
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{media_type};base64," + base64.b64encode(image).decode()},
                    },
                    {
                        "type": "text",
                        "text": (
                            "Describe the visible contents of this photo in one factual sentence. Do not infer details."
                        ),
                    },
                ],
            }
        ],
        "chat_template_kwargs": {"enable_thinking": False},
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "description",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {"description": {"type": "string", "maxLength": 240}},
                    "required": ["description"],
                    "additionalProperties": False,
                },
            },
        },
        "temperature": 0,
        "seed": 31,
        "max_tokens": 96,
        "stream": False,
    }


def binary_sha256() -> str:
    if os.name not in {"posix", "nt"} or BINARY.parent.is_symlink() or BINARY.is_symlink() or not BINARY.is_file():
        raise ValueError("native_qwen_binary_unavailable")
    with BINARY.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


async def predict_qwen(cache: Path, image: bytes, expected_binary: str) -> tuple[dict[str, Any], str]:
    body = request_body(image)
    if binary_sha256() != expected_binary:
        raise ValueError("native_qwen_binary_changed")
    model, projector = (model_directory(cache) / item for item in ARTIFACTS)
    windows = os.name == "nt"
    # Windows inherits the ACL of the supervisor-owned work directory.
    # Unix needs a short private path for the socket.
    with tempfile.TemporaryDirectory(prefix="frameleaf-qwen-", dir=Path.cwd() if windows else "/tmp") as scratch:
        token = secrets.token_hex(32)
        key = Path(scratch) / "key"
        with os.fdopen(os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
            stream.write(token + "\n")
        socket_path = str(Path(scratch) / "llama.sock")
        environment = {"HOME": scratch, "TMPDIR": scratch, "PATH": "/usr/bin:/bin", "LC_ALL": "C"}
        port = None
        listen = ["--host", socket_path]
        if windows:
            from .native_qwen_windows import LOOPBACK

            system_root = os.environ.get("SystemRoot")
            if not system_root:
                raise ValueError("native_qwen_binary_unavailable")
            environment.update(
                {
                    "SystemRoot": system_root,
                    "PATH": str(Path(system_root) / "System32"),
                    "TEMP": scratch,
                    "TMP": scratch,
                }
            )
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
                reservation.bind((LOOPBACK, 0))
                port = reservation.getsockname()[1]
            listen = ["--host", LOOPBACK, "--port", str(port)]
        # The Desktop supervisor owns the process group; the model must stay in that group.
        try:
            process = await asyncio.create_subprocess_exec(
                str(BINARY),
                *listen,
                "--offline",
                "--api-key-file",
                str(key),
                "--no-webui",
                "--no-ui-mcp-proxy",
                "--no-warmup",
                "--no-agent",
                "--no-cache-prompt",
                "-m",
                str(model),
                "--mmproj",
                str(projector),
                "--ctx-size",
                "4096",
                "--threads",
                "4",
                "--parallel",
                "1",
                "--batch-size",
                "128",
                "--ubatch-size",
                "128",
                "--n-gpu-layers",
                "0",
                "--no-mmproj-offload",
                "--reasoning",
                "off",
                "--reasoning-budget",
                "0",
                env=environment,
                cwd=scratch,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
        except OSError as error:
            raise ValueError("native_qwen_binary_unavailable") from error
        try:
            async with AsyncExitStack() as stack:
                client = (
                    await stack.enter_async_context(
                        httpx2.AsyncClient(
                            base_url="http://localhost",
                            transport=httpx2.AsyncHTTPTransport(uds=socket_path, trust_env=False),
                            headers={"Authorization": f"Bearer {token}"},
                            trust_env=False,
                            follow_redirects=False,
                        )
                    )
                    if port is None
                    else None
                )

                async def response(
                    method: str, path: str, *, timeout: float, payload: dict[str, Any] | None = None
                ) -> bytes:
                    if port is not None:
                        from .native_qwen_windows import request_owned

                        return await asyncio.to_thread(
                            request_owned, port, process.pid, token, method, path, timeout, LIMIT, payload
                        )
                    assert client is not None
                    async with client.stream(method, path, timeout=timeout, json=payload) as reply:
                        reply.raise_for_status()
                        raw = bytearray()
                        async for chunk in reply.aiter_bytes():
                            raw.extend(chunk)
                            if len(raw) > LIMIT:
                                raise ValueError("native_qwen_output_invalid")
                        return bytes(raw)

                async with asyncio.timeout(45):
                    while process.returncode is None:
                        try:
                            raw = await response("GET", "/props", timeout=1)
                        except (httpx2.TransportError, httpx2.HTTPStatusError, OSError):
                            await asyncio.sleep(0.1)
                            continue
                        props = orjson.loads(raw)
                        build = props.get("build_info") if isinstance(props, dict) else None
                        if not isinstance(build, str) or re.fullmatch(BUILD, build) is None:
                            raise ValueError("native_qwen_build_invalid")
                        break
                    else:
                        raise ValueError("native_qwen_process_exited")
                async with asyncio.timeout(30):
                    raw = await response("POST", "/v1/chat/completions", payload=body, timeout=30)
                    if process.returncode is not None:
                        raise ValueError("native_qwen_process_exited")
                    return worker_output(raw), build
        except (httpx2.HTTPError, OSError, TimeoutError) as error:
            raise ValueError("native_qwen_prediction_failed") from error
        finally:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()
