"""Media handling around a restoration runtime (FL-114): probe, geometry, frame extraction,
frame validation and the final encode.

Everything here works on a private working copy of the upload. The original never reaches
this process on the server's side, and nothing here writes to the uploaded file either:
frames and the restored file are new files in the job's working directory.
"""

import json
import os
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Literal

import numpy as np
from PIL import Image

from .schemas import DynamicRange

FFMPEG = os.environ.get("FRAMELEAF_RESTORATION_FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FRAMELEAF_RESTORATION_FFPROBE", "ffprobe")
FRAME_PATTERN = "%08d.png"

HDR_TRANSFERS = frozenset({"smpte2084", "arib-std-b67"})
HDR_PRIMARIES = frozenset({"bt2020"})
# A constant-frame-rate source has matching nominal and average rates. Phones often record
# variable rate; conforming it is a separate, explicit step, never done silently here.
FRAME_RATE_TOLERANCE = Fraction(1, 1000)
# ffprobe ``color_space`` values mapped to swscale matrix names.
YUV_MATRICES = {
    "bt709": "bt709",
    "smpte170m": "bt601",
    "bt470bg": "bt601",
    "fcc": "fcc",
    "smpte240m": "smpte240m",
}
# Audio codecs an MP4 carries as they are. Anything else (PCM from camera MOV files, for
# example) is transcoded to AAC and the result says so.
MP4_COPYABLE_AUDIO = frozenset({"aac", "mp3", "alac", "ac3", "eac3"})
# ``-vsync`` is spelled ``-fps_mode`` from ffmpeg 5.1, but the old spelling still works there
# and is the only one ffmpeg 4.4 (Ubuntu 22.04, the worker image) understands.
PASSTHROUGH_TIMING = ["-vsync", "passthrough"]


class MediaError(Exception):
    """The media cannot be processed; ``unsupported`` separates bad input from tool failure."""

    def __init__(self, message: str, *, unsupported: bool = False) -> None:
        super().__init__(message)
        self.unsupported = unsupported


@dataclass(frozen=True)
class SourceProbe:
    width: int
    height: int
    frame_rate: Fraction
    variable_frame_rate: bool
    duration_ms: int
    dynamic_range: DynamicRange
    bit_depth: int
    audio_codecs: tuple[str, ...]
    color_primaries: str | None
    color_transfer: str | None
    color_space: str | None

    @property
    def frame_rate_text(self) -> str:
        return f"{self.frame_rate.numerator}/{self.frame_rate.denominator}"

    @property
    def audio_streams(self) -> int:
        return len(self.audio_codecs)

    @property
    def yuv_matrix(self) -> str:
        """The swscale matrix for this source's YCbCr coefficients, used for both directions
        of every RGB conversion so colours survive the round trip. Untagged sources follow
        the usual convention: BT.709 from 720 lines up, BT.601 below."""
        return YUV_MATRICES.get(self.color_space or "", "bt709" if self.height >= 720 else "bt601")


def parse_rational(value: str | None) -> Fraction | None:
    if not value or "/" not in value:
        return None
    numerator, denominator = value.split("/", 1)
    try:
        num, den = int(numerator), int(denominator)
    except ValueError:
        return None
    if num <= 0 or den <= 0:
        return None
    return Fraction(num, den)


def bit_depth_of(pix_fmt: str | None, bits_per_raw_sample: str | None) -> int:
    if bits_per_raw_sample and bits_per_raw_sample.isdigit():
        return int(bits_per_raw_sample)
    if pix_fmt:
        # Packed RGB formats name the bits per pixel: rgb48 and rgba64 are 16 bits a channel.
        if "48" in pix_fmt or "64" in pix_fmt:
            return 16
        for depth in (16, 14, 12, 10, 9):
            if f"p{depth}" in pix_fmt or f"{depth}le" in pix_fmt or f"{depth}be" in pix_fmt:
                return depth
    return 8


