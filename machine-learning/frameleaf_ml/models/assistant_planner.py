"""Library Assistant planner (FL-847): one question and the library's name catalogue in, one validated
`search_library` tool call out.

Only text reaches this worker: the question, today's date, the language, the names of the people, pets,
albums, tags and places the person may see, and the JSON schema of the tool's arguments. No photo, file
path or other library data is ever sent. The answer is either `{"tool": "search_library", "arguments",
"confidence"}` or `{"clarify": "<one question back>"}`; anything else the model writes is refused here
(after one retry), so the server never receives an unvalidated payload.

The model is chosen by the Library Assistant model spike (FL-806). Until a model is pinned in
`assistant-planner-models.json`, no host offers the task and the server answers with its rule planner.
Files come only from the Frameleaf model source, pinned by SHA-256, like every other model here.
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import threading
import time
import unicodedata
import urllib.error
import urllib.request
import weakref
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, NamedTuple

from frameleaf_ml.config import log, model_source_url
from frameleaf_ml.models.base import (
    MODEL_SOURCE_ORG,
    InferenceModel,
    ModelRuntimeUnavailable,
    ModelUnavailableError,
)
from frameleaf_ml.schemas import ModelFormat, ModelTask, ModelType

TOOL_NAME = "search_library"
CATALOG_FIELDS: tuple[str, ...] = ("people", "pets", "albums", "tags", "places")
# Tool arguments whose values must be names from the matching catalogue list.
NAMED_ARGUMENTS: dict[str, str] = {"people": "people", "pets": "pets", "albums": "albums", "tags": "tags"}

# Bounds of one request; the server sends far less.
MAX_QUESTION_CHARS = 1000
MAX_CATALOG_NAMES = 500
MAX_NAME_CHARS = 200
MAX_CLARIFY_CHARS = 300
MAX_OUTPUT_TOKENS = 384

# Rules and examples measured on the eval set in the FL-806 spike: without the conventions spelled out, the same
# models fill `type`, the date bounds and the three text arguments differently from the search they feed.
SYSTEM_PROMPT = Path(__file__).with_name("assistant-planner-prompt.txt").read_text(encoding="utf-8").strip()
RETRY_PROMPT = (
    "That answer was not one valid JSON object matching the tool schema. Answer again with only the JSON object."
)

_ALLOWED_WHITESPACE = {" ", "\n", "\t"}

# llama.cpp settings measured in the FL-806 spike.
LLAMA_CONTEXT_TOKENS = 4096
LLAMA_START_SECONDS = 180
LLAMA_REQUEST_SECONDS = 30
_SOFTWARE_GPU = re.compile(r"llvmpipe|lavapipe|softpipe|swiftshader", re.IGNORECASE)
# Holds llama-server to this worker's life: when the worker dies, however it dies, its end of the stdin pipe closes.
_LLAMA_WATCHDOG = '"$@" </dev/null & child=$!; cat >/dev/null; kill "$child" 2>/dev/null; wait "$child"'


class PlannerModelFile(NamedTuple):
    """A planner model on the model source: files under `textual/` in `frameleaf/<repo>`, each pinned."""

    name: str
    repo: str
    files: tuple[tuple[str, str], ...]
    source: str
    runtime: Literal["llamacpp", "openvino", "transformers"]
    memory_floor_mb: int
    tier: str
    default: bool


def _load_manifest() -> dict[str, PlannerModelFile]:
    entries: list[dict[str, Any]] = json.loads(Path(__file__).with_name("assistant-planner-models.json").read_text())
    return {
        entry["name"]: PlannerModelFile(
            entry["name"],
            entry["name"],
            tuple(sorted(entry["files"].items())),
            f"{entry['repository']}@{entry['revision']}",
            entry["runtime"],
            int(entry["memoryFloorMb"]),
            entry["tier"],
            bool(entry.get("default", False)),
        )
        for entry in entries
    }


PLANNER_MODELS: dict[str, PlannerModelFile] = _load_manifest()


def get_planner_model_file(model_name: str | None) -> PlannerModelFile | None:
    """The model a request names, or the manifest's default when it names none."""
    if model_name:
        return PLANNER_MODELS.get(model_name.strip().lower())
    return next((model for model in PLANNER_MODELS.values() if model.default), None)


