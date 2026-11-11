"""Download and validate one selected media attachment."""
from contextlib import closing
import json
import math
from pathlib import Path
import re
import resource
import subprocess
from xml.etree import ElementTree

from yt_dlp.downloader.dash import DashSegmentsFD
from yt_dlp.downloader.hls import HlsFD
from yt_dlp.downloader.http import HttpFD
from yt_dlp.networking import Request

from bridge import http_status, identifier, same_attachment, url_extension, youtube_entry
from transport import BridgeError, http_url

PROTOCOLS = {
    "http": HttpFD, "https": HttpFD, "m3u8": HlsFD, "m3u8_native": HlsFD, "http_dash_segments": DashSegmentsFD,
}
LOCAL_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,mpegts,matroska,webm,avi,mp3,aac,ogg,wav,flac,flv,mpeg,ac3,mpegvideo,asf,aiff"
SAFE_INPUT = ("-protocol_whitelist", "file", "-format_whitelist", LOCAL_FORMATS, "-max_streams", "64")
MIME_TYPES = {
    "aac": "audio/aac", "ac3": "audio/ac3", "aiff": "audio/aiff", "flac": "audio/flac",
    "m4a": "audio/mp4", "mp3": "audio/mpeg", "oga": "audio/ogg", "ogg": "audio/ogg",
    "opus": "audio/opus", "wav": "audio/wav", "weba": "audio/webm", "wma": "audio/x-ms-wma",
    "3gp": "video/3gpp", "asf": "video/x-ms-asf", "avi": "video/x-msvideo", "flv": "video/x-flv",
    "m4v": "video/mp4", "mkv": "video/x-matroska", "mov": "video/quicktime", "mp4": "video/mp4",
    "mpeg": "video/mpeg", "mpg": "video/mpeg", "webm": "video/webm", "wmv": "video/x-ms-wmv",
}


def execute(command, *arguments):
    return subprocess.run(
        (command, *arguments), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        check=False,
    )


def probe(path, kind, required=()):
    result = execute(
        "ffprobe", "-v", "error", *SAFE_INPUT, "-count_packets",
        "-show_entries", "stream=codec_type,nb_read_packets:stream_disposition=attached_pic:format=format_name,duration",
        "-of", "json", str(path),
    )
    if result.returncode or result.stderr:
        raise BridgeError("incomplete")
    metadata = json.loads(result.stdout)
    streams = {stream["codec_type"] for stream in metadata["streams"]
               if int(stream.get("nb_read_packets") or 0) > 0 and not stream.get("disposition", {}).get("attached_pic")}
    if not ({kind} | set(required)) <= streams:
        raise BridgeError("incomplete")
    return metadata["format"], streams


