"""Measure one photo workload on a real NVIDIA GPU (FL-933).

    python -I qualify_photo.py --workload photo-repair|colourise --runtime-root <checkout> \
        --weights <dir> --upstream upstream.json --scan-set scan-set.json --scans <dir> --out <dir>

Loads the runtime the worker runs (``../runtimes``) once, caps this process's GPU memory, and for
every scan records the output size, the orientation tag, the time and the peak GPU memory. Writes
``<workload>.json`` and before/after contact sheets, and prints a summary. It measures; it does
not judge quality: the comparison items of a qualification record still need a person.
"""

import argparse
import hashlib
import json
import runpy
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

RUNTIMES = Path(__file__).resolve().parent.parent / "runtimes"
EXIF_ORIENTATION = 0x0112
GIB = 1024**3
# LaMa runs in ONNX Runtime, whose arena torch cannot see or cap; the runtime gives it this much.
FILL_BYTES = 2 * GIB
SHEET_EVERY = 8
STRIP_HEIGHT = 300
STRESS_SIZES = ((6000, 7000), (8192, 8192))  # a 600 dpi scan of a large print, and the limit


class DeviceSampler:
    """Highest device-wide memory use nvidia-smi shows while sampling, in MiB."""

    def __init__(self) -> None:
        self.peak = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    @staticmethod
    def read() -> int:
        try:
            done = subprocess.run(
                ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            return max(int(line) for line in done.stdout.split() if line.strip().isdigit())
        except (OSError, ValueError, subprocess.TimeoutExpired):
            return 0

    def _run(self) -> None:
        while not self._stop.wait(0.25):
            self.peak = max(self.peak, self.read())

    def __enter__(self) -> "DeviceSampler":
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        self._thread.join(timeout=5)


def gpu_description() -> dict[str, str]:
    done = subprocess.run(
        ["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    name, driver, memory = (part.strip() for part in done.stdout.strip().splitlines()[0].split(","))
    return {"gpu": name, "driverVersion": driver, "memoryTotal": memory}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def strip(before: np.ndarray, after: np.ndarray) -> Image.Image:
    """Before and after side by side, scaled down to a fixed height."""
    height, width = before.shape[:2]
    scaled = (max(1, round(width * STRIP_HEIGHT / height)), STRIP_HEIGHT)
    pair = Image.new("RGB", (scaled[0] * 2 + 6, STRIP_HEIGHT), (255, 255, 255))
    pair.paste(Image.fromarray(before).resize(scaled, Image.Resampling.LANCZOS), (0, 0))
    pair.paste(Image.fromarray(after).resize(scaled, Image.Resampling.LANCZOS), (scaled[0] + 6, 0))
    return pair


def write_sheets(strips: list[Image.Image], out: Path, workload: str, per_sheet: int = 6) -> list[str]:
    names = []
    for index in range(0, len(strips), per_sheet):
        group = strips[index : index + per_sheet]
        sheet = Image.new("RGB", (max(item.width for item in group), (STRIP_HEIGHT + 6) * len(group)), (255, 255, 255))
        for row, item in enumerate(group):
            sheet.paste(item, (0, row * (STRIP_HEIGHT + 6)))
        name = f"{workload}-sheet-{index // per_sheet + 1:02d}.jpg"
        sheet.save(out / name, quality=72)
        names.append(name)
    return names


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workload", required=True, choices=("photo-repair", "colourise"))
    parser.add_argument("--runtime-root", required=True, type=Path)
    parser.add_argument("--weights", required=True, type=Path)
    parser.add_argument("--upstream", required=True, type=Path)
    parser.add_argument("--scan-set", required=True, type=Path)
    parser.add_argument("--scans", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--vram-cap-gib", type=float, default=8.0)
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    import torch

    if not torch.cuda.is_available():
        print("no CUDA device is available: nothing was measured", file=sys.stderr)
        return 2
    total = torch.cuda.get_device_properties(0).total_memory
    repair = args.workload == "photo-repair"
    torch_cap = int(args.vram_cap_gib * GIB) - (FILL_BYTES if repair else 0)
    torch.cuda.set_per_process_memory_fraction(min(1.0, torch_cap / total))

    upstream = json.loads(args.upstream.read_text(encoding="utf-8"))
    weights = {role: args.weights / entry["file"] for role, entry in upstream["weights"].items()}
    baseline = DeviceSampler.read()
    started = time.monotonic()
    if repair:
        runtime = runpy.run_path(str(RUNTIMES / "photo_repair.py"))
        settings = argparse.Namespace(
            runtime_root=args.runtime_root,
            codeformer=weights["codeformer"],
            detection=weights["detection"],
            parsing=weights["parsing"],
            lama=weights["lama"],
            fidelity=runtime["DEFAULT_FIDELITY"],
            allow_cpu=False,
        )
        models = runtime["load_models"](settings, vram_bytes_for_fill=FILL_BYTES)

        def process(rgb: np.ndarray) -> tuple[np.ndarray, dict[str, Any]]:
            output, report = runtime["repair"](rgb, models)
            return output, vars(report)

        roles = ["codeformer", "detection", "parsing", "lama"]
        revision = upstream["checkouts"]["codeformer"]["revision"]
    else:
        runtime = runpy.run_path(str(RUNTIMES / "colourise.py"))
        predict = runtime["load_model"](
            argparse.Namespace(runtime_root=args.runtime_root, checkpoint=weights["ddcolor"], allow_cpu=False)
        )

        def process(rgb: np.ndarray) -> tuple[np.ndarray, dict[str, Any]]:
            return runtime["colourise"](rgb, predict), {"sourceIsGreyscale": runtime["is_greyscale"](rgb)}

        roles = ["ddcolor"]
        revision = upstream["checkouts"]["ddcolor"]["revision"]
    load_seconds = time.monotonic() - started

    def measure(name: str, rgb: np.ndarray) -> tuple[dict[str, Any], np.ndarray | None]:
        height, width = rgb.shape[:2]
        entry: dict[str, Any] = {"id": name, "width": width, "height": height, "megapixels": round(width * height / 1e6, 3)}
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        begun = time.monotonic()
        try:
            with DeviceSampler() as sampler:
                output, detail = process(rgb)
                torch.cuda.synchronize()
        except Exception as error:  # noqa: BLE001 - every failure is evidence
            entry["failure"] = f"{type(error).__name__}: {error}"[:400]
            return entry, None
        seconds = time.monotonic() - begun
        entry.update(
            seconds=round(seconds, 3),
            secondsPerMegapixel=round(seconds / (width * height / 1e6), 3),
            torchPeakAllocatedBytes=torch.cuda.max_memory_allocated(),
            torchPeakReservedBytes=torch.cuda.max_memory_reserved(),
            devicePeakMiB=sampler.peak,
            outputSizeEqual=output.shape == rgb.shape,
            outputSha256=hashlib.sha256(output.tobytes()).hexdigest(),
            detail=detail,
        )
        return entry, output

    scans = json.loads(args.scan_set.read_text(encoding="utf-8"))["scans"][: args.limit or None]
    results: list[dict[str, Any]] = []
    strips: list[Image.Image] = []
    first: np.ndarray | None = None
    for index, scan in enumerate(scans):
        path = args.scans / f"{scan['id']}.jpg"
        if not path.is_file():
            results.append({"id": scan["id"], "failure": "the scan was not fetched"})
            continue
        with Image.open(path) as image:
            tag = image.getexif().get(EXIF_ORIENTATION, 1)
            rgb = np.array(image.convert("RGB"))  # the stored pixel grid, as the worker decodes it
        if first is None:
            first = rgb
        entry, output = measure(scan["id"], rgb)
        entry["group"] = scan.get("group")
        if output is not None:
            # The worker writes the result with the source's tag; do the same and read it back.
            check = args.out / "orientation-check.png"
            exif = Image.Exif()
            if tag != 1:
                exif[EXIF_ORIENTATION] = tag
            Image.fromarray(output[:64, :64]).save(check, exif=exif)
            with Image.open(check) as written:
                entry["orientation"] = {"sourceTag": tag, "outputTag": written.getexif().get(EXIF_ORIENTATION, 1)}
            check.unlink()
            if index < 3:  # deterministic repeat
                again, _ = measure(scan["id"], rgb)
                entry["repeatIdentical"] = again.get("outputSha256") == entry["outputSha256"]
            if index % SHEET_EVERY == 0:
                strips.append(strip(rgb, output))
        results.append(entry)
        print(json.dumps({k: entry.get(k) for k in ("id", "megapixels", "seconds", "devicePeakMiB", "failure")}), flush=True)

    stress: list[dict[str, Any]] = []
    if first is not None:
        for width, height in STRESS_SIZES:
            large = np.array(Image.fromarray(first).resize((width, height), Image.Resampling.BICUBIC))
            entry, output = measure(f"stress-{width}x{height}", large)
            if output is not None and (width, height) == STRESS_SIZES[0]:
                strips.append(strip(large, output))
            del large, output
            stress.append(entry)
            print(json.dumps(entry), flush=True)

    done = [entry for entry in results if "failure" not in entry]
    measured = done + [entry for entry in stress if "failure" not in entry]
    summary = {
        "workload": args.workload,
        **gpu_description(),
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
        "vramCapBytes": int(args.vram_cap_gib * GIB),
        "torchCapBytes": torch_cap,
        "fillArenaBytes": FILL_BYTES if repair else 0,
        "deviceBaselineMiB": baseline,
        "revision": revision,
        "weights": [{"role": role, "sha256": file_sha256(weights[role])} for role in roles],
        "modelLoadSeconds": round(load_seconds, 2),
        "scans": len(results),
        "succeeded": len(done),
        "failures": [{"id": entry["id"], "failure": entry["failure"]} for entry in results + stress if "failure" in entry],
        "outputSizeEqual": sum(1 for entry in done if entry["outputSizeEqual"]),
        "orientationKept": sum(1 for e in done if e["orientation"]["sourceTag"] == e["orientation"]["outputTag"]),
        "scansWithOrientationTag": sum(1 for entry in done if entry["orientation"]["sourceTag"] != 1),
        "repeatsIdentical": [entry["repeatIdentical"] for entry in done if "repeatIdentical" in entry],
        "megapixels": {"min": min((e["megapixels"] for e in done), default=0), "max": max((e["megapixels"] for e in done), default=0)},
        "seconds": {
            "median": round(statistics.median(e["seconds"] for e in done), 3) if done else None,
            "max": max((e["seconds"] for e in done), default=None),
        },
        "secondsPerMegapixel": {
            "median": round(statistics.median(e["secondsPerMegapixel"] for e in done), 3) if done else None,
            "max": max((e["secondsPerMegapixel"] for e in done), default=None),
        },
        "peakTorchAllocatedBytes": max((e["torchPeakAllocatedBytes"] for e in measured), default=0),
        "peakTorchReservedBytes": max((e["torchPeakReservedBytes"] for e in measured), default=0),
        "peakDeviceMiB": max((e["devicePeakMiB"] for e in measured), default=0),
        "stress": stress,
        "sheets": write_sheets(strips, args.out, args.workload),
    }
    (args.out / f"{args.workload}.json").write_text(json.dumps({"summary": summary, "scans": results}, indent=1))
    print("QUALIFICATION-SUMMARY " + json.dumps(summary), flush=True)
    return 0 if done and not summary["failures"] else 1


if __name__ == "__main__":
    sys.exit(main())