def host_memory_mb() -> int | None:
    """Memory this worker may use: the container limit when one is set, else the host's memory."""
    try:
        from frameleaf_ml.container_resources import container_resources

        limit = container_resources()["memoryBytes"]
        if limit["status"] == "limited" and limit["value"] is not None:
            return int(limit["value"] // (1024 * 1024))
    except Exception:
        pass
    try:
        return int(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") // (1024 * 1024))
    except (ValueError, OSError, AttributeError):
        return None


def _llama_env() -> dict[str, str]:
    """Only what llama-server needs: none of the worker's credentials, and not its allocator preload."""
    return {key: value for key, value in os.environ.items() if key == "PATH" or key.startswith("VK_")}


@lru_cache(maxsize=1)
def _llama_gpu_devices() -> tuple[str, ...]:
    """The real GPUs llama-server can use. The planner is GPU-only: a CPU takes tens of seconds per answer."""
    binary = shutil.which("llama-server")
    if binary is None:
        return ()
    try:
        listed = subprocess.run(
            [binary, "--list-devices"], capture_output=True, text=True, timeout=15, env=_llama_env(), check=True
        )
    except (OSError, subprocess.SubprocessError):
        return ()
    devices = re.findall(r"^\s+(\S+: .+)$", listed.stdout + listed.stderr, flags=re.MULTILINE)
    return tuple(device for device in devices if not _SOFTWARE_GPU.search(device))


def _runtime_installed(runtime: str) -> bool:
    if runtime == "llamacpp":
        return bool(_llama_gpu_devices())
    module = "openvino_genai" if runtime == "openvino" else "transformers"
    return importlib.util.find_spec(module) is not None


def planner_status(model_name: str | None = None) -> dict[str, Any]:
    """What `/capabilities` reports for `assistant-plan`. A host below the model's memory floor, or
    without its runtime, reports the task unavailable and never loads the model."""
    model = get_planner_model_file(model_name)
    if model is None:
        return {"available": False, "model": None, "memoryFloorMb": None, "tier": None, "reason": "no-model"}
    status: dict[str, Any] = {
        "available": True,
        "model": model.name,
        "memoryFloorMb": model.memory_floor_mb,
        "tier": model.tier,
        "reason": None,
    }
    memory = host_memory_mb()
    if memory is not None and memory < model.memory_floor_mb:
        status.update(available=False, reason="below-memory-floor")
    elif not _runtime_installed(model.runtime):
        status.update(available=False, reason="no-runtime")
    return status


def clean_text(text: str, limit: int) -> str:
    """Drop control and format characters (zero-width joiners, BOMs, bidi overrides: a known prompt-injection
    vector), fold whitespace and cut to `limit` characters."""
    kept = [
        " " if char in _ALLOWED_WHITESPACE else char
        for char in text
        if char in _ALLOWED_WHITESPACE or unicodedata.category(char) not in {"Cc", "Cf", "Cs", "Co"}
    ]
    return re.sub(r"\s+", " ", "".join(kept)).strip()[:limit]


def clean_catalog(catalog: dict[str, list[str]]) -> dict[str, list[str]]:
    cleaned: dict[str, list[str]] = {}
    for field in CATALOG_FIELDS:
        names = [clean_text(name, MAX_NAME_CHARS) for name in catalog.get(field, [])[:MAX_CATALOG_NAMES]]
        cleaned[field] = list(dict.fromkeys(name for name in names if name))
    return cleaned


def build_messages(
    question: str, language: str, today: str, catalog: dict[str, list[str]], tool_schema: dict[str, Any]
) -> list[dict[str, str]]:
    """The chat for one plan. The question and catalogue go in as one JSON data block, never as prose."""
    data = {"today": today, "language": language, "catalog": catalog, "question": question}
    return [
        {"role": "system", "content": f"{SYSTEM_PROMPT}\nTool argument schema:\n{json.dumps(tool_schema)}"},
        {"role": "user", "content": json.dumps(data, ensure_ascii=False)},
    ]


# ---------------------------------------------------------------- validation


class SchemaError(ValueError):
    """The tool schema uses a JSON Schema keyword this validator does not check."""


_ANNOTATIONS = {"$schema", "$id", "title", "description", "default", "examples", "$comment"}
_CHECKED = {
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "minItems",
    "maxItems",
    "minLength",
    "maxLength",
    "minimum",
    "maximum",
    "format",
    "pattern",
}
_DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$")


def check_schema(schema: Any, depth: int = 0) -> None:
    """Refuse a tool schema this validator cannot fully enforce, so a constraint is never silently skipped."""
    if depth > 8 or not isinstance(schema, dict):
        raise SchemaError("The tool schema is not a supported JSON schema")
    unknown = set(schema) - _ANNOTATIONS - _CHECKED
    if unknown:
        raise SchemaError(f"The tool schema uses unsupported keywords: {', '.join(sorted(unknown))}")
    if depth == 0 and schema.get("type") != "object":
        raise SchemaError("The tool schema must describe an object")
    for child in (schema.get("properties") or {}).values():
        check_schema(child, depth + 1)
    if isinstance(schema.get("items"), dict):
        check_schema(schema["items"], depth + 1)
    if isinstance(schema.get("additionalProperties"), dict):
        check_schema(schema["additionalProperties"], depth + 1)


def _matches_type(value: Any, expected: str) -> bool:
    match expected:
        case "object":
            return isinstance(value, dict)
        case "array":
            return isinstance(value, list)
        case "string":
            return isinstance(value, str)
        case "boolean":
            return isinstance(value, bool)
        case "integer":
            return isinstance(value, int) and not isinstance(value, bool)
        case "number":
            return isinstance(value, (int, float)) and not isinstance(value, bool)
        case "null":
            return value is None
    return False


def _conforms_string(value: str, schema: dict[str, Any]) -> bool:
    if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", len(value)):
        return False
    if schema.get("format") == "date-time":
        if not _DATE_TIME.match(value):
            return False
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return False
    if "pattern" in schema:
        try:
            return re.search(schema["pattern"], value) is not None
        except re.error:
            return True  # a JavaScript-only pattern; `format` above still checks date-times
    return True


def conforms(value: Any, schema: dict[str, Any]) -> bool:
    """Whether `value` satisfies `schema` (the keyword subset `check_schema` admits)."""
    expected = schema.get("type")
    if expected is not None:
        types = expected if isinstance(expected, list) else [expected]
        if not any(_matches_type(value, kind) for kind in types):
            return False
    if "const" in schema and value != schema["const"]:
        return False
    if "enum" in schema and value not in schema["enum"]:
        return False
    if isinstance(value, str):
        return _conforms_string(value, schema)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(schema.get("minimum", value) <= value <= schema.get("maximum", value))
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", len(value)):
            return False
        items = schema.get("items")
        return not isinstance(items, dict) or all(conforms(item, items) for item in value)
    if isinstance(value, dict):
        properties: dict[str, Any] = schema.get("properties") or {}
        if any(key not in value for key in schema.get("required", [])):
            return False
        extra = schema.get("additionalProperties", True)
        for key, item in value.items():
            if key in properties:
                if not conforms(item, properties[key]):
                    return False
            elif extra is False or (isinstance(extra, dict) and not conforms(item, extra)):
                return False
    return True


def _json_object(raw: str) -> Any:
    text = raw.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, flags=re.DOTALL)
    if fenced:
        text = fenced.group(1)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def validate_plan(raw: str, tool_schema: dict[str, Any], catalog: dict[str, list[str]]) -> dict[str, Any] | None:
    """The model's answer as a tool call or a clarifying question, or None when it is neither.

    Names are matched to the catalogue ignoring case and returned as the catalogue writes them; a name
    that is not in the catalogue makes the whole plan invalid."""
    answer = _json_object(raw)
    if not isinstance(answer, dict):
        return None
    if set(answer) == {"clarify"}:
        clarify = clean_text(answer["clarify"], MAX_CLARIFY_CHARS) if isinstance(answer["clarify"], str) else ""
        return {"clarify": clarify} if clarify else None
    if set(answer) != {"tool", "arguments", "confidence"} or answer["tool"] != TOOL_NAME:
        return None
    arguments, confidence = answer["arguments"], answer["confidence"]
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not 0 <= confidence <= 1:
        return None
    if not isinstance(arguments, dict) or not conforms(arguments, tool_schema):
        return None
    resolved = dict(arguments)
    for argument, field in NAMED_ARGUMENTS.items():
        if argument not in arguments:
            continue
        known = {name.lower(): name for name in catalog.get(field, [])}
        names = arguments[argument]
        if not isinstance(names, list) or not all(isinstance(name, str) and name.lower() in known for name in names):
            return None
        resolved[argument] = [known[name.lower()] for name in names]
    return {"tool": TOOL_NAME, "arguments": resolved, "confidence": float(confidence)}


# ---------------------------------------------------------------- model


class AssistantPlannerModel(InferenceModel):
    depends = []
    identity = (ModelType.TEXTUAL, ModelTask.ASSISTANT_PLAN)

    def __init__(self, model_name: str, **model_kwargs: Any) -> None:
        super().__init__(model_name, **model_kwargs, model_format=ModelFormat.ONNX)
        # One generation at a time per loaded model: the runtimes keep per-call state on the pipeline.
        self._generate_lock = threading.Lock()

    @property
    def spec(self) -> PlannerModelFile:
        spec = get_planner_model_file(self.model_name)
        if spec is None:
            raise ModelUnavailableError(f"'{self.model_name}' is not a Library Assistant planner model")
        return spec

    @property
    def model_path(self) -> Path:
        return self.model_dir / "config.json"

    @property
    def cached(self) -> bool:
        source = get_planner_model_file(self.model_name)
        return source is not None and all((self.cache_dir / path).is_file() for path, _ in source.files)

    def _download(self) -> None:
        source = get_planner_model_file(self.model_name)
        if source is None:
            raise self._unavailable(f"{MODEL_SOURCE_ORG}/{self.model_name}", model_source_url(), "is not a planner")
        repo_id = f"{MODEL_SOURCE_ORG}/{source.repo}"
        # only the pinned files, so nothing unlisted (a generation config, say) reaches the runtime
        self._download_from_source(source.repo, allow_patterns=[path for path, _ in source.files])
        for path, expected in source.files:
            file = self.cache_dir / path
            if not file.is_file():
                raise self._unavailable(repo_id, model_source_url(), reason=f"has no {path}")
            digest = hashlib.sha256()
            with file.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1 << 20), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected:
                file.unlink()
                raise self._unavailable(repo_id, model_source_url(), reason=f"failed the checksum of {path}")

    def _load(self) -> Any:
        from frameleaf_ml.staging import cache_hashes

        spec = self.spec
        try:
            if self.cache_dir.is_symlink() or cache_hashes(self.cache_dir) != dict(spec.files):
                raise ModelUnavailableError("Assistant planner cache does not match the pinned files")
        except OSError as error:
            raise ModelUnavailableError("Could not read the assistant planner cache") from error

        if spec.runtime == "llamacpp":
            binary = shutil.which("llama-server")
            weights = next((self.cache_dir / path for path, _ in spec.files if path.endswith(".gguf")), None)
            if binary is None or not _llama_gpu_devices():
                raise ModelRuntimeUnavailable("This worker has no llama.cpp runtime with a GPU")
            if weights is None:
                raise ModelUnavailableError("The assistant planner has no GGUF file")
            log.info(f"Loading assistant planner '{self.model_name}' with llama.cpp")
            return {"runtime": "llamacpp", "server": LlamaServer(binary, weights)}
        if spec.runtime == "openvino":
            try:
                import openvino_genai
            except ImportError as error:
                raise ModelRuntimeUnavailable("This worker has no OpenVINO GenAI runtime") from error
            device = "GPU" if "GPU" in _openvino_devices() else "CPU"
            log.info(f"Loading assistant planner '{self.model_name}' with OpenVINO GenAI on {device}")
            return {"runtime": "openvino", "pipe": openvino_genai.LLMPipeline(str(self.model_dir), device)}
        try:
            import torch
            from transformers import AutoModelForCausalLM, AutoTokenizer
        except ImportError as error:
            raise ModelRuntimeUnavailable("This worker has no transformers runtime") from error
        device = "cuda" if torch.cuda.is_available() else "cpu"
        log.info(f"Loading assistant planner '{self.model_name}' with transformers on {device}")
        tokenizer = AutoTokenizer.from_pretrained(str(self.model_dir))
        model: Any = AutoModelForCausalLM.from_pretrained(str(self.model_dir))
        model = model.to(device).eval()
        return {"runtime": "transformers", "tokenizer": tokenizer, "model": model, "device": device}

    def _predict(self, messages: list[dict[str, str]], tool_schema: dict[str, Any], **_: Any) -> str:
        """The model's raw answer to the chat, constrained to the answer schema where the runtime can."""
        self.load()
        session: Any = self.session
        with self._generate_lock:
            if session["runtime"] == "llamacpp":
                return str(session["server"].generate(messages, tool_schema))
            if session["runtime"] == "openvino":
                return _generate_openvino(session["pipe"], messages, tool_schema)
            return _generate_transformers(session, messages)


