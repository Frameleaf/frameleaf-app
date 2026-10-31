"""Offline trust boundary for the two pinned native Transformers snapshots."""

import hashlib
import math
from pathlib import Path


def verify_snapshot(path: Path, files: dict[str, dict[str, str]]) -> None:
    for name, expected in files.items():
        target = path / name
        size = target.stat().st_size
        # SHA-1 here is Git's content address, not an integrity choice for model weights (SHA-256).
        digest = hashlib.sha256() if "sha256" in expected else hashlib.sha1()
        if "git" in expected:
            digest.update(f"blob {size}\0".encode())
        with target.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != next(iter(expected.values())):
            raise ValueError("Pinned semantic model file failed its content hash")


def bounded_boxes(boxes: object, width: int, height: int) -> list[list[float]]:
    if not isinstance(boxes, list):
        return []
    result = []
    for box in boxes[:64]:
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            continue
        if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in box):
            continue
        x1, y1, x2, y2 = box
        if x1 >= x2 or y1 >= y2:
            continue
        clipped = [max(0.0, min(float(value), bound)) for value, bound in zip(box, [width, height, width, height])]
        if clipped[0] < clipped[2] and clipped[1] < clipped[3]:
            result.append(clipped)
        if len(result) == 8:
            break
    return result
