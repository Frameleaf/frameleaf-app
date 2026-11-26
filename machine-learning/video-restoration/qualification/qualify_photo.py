"""Measure one photo workload on a real NVIDIA GPU (FL-933).

    python -I qualify_photo.py --workload photo-repair|colourise --runtime-root <checkout> \
        --weights <dir> --upstream upstream.json --scan-set scan-set.json --scans <dir> --out <dir>

Loads the runtime the worker runs (``../runtimes``) once, caps this process's GPU memory, and for
every scan records the output size, the time and the peak GPU memory. Photo repair also proves
that faces and every unmasked pixel are byte-identical to the input; colourise records which scans
it refuses as already coloured, against the museum's own wording. Then real EXIF orientation
fixtures, injected faults and tile seams. Writes ``<workload>.json`` and contact sheets with
full-resolution crops. It measures; it does not judge quality: that still needs a person.
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
from collections.abc import Callable
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image

RUNTIMES = Path(__file__).resolve().parent.parent / "runtimes"
EXIF_ORIENTATION = 0x0112
GIB = 1024**3
MIB = 1024**2
# LaMa runs in ONNX Runtime, whose arena torch cannot see or cap; the runtime gives it this much.
FILL_BYTES = 2 * GIB
SHEET_EVERY = 8
STRIP_HEIGHT = 300
STRESS_SIZES = ((6000, 7000), (8192, 8192))  # a 600 dpi scan of a large print, and the limit
OUTPUT_CAP = (3840, 2160)  # the worker's output box today; scans are measured at full size regardless
ORIENTATION_TAGS = (2, 3, 4, 5, 6, 7, 8)
ORIENTATION_EDGE = 1024
MAX_LIGHTNESS_CHANGE = 2.0  # colourise keeps the stored picture's own lightness


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


def densest_corner(weight: np.ndarray, size: int) -> tuple[int, int]:
    """Top-left corner of the ``size`` square holding the most of ``weight``."""
    height, width = weight.shape
    if not weight.any():
        return max(0, (height - size) // 2), max(0, (width - size) // 2)
    density = cv2.blur(weight.astype(np.float32), (size, size), borderType=cv2.BORDER_CONSTANT)
    row, column = np.unravel_index(int(density.argmax()), density.shape)
    return max(0, min(int(row) - size // 2, height - size)), max(0, min(int(column) - size // 2, width - size))


def tile(image: np.ndarray) -> Image.Image:
    """A full-resolution crop on a fixed square, padded when the picture is smaller."""
    canvas = Image.new("RGB", (STRIP_HEIGHT, STRIP_HEIGHT), (255, 255, 255))
    canvas.paste(Image.fromarray(image), (0, 0))
    return canvas


def row(panels: list[Image.Image]) -> Image.Image:
    pair = Image.new("RGB", (sum(p.width for p in panels) + 6 * (len(panels) - 1), STRIP_HEIGHT), (255, 255, 255))
    x = 0
    for panel in panels:
        pair.paste(panel, (x, 0))
        x += panel.width + 6
    return pair


def scaled(image: np.ndarray) -> Image.Image:
    height, width = image.shape[:2]
    size = (max(1, round(width * STRIP_HEIGHT / height)), STRIP_HEIGHT)
    return Image.fromarray(image).resize(size, Image.Resampling.LANCZOS)


def repair_strip(
    before: np.ndarray, after: np.ndarray, mask: np.ndarray, boxes: list[tuple[int, int, int, int]]
) -> Image.Image:
    """Whole picture with its mask in red; the most-marked area before, after and masked; the largest
    face before and after, which must look the same."""
    overlay = before.copy()
    overlay[cv2.dilate(mask, np.ones((5, 5), np.uint8)) > 0] = (255, 0, 0)
    top, left = densest_corner(mask > 0, STRIP_HEIGHT)
    window = (slice(top, top + STRIP_HEIGHT), slice(left, left + STRIP_HEIGHT))
    marked = before[window].copy()
    marked[mask[window] > 0] = (255, 0, 0)
    panels = [scaled(overlay), tile(before[window]), tile(after[window]), tile(marked)]
    if boxes:
        x0, y0, x1, y1 = max(boxes, key=lambda box: (box[2] - box[0]) * (box[3] - box[1]))
        y1, x1 = min(y1, y0 + STRIP_HEIGHT), min(x1, x0 + STRIP_HEIGHT)
        panels += [tile(before[y0:y1, x0:x1]), tile(after[y0:y1, x0:x1])]
    return row(panels)


def colour_strip(before: np.ndarray, after: np.ndarray) -> Image.Image:
    """Whole picture before and after, then the area with the most colour at full resolution."""
    lab = cv2.cvtColor(cv2.resize(after, (after.shape[1] // 4, after.shape[0] // 4)), cv2.COLOR_RGB2LAB).astype(
        np.int16
    )
    chroma = np.abs(lab[..., 1] - 128) + np.abs(lab[..., 2] - 128)
    top, left = densest_corner(chroma, STRIP_HEIGHT // 4)
    window = (slice(top * 4, top * 4 + STRIP_HEIGHT), slice(left * 4, left * 4 + STRIP_HEIGHT))
    return row([scaled(before), scaled(after), tile(before[window]), tile(after[window])])


def write_sheets(strips: list[Image.Image], out: Path, workload: str, per_sheet: int = 6) -> list[str]:
    names = []
    for index in range(0, len(strips), per_sheet):
        group = strips[index : index + per_sheet]
        sheet = Image.new("RGB", (max(item.width for item in group), (STRIP_HEIGHT + 6) * len(group)), (255, 255, 255))
        for number, item in enumerate(group):
            sheet.paste(item, (0, number * (STRIP_HEIGHT + 6)))
        name = f"{workload}-sheet-{index // per_sheet + 1:02d}.jpg"
        sheet.save(out / name, quality=80)
        names.append(name)
    return names


def expect_error(action: Callable[[], Any], marker: str) -> dict[str, Any]:
    """Whether the action failed cleanly with ``marker`` in its message."""
    try:
        action()
    except Exception as error:  # noqa: BLE001 - the failure is what is being measured
        text = f"{type(error).__name__}: {error}"[:200]
        return {"refused": marker.lower() in text.lower(), "error": text}
    return {"refused": False, "error": "no error was raised"}


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
    capped_fraction = min(1.0, torch_cap / total)
    torch.cuda.set_per_process_memory_fraction(capped_fraction)

    upstream = json.loads(args.upstream.read_text(encoding="utf-8"))
    weights = {role: args.weights / entry["file"] for role, entry in upstream["weights"].items()}
    baseline = DeviceSampler.read()
    started = time.monotonic()
    if repair:
        runtime = runpy.run_path(str(RUNTIMES / "photo_repair.py"))
        settings = argparse.Namespace(
            runtime_root=args.runtime_root, detection=weights["detection"], lama=weights["lama"], allow_cpu=False
        )
        models = runtime["load_models"](settings, vram_bytes_for_fill=FILL_BYTES)

        def process(rgb: np.ndarray) -> tuple[np.ndarray, dict[str, Any]]:
            faces, mask = runtime["find_marks"](rgb, models)
            output, report = runtime["fill_marks"](rgb, faces, mask, models)
            boxes = runtime["protected_boxes"](faces, *rgb.shape[:2])
            detail = {
                **vars(report),
                "unmaskedIdentical": bool(np.array_equal(output[mask == 0], rgb[mask == 0])),
                "facesIdentical": all(
                    np.array_equal(output[top:bottom, left:right], rgb[top:bottom, left:right])
                    for left, top, right, bottom in boxes
                ),
                "maskInsideFaces": any(mask[top:bottom, left:right].any() for left, top, right, bottom in boxes),
                "changedFraction": round(float(np.any(output != rgb, axis=2).mean()), 6),
            }
            return output, {**detail, "_mask": mask, "_boxes": boxes}

        roles = ["detection", "lama"]
        revision = upstream["checkouts"]["facexlib"]["revision"]
    else:
        runtime = runpy.run_path(str(RUNTIMES / "colourise.py"))
        predict = runtime["load_model"](
            argparse.Namespace(runtime_root=args.runtime_root, checkpoint=weights["ddcolor"], allow_cpu=False)
        )

        def process(rgb: np.ndarray) -> tuple[np.ndarray, dict[str, Any]]:
            return runtime["colourise"](rgb, predict), {}

        roles = ["ddcolor"]
        revision = upstream["checkouts"]["ddcolor"]["revision"]
    load_seconds = time.monotonic() - started

    def measure(name: str, rgb: np.ndarray) -> tuple[dict[str, Any], np.ndarray | None, dict[str, Any]]:
        height, width = rgb.shape[:2]
        entry: dict[str, Any] = {
            "id": name,
            "width": width,
            "height": height,
            "megapixels": round(width * height / 1e6, 3),
            "exceedsOutputCap": max(width, height) > OUTPUT_CAP[0] or min(width, height) > OUTPUT_CAP[1],
        }
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
        begun = time.monotonic()
        try:
            with DeviceSampler() as sampler:
                output, detail = process(rgb)
                torch.cuda.synchronize()
        except Exception as error:  # noqa: BLE001 - every failure is evidence
            entry["failure"] = f"{type(error).__name__}: {error}"[:400]
            return entry, None, {}
        seconds = time.monotonic() - begun
        private = {key: detail.pop(key) for key in list(detail) if key.startswith("_")}
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
        return entry, output, private

    scans = json.loads(args.scan_set.read_text(encoding="utf-8"))["scans"][: args.limit or None]
    results: list[dict[str, Any]] = []
    strips: list[Image.Image] = []
    seam = {"seamSteps": 0.0, "seamPixels": 0, "otherSteps": 0.0, "otherPixels": 0}
    first: np.ndarray | None = None
    fixtures: list[np.ndarray] = []
    processed = 0
    for scan in scans:
        path = args.scans / f"{scan['id']}.jpg"
        tinted = "applied color" in (scan.get("medium") or "").lower()
        if not path.is_file():
            results.append({"id": scan["id"], "failure": "the scan was not fetched", "museumTinted": tinted})
            continue
        with Image.open(path) as image:
            rgb = np.array(image.convert("RGB"))  # the stored pixel grid, as the worker decodes it
        if not repair and runtime["is_hand_tinted"](rgb):
            results.append({"id": scan["id"], "refused": True, "museumTinted": tinted, "group": scan.get("group")})
            print(json.dumps({"id": scan["id"], "refused": True, "museumTinted": tinted}), flush=True)
            continue
        if first is None:
            first = rgb
        if len(fixtures) < len(ORIENTATION_TAGS):
            scale = ORIENTATION_EDGE / max(rgb.shape[:2])
            size = (round(rgb.shape[1] * scale) | 1, round(rgb.shape[0] * scale))
            fixtures.append(cv2.resize(rgb, size, interpolation=cv2.INTER_AREA))
        entry, output, private = measure(scan["id"], rgb)
        entry["group"], entry["museumTinted"], entry["refused"] = scan.get("group"), tinted, False
        if output is not None:
            if processed < 3:  # deterministic repeat
                again, _, _ = measure(scan["id"], rgb)
                entry["repeatIdentical"] = again.get("outputSha256") == entry["outputSha256"]
            if repair:
                mask = private["_mask"] > 0
                core = runtime["CORE"]
                for axis in (0, 1):
                    both = (mask[1:] & mask[:-1]) if axis == 0 else (mask[:, 1:] & mask[:, :-1])
                    if both.any():
                        step = np.abs(np.diff(output.astype(np.int16), axis=axis)).max(axis=2)
                        positions = (np.arange(1, mask.shape[axis]) % core) == 0
                        on_seam = both & np.expand_dims(positions, 1 - axis)
                        seam["seamSteps"] += float(step[on_seam].sum())
                        seam["seamPixels"] += int(on_seam.sum())
                        seam["otherSteps"] += float(step[both & ~on_seam].sum())
                        seam["otherPixels"] += int((both & ~on_seam).sum())
            if processed % SHEET_EVERY == 0:
                if repair:
                    strips.append(repair_strip(rgb, output, private["_mask"], private["_boxes"]))
                else:
                    strips.append(colour_strip(rgb, output))
            processed += 1
        results.append(entry)
        print(
            json.dumps({k: entry.get(k) for k in ("id", "megapixels", "seconds", "devicePeakMiB", "failure")}),
            flush=True,
        )

    # Real orientation tags: the stored grid goes through untouched and the tag comes back.
    orientation: list[dict[str, Any]] = []
    for tag, fixture in zip(ORIENTATION_TAGS, fixtures):
        source = args.out / "orientation-source.png"
        exif = Image.Exif()
        exif[EXIF_ORIENTATION] = tag
        Image.fromarray(fixture).save(source, exif=exif)
        with Image.open(source) as image:
            read_tag = image.getexif().get(EXIF_ORIENTATION, 1)
            grid = np.array(image.convert("RGB"))
        result, detail = process(grid)
        written = args.out / "orientation-output.png"
        out_exif = Image.Exif()
        out_exif[EXIF_ORIENTATION] = read_tag
        Image.fromarray(result).save(written, exif=out_exif)
        with Image.open(written) as image:
            out_tag = image.getexif().get(EXIF_ORIENTATION, 1)
            stored = np.array(image.convert("RGB"))
        if repair:
            same_picture = bool(np.array_equal(stored[detail["_mask"] == 0], grid[detail["_mask"] == 0]))
        else:
            before = cv2.cvtColor(grid.astype(np.float32) / 255, cv2.COLOR_RGB2Lab)[..., 0]
            after = cv2.cvtColor(stored.astype(np.float32) / 255, cv2.COLOR_RGB2Lab)[..., 0]
            # A percentile: a few near-white pixels clip when colour is added. A turned picture fails by far.
            same_picture = bool(np.percentile(np.abs(after - before), 99) <= MAX_LIGHTNESS_CHANGE)
        orientation.append(
            {
                "tag": tag,
                "tagKept": read_tag == tag == out_tag,
                "sizeKept": stored.shape == grid.shape,
                "storedPictureKept": same_picture,
            }
        )
        source.unlink()
        written.unlink()

    # Injected faults.
    faults: dict[str, Any] = {}
    if first is not None:
        small = cv2.resize(first, (640, 480), interpolation=cv2.INTER_AREA)
        torch.cuda.empty_cache()
        tight = (torch.cuda.memory_allocated() + 16 * MIB) / total
        torch.cuda.set_per_process_memory_fraction(min(tight, capped_fraction))
        try:
            faults["outOfMemory"] = expect_error(lambda: process(first), "out of memory")
        finally:
            torch.cuda.set_per_process_memory_fraction(capped_fraction)
            torch.cuda.empty_cache()
        faults["outOfMemory"]["recovered"] = process(small)[0].shape == small.shape
        broken = np.full((512, 512, 3), np.nan, dtype=np.float32)
        if repair:
            mask = np.zeros(small.shape[:2], np.uint8)
            mask[100:104, 100:300] = 255
            faults["nan"] = expect_error(
                lambda: runtime["inpaint_tiled"](small, mask, lambda window, _: broken), "invalid window"
            )
        else:
            colour = np.full((512, 512, 2), np.nan, dtype=np.float32)
            faults["nan"] = expect_error(lambda: runtime["colourise"](small, lambda _: colour), "invalid output")
        transparent = args.out / "fault-transparent.png"
        Image.new("RGBA", (32, 32), (10, 20, 30, 128)).save(transparent)
        faults["unsupportedInput"] = expect_error(lambda: runtime["read_frame"](transparent), "8-bit RGB")
        transparent.unlink()

    stress: list[dict[str, Any]] = []
    if first is not None:
        for width, height in STRESS_SIZES:
            large = np.array(Image.fromarray(first).resize((width, height), Image.Resampling.BICUBIC))
            entry, output, _ = measure(f"stress-{width}x{height}", large)
            del large, output
            stress.append(entry)
            print(json.dumps(entry), flush=True)

    done = [entry for entry in results if "seconds" in entry]
    measured = done + [entry for entry in stress if "failure" not in entry]
    refused = [entry for entry in results if entry.get("refused")]
    failed = [entry for entry in results + stress if "failure" in entry]
    summary: dict[str, Any] = {
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
        "refused": len(refused),
        "failures": [{"id": entry["id"], "failure": entry["failure"]} for entry in failed],
        "outputSizeEqual": sum(1 for entry in done if entry["outputSizeEqual"]),
        "repeatsIdentical": [entry["repeatIdentical"] for entry in done if "repeatIdentical" in entry],
        "orientation": orientation,
        "faults": faults,
        "megapixels": {
            "min": min((e["megapixels"] for e in done), default=0),
            "max": max((e["megapixels"] for e in done), default=0),
        },
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
        "aboveOutputCap": {
            "box": list(OUTPUT_CAP),
            "scans": sum(1 for entry in done if entry["exceedsOutputCap"]),
            "peakDeviceMiB": max((e["devicePeakMiB"] for e in done if e["exceedsOutputCap"]), default=0),
            "peakTorchReservedBytes": max(
                (e["torchPeakReservedBytes"] for e in done if e["exceedsOutputCap"]), default=0
            ),
        },
        "stress": stress,
        "sheets": write_sheets(strips, args.out, args.workload),
    }
    if repair:
        fractions = sorted(e["detail"]["scratchMaskFraction"] for e in done)
        summary["repair"] = {
            "unmaskedIdentical": sum(e["detail"]["unmaskedIdentical"] for e in done),
            "facesIdentical": sum(e["detail"]["facesIdentical"] for e in done),
            "scansWithMaskInsideFace": sum(e["detail"]["maskInsideFaces"] for e in done),
            "facesProtected": sum(e["detail"]["facesProtected"] for e in done),
            "scansWithoutFace": sum(e["detail"]["facesProtected"] == 0 for e in done),
            "applied": sum(e["detail"]["scratchPass"] == "applied" for e in done),
            "skippedOverCap": sum(e["detail"]["scratchPass"] == "skipped-over-cap" for e in done),
            "medianMaskFraction": fractions[len(fractions) // 2] if fractions else None,
            "maxMaskFraction": fractions[-1] if fractions else None,
        }
        summary["tileSeams"] = {
            "seamPixels": seam["seamPixels"],
            "otherPixels": seam["otherPixels"],
            "meanStepAcrossSeams": round(seam["seamSteps"] / seam["seamPixels"], 3) if seam["seamPixels"] else None,
            "meanStepElsewhere": round(seam["otherSteps"] / seam["otherPixels"], 3) if seam["otherPixels"] else None,
        }
    else:
        known = [entry for entry in results if "refused" in entry]
        caught = sum(1 for e in known if e["refused"] and e["museumTinted"])
        false_refusals = sum(1 for e in known if e["refused"] and not e["museumTinted"])
        missed = sum(1 for e in known if not e["refused"] and e["museumTinted"])
        accepted = sum(1 for e in known if not e["refused"] and not e["museumTinted"])
        summary["tintDetector"] = {
            "museumTintedRefused": caught,
            "museumTintedAccepted": missed,
            "untintedRefused": false_refusals,
            "untintedAccepted": accepted,
            "refusedIds": [entry["id"] for entry in refused],
        }
    (args.out / f"{args.workload}.json").write_text(json.dumps({"summary": summary, "scans": results}, indent=1))
    print("QUALIFICATION-SUMMARY " + json.dumps(summary), flush=True)
    return 0 if done and not failed else 1


if __name__ == "__main__":
    sys.exit(main())
