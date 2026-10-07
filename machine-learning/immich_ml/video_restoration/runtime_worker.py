"""Run with the model's Python, not the HTTP worker's environment.

Only the two documented upstream APIs are supported. A changed API fails closed; it must
be adapted and qualified at its pinned revision. No request input is retained between calls.
"""

import argparse
import gc
import importlib
import inspect
import json
import os
import sys
from functools import lru_cache
from typing import Any


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("family", choices=("realbasicvsr", "seedvr2"))
    parser.add_argument("--module", required=True)
    parser.add_argument("--config")
    parser.add_argument("--checkpoint")
    parser.add_argument("--max-seq-len", type=int)
    args = parser.parse_args()
    # Reserve a descriptor for protocol replies; native and Python logging both go to stderr.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.path.insert(0, os.getcwd())
    # torchrun starts its rank in a separate session. Announce it before importing any
    # model or receiving media so the owner can kill the rank as well as the launcher.
    protocol.write(json.dumps({"ready": True, "pid": os.getpid()}) + "\n")
    module: Any = None
    runner = None
    for line in sys.stdin:
        try:
            job = json.loads(line)
            if module is None:
                module = importlib.import_module(args.module)
                if args.family == "realbasicvsr":
                    if not args.config or not args.checkpoint or not args.max_seq_len:
                        raise ValueError("RealBasicVSR requires config, checkpoint and max-seq-len")
                    inspect.signature(module.init_model).bind(args.config, args.checkpoint)
                    inspect.signature(module.main).bind()
                    # Upstream main owns frame handling; only its model constructor is cached.
                    module.init_model = lru_cache(maxsize=1)(module.init_model)
                else:
                    inspect.signature(module.configure_runner).bind(1)
                    inspect.signature(module.generation_loop).bind(
                        None, video_path="", output_dir="", seed=0, res_h=16, res_w=16, sp_size=1
                    )
                    runner = module.configure_runner(1)
            if args.family == "realbasicvsr":
                sys.argv = [
                    args.module,
                    args.config,
                    args.checkpoint,
                    job["input_dir"],
                    job["output_dir"],
                    f"--max_seq_len={args.max_seq_len}",
                    "--is_save_as_png=True",
                ]
                module.main()
            else:
                module.generation_loop(
                    runner,
                    video_path=job["input_dir"],
                    output_dir=job["output_dir"],
                    seed=int(job["seed"]),
                    res_h=int(job["target_height"]),
                    res_w=int(job["target_width"]),
                    sp_size=1,
                )
            # Drop request paths and collect inference temporaries before acknowledging completion.
            del job
            del line
            sys.argv = [args.module]
            gc.collect()
            protocol.write('{"ok":true}\n')
        except BaseException as error:
            protocol.write(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"[-4000:]}) + "\n")
            return


if __name__ == "__main__":
    main()