def _stop_llama_server(process: subprocess.Popen[bytes]) -> None:
    if process.stdin is not None:
        process.stdin.close()
    # The cache's expiry timer drops the last reference on the event loop: never wait for the exit there.
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        _reap_llama_server(process)
    else:
        threading.Thread(target=_reap_llama_server, args=(process,), daemon=True).start()


def _reap_llama_server(process: subprocess.Popen[bytes]) -> None:
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, 9)
        process.wait()


class LlamaServer:
    """One `llama-server` on loopback for one loaded model; it stops when the model is unloaded."""

    def __init__(self, binary: str, weights: Path) -> None:
        self.key = secrets.token_urlsafe(32)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"
        # a proxy set for the worker must never see this traffic
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        # fixed arguments and the key in the environment, so no other process reads it from the command line
        command = [binary, "-m", str(weights), "--host", "127.0.0.1", "--port", str(port)]
        command += ["-c", str(LLAMA_CONTEXT_TOKENS), "-np", "1", "-ngl", "99", "--jinja", "--reasoning-budget", "0"]
        command += ["--offline", "--no-webui"]
        self.process = subprocess.Popen(
            ["sh", "-c", _LLAMA_WATCHDOG, "llama-watchdog", *command],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env={**_llama_env(), "LLAMA_API_KEY": self.key},
            start_new_session=True,
        )
        self._stop = weakref.finalize(self, _stop_llama_server, self.process)
        try:
            self._wait_until_ready()
        except Exception:
            self._stop()
            raise

    def _wait_until_ready(self) -> None:
        deadline = time.monotonic() + LLAMA_START_SECONDS
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                break
            try:
                with self.opener.open(f"{self.url}/health", timeout=2) as response:
                    if response.status == 200:
                        return
            except (OSError, urllib.error.URLError):
                pass  # still loading (503) or not listening yet
            time.sleep(0.25)
        raise ModelRuntimeUnavailable("llama-server did not start")

    def generate(self, messages: list[dict[str, str]], tool_schema: dict[str, Any]) -> str:
        body = {
            "messages": messages,
            "temperature": 0,
            "max_tokens": MAX_OUTPUT_TOKENS,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "plan", "strict": True, "schema": answer_schema(tool_schema)},
            },
        }
        request = urllib.request.Request(
            f"{self.url}/v1/chat/completions",
            json.dumps(body).encode(),
            {"Content-Type": "application/json", "Authorization": f"Bearer {self.key}"},
        )
        with self.opener.open(request, timeout=LLAMA_REQUEST_SECONDS) as response:
            return str(json.load(response)["choices"][0]["message"]["content"] or "")


