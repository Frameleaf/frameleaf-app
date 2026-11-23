"""Write ``tint-vectors.json``: small pictures with the colourise runtime's answer for each (FL-955).

The server ports the runtime's colour rule to judge a photo before any job exists. Both test suites
read this file, so the two cannot drift apart. Run it again only when the rule itself changes:

    python make_tint_vectors.py
"""

import base64
import json
import runpy
import zlib
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
RULE = runpy.run_path(str(HERE.parent / "runtimes" / "colourise.py"))


def scene(width: int, height: int) -> np.ndarray:
    """A smooth grey picture with every brightness in it."""
    y, x = np.mgrid[0:height, 0:width].astype(np.float32)
    wave = np.sin(x / 37.0) * np.cos(y / 23.0) + 0.5 * np.sin((x + y) / 61.0)
    grey = (wave - wave.min()) / (wave.max() - wave.min()) * 215 + 20
    return np.repeat(grey[:, :, None], 3, axis=2)


def toned(picture: np.ndarray, tone: tuple[float, float, float]) -> np.ndarray:
    return picture * np.array(tone, np.float32)


def painted(picture: np.ndarray, share: float) -> np.ndarray:
    """Rouge on a centred patch covering about ``share`` of the outer crop."""
    out = picture.copy()
    height, width = out.shape[:2]
    side = share**0.5 * 0.7
    top, bottom = int(height * (0.5 - side / 2)), int(height * (0.5 + side / 2))
    left, right = int(width * (0.5 - side / 2)), int(width * (0.5 + side / 2))
    out[top:bottom, left:right] *= np.array((1.0, 0.55, 0.55), np.float32)
    return out


def colour_photo(width: int, height: int) -> np.ndarray:
    y, x = np.mgrid[0:height, 0:width].astype(np.float32)
    return np.stack(
        (127 + 100 * np.sin(x / 41.0), 127 + 100 * np.sin(y / 29.0), 127 + 100 * np.cos((x - y) / 53.0)), axis=2
    )


def mounted(picture: np.ndarray) -> np.ndarray:
    out = picture.copy()
    height, width = out.shape[:2]
    edge_y, edge_x = int(height * 0.1), int(width * 0.1)
    for band in (out[:edge_y], out[-edge_y:], out[:, :edge_x], out[:, -edge_x:]):
        band[...] = (70, 130, 90)
    return out


def vectors() -> list[tuple[str, np.ndarray]]:
    base = scene(640, 480)
    sepia = toned(base, (1.0, 0.82, 0.6))
    return [
        ("grey", base),
        ("sepia", sepia),
        ("selenium", toned(base, (0.92, 0.84, 0.9))),
        ("strong-sepia", toned(base, (1.0, 0.7, 0.4))),
        ("portrait-grey", scene(480, 640)),
        ("coloured-mount", mounted(sepia)),
        ("light-paint", painted(sepia, 0.12)),
        ("paint-on-grey", painted(base, 0.2)),
        ("heavy-paint", painted(sepia, 0.9)),
        ("colour", colour_photo(640, 480)),
        ("colour-portrait", colour_photo(480, 640)),
        ("small-sepia", toned(scene(300, 200), (1.0, 0.82, 0.6))),
        ("small-colour", colour_photo(300, 200)),
    ]


def main() -> None:
    entries = []
    for name, picture in vectors():
        rgb = np.clip(picture, 0, 255).round().astype(np.uint8)[::4, ::4].repeat(4, 0).repeat(4, 1)  # compresses well
        entries.append(
            {
                "name": name,
                "width": rgb.shape[1],
                "height": rgb.shape[0],
                "rgb": base64.b64encode(zlib.compress(rgb.tobytes(), 9)).decode(),
                "outerShare": round(RULE["off_tone_share"](rgb, RULE["TINT_OUTER_INSET"]), 5),
                "innerShare": round(RULE["off_tone_share"](rgb, RULE["TINT_INNER_INSET"]), 5),
                "colour": RULE["photo_colour"](rgb),
            }
        )
    (HERE / "tint-vectors.json").write_text(json.dumps({"schemaVersion": 1, "vectors": entries}, indent=1) + "\n")
    for entry in entries:
        print(entry["name"], entry["outerShare"], entry["innerShare"], entry["colour"], len(entry["rgb"]))


if __name__ == "__main__":
    main()
