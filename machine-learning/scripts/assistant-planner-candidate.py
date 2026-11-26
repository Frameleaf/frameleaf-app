"""Candidate Library Assistant planner for benchmarking (FL-806); never part of a worker image.

Serves the FL-847 `POST /assistant/plan` contract for one unpinned candidate model, with the production
prompt, validator and single retry, so `FRAMELEAF_ASSISTANT_EVAL_MODE=live` can score it
(server/test/assistant-eval/README.md). Only synthetic eval questions should be sent here.

  --backend openai        any OpenAI-compatible chat server (llama.cpp `llama-server`) at --url
  --backend openvino      OpenVINO GenAI `LLMPipeline` over --model-dir, the production generation code
  --backend transformers  transformers over --model-dir, the production generation code

Prints per-request latency and, on exit, this process's peak memory (the model's for the in-process
backends; measure the server's own process for `openai`).
"""

import argparse
import json
import resource
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from frameleaf_ml.models import assistant_planner as planner  # noqa: E402
from frameleaf_ml.schemas import AssistantPlanRequest  # noqa: E402


def openai_backend(url: str, model: str) -> Any:
    def generate(messages: list[dict[str, str]], tool_schema: dict[str, Any]) -> str:
        body = {
            "model": model,
            "messages": messages,
            "temperature": 0,
            "max_tokens": planner.MAX_OUTPUT_TOKENS,
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "plan", "strict": True, "schema": planner.answer_schema(tool_schema)},
            },
        }
        request = urllib.request.Request(
            f"{url.rstrip('/')}/v1/chat/completions",
            json.dumps(body).encode(),
            {"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=120) as response:
            return str(json.load(response)["choices"][0]["message"]["content"] or "")

    return generate


def openvino_backend(model_dir: str, device: str) -> Any:
    import openvino_genai

    pipe = openvino_genai.LLMPipeline(model_dir, device.upper())
    return lambda messages, tool_schema: planner._generate_openvino(pipe, messages, tool_schema)


def transformers_backend(model_dir: str, device: str, dtype: str | None) -> Any:
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    kwargs = {"dtype": getattr(torch, dtype)} if dtype else {}
    session = {
        "tokenizer": AutoTokenizer.from_pretrained(model_dir),
        "model": AutoModelForCausalLM.from_pretrained(model_dir, **kwargs).to(device).eval(),
        "device": device,
    }
    return lambda messages, _tool_schema: planner._generate_transformers(session, messages)


def plan(generate: Any, body: AssistantPlanRequest) -> dict[str, Any] | None:
    """main.py's `/assistant/plan` without the model cache: clean, build, generate, validate, retry once."""
    planner.check_schema(body.tool_schema)
    catalog = planner.clean_catalog(body.catalog.model_dump())
    question = planner.clean_text(body.question, planner.MAX_QUESTION_CHARS)
    messages = planner.build_messages(question, body.language, body.today, catalog, body.tool_schema)
    for _attempt in range(2):
        raw = generate(messages, body.tool_schema)
        answer = planner.validate_plan(raw, body.tool_schema, catalog)
        if answer is not None:
            return answer
        messages = [
            *messages,
            {"role": "assistant", "content": raw[:2000]},
            {"role": "user", "content": planner.RETRY_PROMPT},
        ]
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--backend", choices=["openai", "openvino", "transformers"], required=True)
    parser.add_argument("--url", default="http://127.0.0.1:8080", help="openai: the chat server's origin")
    parser.add_argument("--model", default="candidate", help="openai: the model name to send")
    parser.add_argument("--model-dir", help="openvino/transformers: a local model directory")
    parser.add_argument("--device", default="cpu", help="openvino: cpu or gpu; transformers: cpu, cuda or mps")
    parser.add_argument("--dtype", help="transformers: a torch dtype such as bfloat16 (default: as production)")
    parser.add_argument("--system-prompt", type=Path, help="a file replacing the production system prompt")
    parser.add_argument("--port", type=int, default=3903)
    args = parser.parse_args()

    if args.system_prompt:
        planner.SYSTEM_PROMPT = args.system_prompt.read_text().strip()
    if args.backend == "openai":
        generate = openai_backend(args.url, args.model)
    elif args.backend == "openvino":
        generate = openvino_backend(args.model_dir, args.device)
    else:
        generate = transformers_backend(args.model_dir, args.device, args.dtype)
    # One generation at a time, as on a worker; a request the evaluator gave up on must not block the listener.
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            if self.path != "/assistant/plan":
                return self.send_error(404)
            started = time.perf_counter()
            body = AssistantPlanRequest.model_validate_json(self.rfile.read(int(self.headers["Content-Length"])))
            try:
                with lock:
                    answer = plan(generate, body)
            except Exception as error:  # a backend failure is this candidate's failure, not the harness's
                print(f"backend error: {error}", flush=True)
                answer = None
            payload = json.dumps(answer or {"detail": "invalid_plan"}).encode()
            print(f"{time.perf_counter() - started:.2f}s {'plan' if answer else 'invalid'}", flush=True)
            try:
                self.send_response(200 if answer else 422)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except OSError:
                pass  # the evaluator's deadline passed and it hung up

        def log_message(self, *_: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"candidate planner ({args.backend}) on http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # ru_maxrss is bytes on macOS and kilobytes on Linux
    print(f"peak RSS {peak / (1 << 30 if sys.platform == 'darwin' else 1 << 20):.2f} GiB", flush=True)


if __name__ == "__main__":
    main()