def _openvino_devices() -> list[str]:
    try:
        import openvino

        return list(openvino.Core().available_devices)
    except Exception:
        return []


def answer_schema(tool_schema: dict[str, Any]) -> dict[str, Any]:
    """The JSON schema of a whole answer, for runtimes that can constrain decoding to it."""
    return {
        "anyOf": [
            {
                "type": "object",
                "properties": {
                    "tool": {"const": TOOL_NAME},
                    "arguments": tool_schema,
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                },
                "required": ["tool", "arguments", "confidence"],
                "additionalProperties": False,
            },
            {
                "type": "object",
                "properties": {"clarify": {"type": "string", "maxLength": MAX_CLARIFY_CHARS}},
                "required": ["clarify"],
                "additionalProperties": False,
            },
        ]
    }


def _generate_openvino(pipe: Any, messages: list[dict[str, str]], tool_schema: dict[str, Any]) -> str:
    import openvino_genai

    tokenizer = pipe.get_tokenizer()
    prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True)
    config = openvino_genai.GenerationConfig()
    config.max_new_tokens = MAX_OUTPUT_TOKENS
    config.do_sample = False
    structured = getattr(openvino_genai, "StructuredOutputConfig", None)
    if structured is not None:
        config.structured_output_config = structured(json_schema=json.dumps(answer_schema(tool_schema)))
    return str(pipe.generate(prompt, config))


def _generate_transformers(session: dict[str, Any], messages: list[dict[str, str]]) -> str:
    import torch

    tokenizer, model = session["tokenizer"], session["model"]
    # enable_thinking: Qwen3's template reasons aloud unless told not to, which spends the output budget before
    # the JSON; templates without the switch ignore it.
    inputs = tokenizer.apply_chat_template(
        messages, add_generation_prompt=True, return_tensors="pt", return_dict=True, enable_thinking=False
    ).to(session["device"])
    with torch.inference_mode():
        output = model.generate(**inputs, max_new_tokens=MAX_OUTPUT_TOKENS, do_sample=False)
    return str(tokenizer.decode(output[0][inputs["input_ids"].shape[-1] :], skip_special_tokens=True))