def parse_probe(payload: dict[str, Any], *, still: bool = False) -> SourceProbe:
    """Interpret ``ffprobe -show_streams -show_format -of json`` output. A still has no
    meaningful frame rate or duration; it is treated as one frame at 1/1 lasting 0 ms."""
    streams: list[dict[str, Any]] = payload.get("streams") or []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if video is None:
        raise MediaError("the upload has no video stream", unsupported=True)

    width = int(video.get("width") or 0)
    height = int(video.get("height") or 0)
    if width <= 0 or height <= 0:
        raise MediaError("the video stream has no dimensions", unsupported=True)

    if still:
        nominal, variable, duration_ms = Fraction(1, 1), False, 0
    else:
        parsed_rate = parse_rational(video.get("r_frame_rate"))
        average = parse_rational(video.get("avg_frame_rate"))
        if parsed_rate is None:
            raise MediaError("the video stream has no frame rate", unsupported=True)
        nominal = parsed_rate
        variable = average is not None and abs(average - nominal) / nominal > FRAME_RATE_TOLERANCE

        duration_text = video.get("duration") or (payload.get("format") or {}).get("duration")
        try:
            duration_ms = int(round(float(str(duration_text)) * 1000))
        except (TypeError, ValueError):
            raise MediaError("the upload has no duration", unsupported=True)
        if duration_ms <= 0:
            raise MediaError("the upload has no duration", unsupported=True)

    transfer = video.get("color_transfer")
    primaries = video.get("color_primaries")
    hdr = transfer in HDR_TRANSFERS or primaries in HDR_PRIMARIES

    return SourceProbe(
        width=width,
        height=height,
        frame_rate=nominal,
        variable_frame_rate=variable,
        duration_ms=duration_ms,
        dynamic_range=DynamicRange.HDR if hdr else DynamicRange.SDR,
        bit_depth=bit_depth_of(video.get("pix_fmt"), video.get("bits_per_raw_sample")),
        audio_codecs=tuple(
            str(stream.get("codec_name") or "unknown") for stream in streams if stream.get("codec_type") == "audio"
        ),
        color_primaries=primaries if isinstance(primaries, str) and primaries != "unknown" else None,
        color_transfer=transfer if isinstance(transfer, str) and transfer != "unknown" else None,
        color_space=video.get("color_space") if video.get("color_space") not in (None, "unknown") else None,
    )


def _run(args: list[str], *, timeout: float) -> subprocess.CompletedProcess[str]:
    try:
        completed = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    except FileNotFoundError as error:
        raise MediaError(f"{args[0]} is not installed: {error}")
    except subprocess.TimeoutExpired:
        raise MediaError(f"{args[0]} did not finish within {int(timeout)} s")
    if completed.returncode != 0:
        tail = completed.stderr.strip()[-2000:]
        raise MediaError(f"{args[0]} failed ({completed.returncode}): {tail}")
    return completed