def assemble(paths, streams, kind, output, transcode):
    inputs = [argument for path in paths for argument in (*SAFE_INPUT, "-i", str(path))]
    maps = []
    for stream in ("video", "audio"):
        if stream == "video" and kind == "audio":
            continue
        if (index := next((i for i, value in enumerate(streams) if stream in value), None)) is not None:
            maps += ["-map", f"{index}:{'V' if stream == 'video' else 'a'}:0"]
    command = ("-v", "error", "-xerror", "-nostdin", "-y", *inputs, *maps, "-map_metadata", "-1", "-map_chapters", "-1")
    options = ("-movflags", "+faststart") if output.suffix == ".mp4" else ()
    result = execute("ffmpeg", *command, "-c", "copy", *options, str(output))
    if result.returncode or result.stderr:
        if not transcode:
            raise BridgeError("incomplete")
        output.unlink(missing_ok=True)
        result = execute("ffmpeg", *command, "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                         "-threads", "2", "-c:a", "aac", *options, str(output))
        if result.returncode or result.stderr:
            raise BridgeError("incomplete")


def image_type(path):
    with path.open("rb") as file:
        header = file.read(32)
    signatures = (
        (b"\xff\xd8\xff", "jpg", "jpeg"), (b"\x89PNG\r\n\x1a\n", "png", "png"),
        (b"GIF87a", "gif", "gif"), (b"GIF89a", "gif", "gif"), (b"BM", "bmp", "bmp"),
        (b"II*\0", "tif", "tiff"), (b"MM\0*", "tif", "tiff"),
        (b"\0\0\1\0", "ico", "vnd.microsoft.icon"), (b"8BPS", "psd", "vnd.adobe.photoshop"),
    )
    for signature, extension, mime in signatures:
        if header.startswith(signature):
            return extension, "image/" + mime
    if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "webp", "image/webp"
    if header[4:8] == b"ftyp":
        if header[8:12] in (b"avif", b"avis"):
            return "avif", "image/avif"
        if header[8:12] in (b"heic", b"heix", b"mif1", b"msf1"):
            return "heic", "image/heic"
    raise BridgeError("incomplete")


def read_http(ydl, url, headers, cap):
    if not http_url(url):
        raise BridgeError("invalid_url")
    with closing(ydl.urlopen(Request(url, headers=headers))) as response:
        content = response.read(cap + 1)
        if len(content) > cap:
            raise BridgeError("too_large")
        return response.url, content


def check_hls(ydl, info):
    url = info["url"]
    data = info.get("hls_media_playlist_data")
    if not data:
        url, raw = read_http(ydl, url, info.get("http_headers") or {}, 4 * 1024 * 1024)
        data = raw.decode("utf-8-sig")
    lines = {line.strip() for line in data.splitlines()}
    if "#EXTM3U" not in lines or "#EXT-X-ENDLIST" not in lines:
        raise BridgeError("incomplete")
    if not HlsFD.can_download(data, info) or not any(line.startswith("#EXTINF:") for line in lines):
        raise BridgeError("unsupported")
    info["url"] = url
    info["hls_media_playlist_data"] = data


def check_dash(ydl, info):
    if manifest := info.get("manifest_url"):
        _, raw = read_http(ydl, manifest, info.get("http_headers") or {}, 4 * 1024 * 1024)
        if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
            raise BridgeError("unsupported")
        root = ElementTree.fromstring(raw)
        if root.get("type") == "dynamic":
            raise BridgeError("unsupported")


def media_extension(metadata, preferred, kind):
    formats = set(metadata["format_name"].split(","))
    if "mpegts" in formats:
        return "ts"
    if "mov" in formats:
        if kind == "audio":
            return "m4a"
        return preferred if preferred in {"3gp", "m4v", "mov", "mp4"} else "mp4"
    if "matroska" in formats:
        return "weba" if kind == "audio" else "webm" if preferred == "webm" else "mkv"
    if "ogg" in formats:
        return preferred if preferred in {"ogg", "oga", "opus"} else "ogg"
    if "asf" in formats:
        return "wma" if kind == "audio" else "wmv"
    for extension in (preferred, *sorted(formats)):
        if extension in formats and extension in MIME_TYPES:
            return extension
    return ""


def check_bytes(path, limit):
    try:
        size = path.stat().st_size
    except FileNotFoundError as error:
        raise BridgeError("incomplete") from error
    if size > limit:
        raise BridgeError("too_large")
    if not size:
        raise BridgeError("incomplete")
    return size


def download_direct(session, entry, destination, limit, progress, fields):
    headers = {"Referer": entry["pageUrl"], "Accept-Encoding": "identity"}
    with session.request(fields.get("_http_method", "GET"), entry["mediaUrl"], headers=headers,
                         data=fields.get("_http_data"), stream=True, timeout=20) as response:
        if response.status_code != 200 and response.status_code not in fields.get("_http_expected_status", ()):
            raise http_status(response.status_code, response.headers)
        if (validate := fields.get("_http_validate")) is not None and not validate(response):
            raise BridgeError("incomplete")
        content_type = response.headers.get("Content-Type", "").lower().split(";", 1)[0]
        if content_type in ("application/vnd.apple.mpegurl", "application/x-mpegurl", "application/dash+xml", "text/html", "application/xhtml+xml"):
            return False
        length = response.headers.get("Content-Length", "")
        expected = int(length) if length.isdecimal() and len(length) < 18 else None
        if expected is not None and expected > limit:
            raise BridgeError("too_large")
        total = 0
        with destination.open("xb") as file:
            for chunk in response.iter_content(1024 * 1024):
                total += len(chunk)
                if total > limit:
                    raise BridgeError("too_large")
                file.write(chunk)
                progress(total, "downloading")
        if not total or (expected is not None and not response.headers.get("Content-Encoding") and expected != total):
            raise BridgeError("incomplete")
    return True


def selected_video(ydl, entry, source, verify_identity):
    info = ydl.extract_info(source, download=False)
    if not info:
        raise BridgeError("no_media")
    if verify_identity:
        if info.get("_type") == "multi_video":
            parent = identifier(info.get("id"))
            for child in info.get("entries") or ():
                if child and (candidate := youtube_entry(child, source, parent)) and same_attachment(candidate, entry):
                    info = child
                    break
            else:
                raise BridgeError("no_media")
        elif info.get("_type") == "playlist" or not (candidate := youtube_entry(info, source)) or not same_attachment(candidate, entry):
            raise BridgeError("no_media")
    if info.get("_type") in ("playlist", "multi_video") or info.get("is_live") or info.get("has_drm") or (
        info.get("live_status") in ("is_live", "is_upcoming", "post_live")
    ):
        raise BridgeError("unsupported")
    return info


def download_video(extraction, entry, limit, progress, gallery_session=None):
    source = entry.get("mediaUrl") or entry.get("extractionUrl") or entry["pageUrl"]
    with extraction.youtube(gallery_session=gallery_session) as ydl:
        info = selected_video(ydl, entry, source, verify_identity=not entry.get("mediaUrl"))
        formats = info.get("requested_formats") or [info]
        if len(formats) > 2:
            raise BridgeError("unsupported")
        paths = []
        extensions = []
        used = 0
        stream = False
        required = set()
        for index, selected in enumerate(formats):
            fmt = {**info, **selected}
            fmt.pop("requested_formats", None)
            protocol = fmt.get("protocol") or ""
            downloader = PROTOCOLS.get(protocol)
            if not downloader or not http_url(fmt.get("url")) or fmt.get("has_drm"):
                raise BridgeError("unsupported")
            if protocol.startswith("m3u8"):
                check_hls(ydl, fmt)
                stream = True
            elif protocol == "http_dash_segments":
                check_dash(ydl, fmt)
                stream = True
            extension = fmt.get("ext") or ""
            if not re.fullmatch(r"[a-z\d]{1,8}", extension):
                raise BridgeError("unsupported")
            file = Path(f"input-{index}.{extension}")
            fd = downloader(ydl, {**ydl.params, "max_filesize": limit - used})

            def update(event):
                downloaded = used + int(event.get("downloaded_bytes") or 0)
                if downloaded > limit:
                    raise BridgeError("too_large")
                progress(downloaded, "downloading")

            fd.add_progress_hook(update)
            ok, _ = fd.download(str(file), fmt)
            if not ok:
                raise BridgeError("incomplete")
            used += check_bytes(file, limit - used)
            kind = "audio" if fmt.get("vcodec") == "none" else entry["kind"]
            declared = {
                track for track, key in (("video", "vcodec"), ("audio", "acodec"))
                if fmt.get(key) not in (None, "", "none", "unknown")
            }
            metadata, codecs = probe(file, kind, declared)
            required.update(declared)
            paths.append((file, codecs))
            actual_extension = media_extension(metadata, extension, kind)
            extensions.append(actual_extension)
            stream = stream or actual_extension == "ts"
        duration = info.get("duration")
        if not isinstance(duration, (int, float)) or not math.isfinite(duration):
            duration = None
        return paths, extensions, stream, used, duration, required


def download(extraction, request, emit):
    entry = request["entry"]
    with extraction.gallery_attachment(entry) as gallery:
        if gallery:
            current, session, fields = gallery
            return download_attachment(extraction, request, emit, current, session, fields)
        return download_attachment(extraction, request, emit, entry, None, {})


def download_attachment(extraction, request, emit, entry, session, fields):
    kind = entry["kind"]
    limit = request["maxBytes"]
    # FFmpeg also inherits the kernel's per-file ceiling if an input expands during conversion.
    resource.setrlimit(resource.RLIMIT_FSIZE, (limit + 1, limit + 1))
    last = (-1, "")
    def progress(size, phase):
        nonlocal last
        if phase != last[1] or size >= last[0] + 1024 * 1024:
            last = (size, phase)
            emit("progress", bytes=size, phase=phase)
    progress(0, "downloading")

    path = Path("direct-input")
    url = entry.get("mediaUrl")
    extension = url_extension(url) if url else None
    direct = False
    if url and extension not in ("m3u8", "mpd"):
        if session:
            direct = download_direct(session, entry, path, limit, progress, fields)
        else:
            with extraction.gallery_session() as direct_session:
                direct = download_direct(direct_session, entry, path, limit, progress, fields)
    if direct and kind == "image":
        extension, mime_type = image_type(path)
        output = Path("media." + extension)
        path.rename(output)
        return [{"filename": output.name, "mimeType": mime_type}]
    if kind == "image":
        raise BridgeError("unsupported")

    if direct:
        media_format, codecs = probe(path, kind)
        extension = media_extension(media_format, extension, kind)
        paths, extensions, stream, size, duration = [(path, codecs)], [extension], extension == "ts", check_bytes(path, limit), None
        required = codecs & {"video", "audio"}
    else:
        paths, extensions, stream, size, duration, required = download_video(extraction, entry, limit, progress, session)
        if request.get("quality") == "audio":
            kind = "audio"
            required.discard("video")

    # Sound only from a source with no separate audio keeps the sound of its best combined file.
    strip_video = kind == "audio" and any("video" in codecs for _, codecs in paths)
    mp4 = stream or request.get("streamMp4")
    extension = extensions[0]
    if strip_video:
        extension = "m4a"
    elif mp4:
        extension = "mp4"
    elif len(paths) > 1:
        extension = "mp4" if set(extensions) <= {"m4a", "mp4"} else "mkv"
    if extension not in MIME_TYPES:
        raise BridgeError("unsupported")
    output = Path("media." + extension)
    if strip_video or mp4 or len(paths) > 1:
        progress(size, "assembling")
        assemble([path for path, _ in paths], [codecs for _, codecs in paths], kind, output, mp4 or strip_video)
    else:
        paths[0][0].rename(output)

    if any("audio" in tracks for _, tracks in paths):
        required.add("audio")
    media_format, _ = probe(output, kind, required)
    if mp4 and "mp4" not in media_format["format_name"].split(","):
        raise BridgeError("incomplete")
    if duration and media_format.get("duration") and float(media_format["duration"]) + max(2, duration * 0.05) < duration:
        raise BridgeError("incomplete")
    check_bytes(output, limit)
    mime_type = "audio/mp4" if kind == "audio" and extension == "mp4" else MIME_TYPES[extension]
    return [{"filename": output.name, "mimeType": mime_type}]