def probe(path: Path, *, still: bool = False, timeout: float = 60.0) -> SourceProbe:
    completed = _run(
        [FFPROBE, "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        timeout=timeout,
    )
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise MediaError(f"ffprobe returned unreadable output: {error}")
    return parse_probe(payload, still=still)


def _even_floor(value: float) -> int:
    whole = int(value + 1e-9)
    whole -= whole % 2
    return max(2, whole)


def target_geometry(width: int, height: int, scale: int, max_width: int, max_height: int) -> tuple[int, int]:
    """Output size: ``scale`` times the source, fitted inside ``max_width`` x ``max_height``
    with the aspect preserved and both sides floored to even numbers for 4:2:0 encoding, so
    the result never exceeds the box the server asked for."""
    scaled_width, scaled_height = width * scale, height * scale
    ratio = min(1.0, max_width / scaled_width, max_height / scaled_height)
    return _even_floor(scaled_width * ratio), _even_floor(scaled_height * ratio)


def _segment_args(start_ms: int | None, end_ms: int | None) -> list[str]:
    args: list[str] = []
    if start_ms is not None and start_ms > 0:
        args += ["-ss", f"{start_ms / 1000:.3f}"]
    if start_ms is not None and end_ms is not None:
        args += ["-t", f"{(end_ms - start_ms) / 1000:.3f}"]
    return args


def extract_frames(
    source: Path,
    frames_dir: Path,
    *,
    start_ms: int | None,
    end_ms: int | None,
    yuv_matrix: str,
    timeout: float,
) -> int:
    """Decode the video frames of ``source`` (optionally one segment) to RGB PNG files."""
    frames_dir.mkdir(parents=True, exist_ok=False)
    _run(
        [
            FFMPEG,
            "-nostdin",
            "-v",
            "error",
            *_segment_args(start_ms, end_ms),
            "-i",
            str(source),
            "-map",
            "0:v:0",
            *PASSTHROUGH_TIMING,
            "-vf",
            # The source's own range tag decides limited or full range.
            f"scale=in_color_matrix={yuv_matrix}:in_range=auto,format=rgb24",
            str(frames_dir / FRAME_PATTERN),
        ],
        timeout=timeout,
    )
    return count_frames(frames_dir)


def encode_near_lossless_clip(
    frames_dir: Path, output: Path, frame_rate: str, *, yuv_matrix: str, timeout: float
) -> None:
    """Pack frames into an H.264 clip for runtimes that read video files: quantiser 0 and
    4:4:4 chroma, so only the RGB-to-YCbCr rounding is lost."""
    _run(
        [
            FFMPEG,
            "-nostdin",
            "-v",
            "error",
            "-framerate",
            frame_rate,
            "-start_number",
            "1",
            "-i",
            str(frames_dir / FRAME_PATTERN),
            "-vf",
            f"scale=out_color_matrix={yuv_matrix}:out_range=tv,format=yuv444p",
            "-c:v",
            "libx264",
            "-qp",
            "0",
            str(output),
        ],
        timeout=timeout,
    )


def decode_video_frames(video: Path, frames_dir: Path, *, yuv_matrix: str, timeout: float) -> int:
    frames_dir.mkdir(parents=True, exist_ok=True)
    _run(
        [
            FFMPEG,
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(video),
            "-map",
            "0:v:0",
            *PASSTHROUGH_TIMING,
            "-vf",
            f"scale=in_color_matrix={yuv_matrix}:in_range=tv,format=rgb24",
            str(frames_dir / FRAME_PATTERN),
        ],
        timeout=timeout,
    )
    return count_frames(frames_dir)


def list_frames(frames_dir: Path) -> list[Path]:
    return sorted(path for path in frames_dir.iterdir() if path.suffix.lower() == ".png")


def count_frames(frames_dir: Path) -> int:
    return len(list_frames(frames_dir))


def normalize_frame_names(frames_dir: Path) -> int:
    """Rename a runtime's output frames, in sorted order, to the ``%08d.png`` sequence the
    encoder reads. Returns the number of frames."""
    frames = list_frames(frames_dir)
    staged: list[Path] = []
    for index, frame in enumerate(frames):
        temporary = frames_dir / f".staged-{index:08d}.png"
        os.replace(frame, temporary)
        staged.append(temporary)
    for index, temporary in enumerate(staged, start=1):
        os.replace(temporary, frames_dir / (FRAME_PATTERN % index))
    return len(staged)


def frame_statistics(path: Path) -> tuple[int, int, float]:
    """Width, height and luminance standard deviation of one frame."""
    with Image.open(path) as image:
        width, height = image.size
        luminance = np.asarray(image.convert("L"), dtype=np.float32)
    return width, height, float(luminance.std())


# A frame whose source had visible content but whose output is flat is how NaN activations
# surface after the runtime clamps and quantises them.
SOURCE_CONTENT_STD = 2.0
BLANK_OUTPUT_STD = 0.5


def validate_output_frames(
    source_frames: list[Path],
    output_frames: list[Path],
    *,
    expected_size: tuple[int, int] | None,
) -> tuple[int, int]:
    """Check the runtime output frame for frame. Returns the output size.

    Raises ``MediaError`` for a frame-count change, inconsistent or unexpected sizes, or
    blank frames where the source had content.
    """
    if len(output_frames) != len(source_frames):
        raise MediaError(f"the runtime returned {len(output_frames)} frames for {len(source_frames)} source frames")
    if not output_frames:
        raise MediaError("the runtime returned no frames")

    size: tuple[int, int] | None = None
    for index, (source_frame, output_frame) in enumerate(zip(source_frames, output_frames), start=1):
        out_width, out_height, out_std = frame_statistics(output_frame)
        if size is None:
            size = (out_width, out_height)
            if expected_size is not None and size != expected_size:
                raise MediaError(
                    f"the runtime returned {out_width}x{out_height} frames; expected "
                    f"{expected_size[0]}x{expected_size[1]}"
                )
        elif (out_width, out_height) != size:
            raise MediaError(f"frame {index} is {out_width}x{out_height}; earlier frames are {size[0]}x{size[1]}")
        if out_std < BLANK_OUTPUT_STD:
            _, _, source_std = frame_statistics(source_frame)
            if source_std >= SOURCE_CONTENT_STD:
                raise MediaError(f"frame {index} is blank although its source has content (suspected NaN output)")
    assert size is not None
    return size


def encode_output(
    frames_dir: Path,
    output: Path,
    *,
    source: Path,
    source_probe: SourceProbe,
    target: tuple[int, int],
    start_ms: int | None,
    end_ms: int | None,
    timeout: float,
) -> Literal["copied", "transcoded", "none"]:
    """Resize restored frames to the target with a conventional Lanczos filter and encode
    them at the source's exact frame rate with every source audio stream for the same
    segment, so timing and audio are preserved. Returns how the audio was carried."""
    audio: Literal["copied", "transcoded", "none"] = "none"
    audio_input: list[str] = []
    audio_map: list[str] = []
    audio_codec: list[str] = []
    if source_probe.audio_streams > 0:
        audio_input = [*_segment_args(start_ms, end_ms), "-i", str(source)]
        audio_map = ["-map", "1:a?"]
        if all(codec in MP4_COPYABLE_AUDIO for codec in source_probe.audio_codecs):
            audio, audio_codec = "copied", ["-c:a", "copy"]
        else:
            audio, audio_codec = "transcoded", ["-c:a", "aac", "-b:a", "256k"]

    colour: list[str] = []
    if source_probe.color_primaries:
        colour += ["-color_primaries", source_probe.color_primaries]
    if source_probe.color_transfer:
        colour += ["-color_trc", source_probe.color_transfer]
    if source_probe.color_space:
        colour += ["-colorspace", source_probe.color_space]

    width, height = target
    _run(
        [
            FFMPEG,
            "-nostdin",
            "-v",
            "error",
            "-framerate",
            source_probe.frame_rate_text,
            "-start_number",
            "1",
            "-i",
            str(frames_dir / FRAME_PATTERN),
            *audio_input,
            "-map",
            "0:v:0",
            *audio_map,
            "-vf",
            (
                f"scale={width}:{height}:flags=lanczos:out_color_matrix={source_probe.yuv_matrix}:out_range=tv,"
                "format=yuv420p"
            ),
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "14",
            *colour,
            *audio_codec,
            "-movflags",
            "+faststart",
            str(output),
        ],
        timeout=timeout,
    )
    return audio


def encode_still_output(frames_dir: Path, output: Path, *, target: tuple[int, int], timeout: float) -> None:
    """Resize the one restored frame to the target with Lanczos and write a lossless PNG."""
    width, height = target
    _run(
        [
            FFMPEG,
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(frames_dir / (FRAME_PATTERN % 1)),
            "-vf",
            f"scale={width}:{height}:flags=lanczos,format=rgb24",
            "-frames:v",
            "1",
            str(output),
        ],
        timeout=timeout,
    )
