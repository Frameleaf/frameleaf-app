"""The server starts one isolated process per JSON request."""
from contextlib import contextmanager, redirect_stdout
from datetime import datetime, timezone
from functools import cached_property
from hashlib import sha256
from itertools import islice
import json
import logging
import os
import re
import shutil
import sys
from urllib.parse import parse_qsl, quote, urlsplit, urlunsplit

import requests
from gallery_dl import config as gallery_config, exception as gallery_error, extractor as gallery
from gallery_dl.extractor.message import Message
from gallery_dl.version import __version__ as gallery_version
from yt_dlp import YoutubeDL
from yt_dlp.networking.exceptions import HTTPError
from yt_dlp.utils import DownloadError, UnsupportedError
from yt_dlp.version import __version__ as yt_version

from transport import BridgeError, curl_handler, domain_matches, gallery_requests_handler, gallery_session_factory, http_url, load_session_cookies, session_domains

IMAGE_EXTENSIONS = frozenset("apng avif bmp dng gif heic heif ico jfif jpeg jpg png psd svg tif tiff webp".split())
VIDEO_EXTENSIONS = frozenset("3gp asf avi flv m2ts m3u8 m4v mkv mov mp4 mpd mpeg mpg mts ts webm wmv".split())
AUDIO_EXTENSIONS = frozenset("aac ac3 aiff alac flac m4a mp3 oga ogg opus wav wma".split())
FEED_CATEGORIES = frozenset(
    "album archive author board bookmark bookmarks channel collection favorites feed favorites following gallery "
    "group hashtag history home likes list media playlist posts profile replies saved search stories subreddit tag timeline tweets user with-replies".split()
)
OUTPUT = sys.stdout


def write_message(kind, **fields):
    OUTPUT.write(json.dumps({"type": kind, **fields}, ensure_ascii=True, allow_nan=False, separators=(",", ":")) + "\n")
    OUTPUT.flush()


class QuietLogger:
    def debug(self, _message):
        pass

    def warning(self, _message):
        pass

    def error(self, _message):
        pass


class Extraction:
    def __init__(self, request):
        self.session = request.get("session") or {}
        self.curl = curl_handler(request["socketPath"], request["token"])
        self.gallery_session = gallery_session_factory(request["socketPath"], request["token"], self.session)
        self.auth_fields = {name for name in ("username", "password", "refreshToken", "accessToken", "clientId", "clientSecret")
                            if self.session.get(name)}

    @contextmanager
    def youtube(self, flat=False, feed=False, gallery_session=None):
        handler = gallery_requests_handler(gallery_session) if gallery_session else self.curl

        class IsolatedYoutubeDL(YoutubeDL):
            @cached_property
            def _request_director(self):
                return self.build_request_director((handler,))

        with IsolatedYoutubeDL({
            "quiet": True,
            "logger": QuietLogger(),
            "cachedir": False,
            "socket_timeout": 20,
            "retries": 2,
            "fragment_retries": 2,
            "skip_unavailable_fragments": False,
            "extractor_retries": 1,
            "enable_file_urls": False,
            "noplaylist": not feed,
            "lazy_playlist": True,
            "extract_flat": "in_playlist" if flat else False,
            "js_runtimes": {"node": {"path": "/usr/local/bin/node"} if sys.platform == "linux" else {}},
            "remote_components": [],
            "external_downloader": "native",
            "continuedl": False,
            "noprogress": True,
            "overwrites": False,
            "hls_use_mpegts": True,
            "geo_bypass": False,
        }) as ydl:
            load_session_cookies(ydl.cookiejar, self.session)
            yield ydl

    def configure_gallery(self, provider, url, authored_only):
        gallery_config.set(("cache",), "file", ":memory:")
        for key, value in (
            ("proxy-env", False), ("retries", 1), ("timeout", 20), ("cookies-update", False),
            ("geo-bypass", None), ("input", False), ("write-pages", False),
        ):
            gallery_config.set(("extractor",), key, value)
        if authored_only and provider == "twitter":
            for key, value in (
                ("strategy", "with_replies"), ("replies", "self"), ("retweets", False),
                ("quoted", False), ("text-tweets", False), ("unavailable", True),
            ):
                gallery_config.set(("extractor", "twitter"), key, value)
        if authored_only and provider == "reddit":
            for key, value in (("comments", False), ("selftext", False), ("only", True)):
                gallery_config.set(("extractor", "reddit"), key, value)
        if not self.auth_fields:
            return

        parts = urlsplit(url)
        if parts.scheme != "https" or not domain_matches(parts.hostname, session_domains(self.session)):
            raise BridgeError("unsupported_session")
        if provider == "bluesky" and self.auth_fields == {"username", "password"}:
            for key in ("username", "password"):
                gallery_config.set(("extractor", "bluesky"), key, self.session[key])
        elif provider == "reddit" and self.auth_fields in (
            {"refreshToken"}, {"refreshToken", "clientId"}, {"refreshToken", "clientId", "clientSecret"},
        ):
            for key, prop in (("refresh-token", "refreshToken"), ("client-id", "clientId")):
                if prop in self.auth_fields:
                    gallery_config.set(("extractor", "reddit"), key, self.session[prop])
        else:
            raise BridgeError("unsupported_session")

    @contextmanager
    def gallery_transport(self):
        # gallery-dl creates its sessions lazily during extraction.
        previous_session = requests.Session
        requests.Session = self.gallery_session
        try:
            yield
        finally:
            requests.Session = previous_session

    @contextmanager
    def gallery_attachment(self, selected):
        locator = selected.get("extractionUrl")
        if not locator or not selected.get("mediaUrl"):
            yield None
            return
        source = gallery.find(locator)
        provider = selected["provider"]
        if provider == "directlink" or (provider == "generic" and (not source or source.category != provider)):
            current = gallery_entry(provider, locator, locator, {"extension": url_extension(locator)})
            if not current or not same_attachment(current, selected):
                raise BridgeError("no_media")
            yield current, None, {}
            return
        if not source or source.category != provider or source.category == "ytdl":
            raise BridgeError("no_media")
        target = creator_feed(locator)
        if target != locator:
            source = gallery.find(target) or source
        self.configure_gallery(source.category, locator, target != locator)
        kind = "feed" if source.subcategory in FEED_CATEGORIES else "item"
        with self.gallery_transport():
            candidates = self.gallery_entries(source, target, set(), None, requested_kind=kind, context=True)
            for candidate in islice(candidates, 10_000):
                if not candidate or not same_attachment(candidate[0], selected):
                    continue
                current, session, fields = candidate
                headers = fields.get("_http_headers") or {}
                with session, session.file_headers(current["extractionUrl"], current["mediaUrl"], headers):
                    yield candidate
                return
        raise BridgeError("no_media")

    def gallery_entries(self, source, url, seen, identity, depth=0, requested_kind="item", context=False):
        if depth > 3 or url in seen:
            yield None
            return
        seen.add(url)
        reddit_posts = 0
        for message, target, fields in source:
            if message == Message.Directory:
                if source.category == "reddit":
                    reddit_posts += 1
                if identity is not None and not identity[0] and requested_kind == "feed":
                    identity[:] = creator_fields(fields)
            if message == Message.Url:
                entry = gallery_entry(source.category, url, target, fields)
                if entry and entry["extractionUrl"] != url:
                    replay = gallery.find(entry["extractionUrl"])
                    if not replay or replay.category != source.category:
                        entry["extractionUrl"] = url
                yield (entry, source.session, fields) if context and entry else entry
            elif message == Message.Queue:
                target = http_url(target)
                if not target:
                    yield None
                    continue
                child = gallery.find(target)
                if child and child.category != "ytdl" and (
                    requested_kind == "feed" or child.subcategory not in FEED_CATEGORIES
                ):
                    yield from self.gallery_entries(child, target, seen, identity, depth + 1, requested_kind, context)
                elif not context:
                    # A queued URL can be a video embed or a post URL from another provider.
                    with self.youtube(flat=True) as ydl:
                        metadata = ydl.extract_info(target, download=False)
                        if not metadata or metadata.get("_type") in ("playlist", "multi_video"):
                            yield None
                        else:
                            yield from youtube_candidates(ydl, metadata, target)
        if source.status:
            raise BridgeError("incomplete")
        if reddit_posts >= 1000 and requested_kind == "feed":
            raise BridgeError("incomplete")

    def inspect(self, request):
        url = http_url(request["url"])
        if not url:
            raise BridgeError("invalid_url")
        enumerate_feed = request["operation"] == "enumerate"
        checkpoint = request.get("checkpoint") if enumerate_feed else None
        since = request.get("since") if enumerate_feed else None
        source = gallery.find(url)
        if source and source.category == "directlink":
            if self.auth_fields:
                raise BridgeError("unsupported_session")
            entry = self.direct_entry(url, "directlink")
            return inspection(url, entry["provider"], "item", [entry], None, None, entry["title"])
        if source and source.category != "ytdl":
            provider = source.category
            target = creator_feed(url)
            authored_only = target != url or source.subcategory in ("timeline", "replies", "user-submitted")
            if target != url:
                source = gallery.find(target) or source
            self.configure_gallery(provider, url, authored_only)
            kind = "feed" if authored_only or source.subcategory in FEED_CATEGORIES or source.subcategory.startswith("user-") else "item"
            identity = [None, None]
            identifies_creator = authored_only or source.subcategory in ("channel", "profile", "user")
            with self.gallery_transport():
                entries, next_checkpoint, limitation = list_entries(
                    self.gallery_entries(source, target, set(), identity if identifies_creator else None, requested_kind=kind),
                    max(1, min(request.get("limit") or (100 if kind == "item" else 24), 100)),
                    checkpoint, since,
                )
            if len({entry["postId"] for entry in entries}) > 1:
                kind = "feed"
            if authored_only and not identity[0]:
                if provider == "bluesky" and getattr(source, "_user_did", None):
                    identity[:] = [source._user_did, source.groups[0]]
                elif provider == "twitter" and getattr(source, "_user_obj", None):
                    identity[:] = creator_fields({"author": source._transform_user(source._user_obj)})
                elif provider == "reddit" and (user := source.kwdict.get("user")) and user.get("id"):
                    identity[:] = ["t2_" + user["id"], user.get("name")]
            return inspection(url, provider, kind, entries, next_checkpoint, limitation, identity=identity)

        if self.auth_fields:
            raise BridgeError("unsupported_session")
        with self.youtube(flat=True, feed=enumerate_feed) as ydl:
            try:
                metadata = ydl.extract_info(url, download=False)
            except DownloadError as error:
                # The generic extractor's expected no-video path can still be a direct image.
                classified = error_code(error)
                if classified.code not in ("unsupported", "no_media"):
                    raise classified from error
                entry = self.direct_entry(url)
                return inspection(url, entry["provider"], "item", [entry], None, None, entry["title"])
            if not metadata:
                raise BridgeError("no_media")
            result_type = metadata.get("_type")
            kind = "feed" if result_type == "playlist" else "item"
            provider = youtube_provider(metadata)
            canonical = public_source(url, metadata.get("webpage_url") or metadata.get("original_url"))
            candidates = youtube_candidates(ydl, metadata, url)
            cutoff = published_date(since)

            def resolve_date(entry):
                if entry["provider"] != "youtube":
                    return None
                details = ydl.extract_info(entry.get("extractionUrl") or entry["pageUrl"], download=False)
                exact = published_date(details.get("timestamp"), details.get("release_timestamp"))
                day = published_date(details.get("upload_date"))
                return exact or (day if day and cutoff and day[:10] != cutoff[:10] else None)

            entries, next_checkpoint, limitation = list_entries(
                candidates, max(1, min(request.get("limit") or (24 if kind == "feed" else 100), 100)), checkpoint, since,
                resolve_date if provider == "youtube" else None,
            )
            return inspection(canonical or url, provider, kind, entries, next_checkpoint, limitation,
                              bounded_text(metadata.get("title"), 512), creator_fields(metadata))

    def direct_entry(self, url, provider="generic"):
        extension = url_extension(url)
        if extension not in IMAGE_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS:
            raise BridgeError("unsupported")
        with self.gallery_session() as session:
            with session.head(url, timeout=20, allow_redirects=True) as response:
                status = response.status_code
                headers = response.headers
            if status in (403, 405):
                with session.get(url, headers={"Range": "bytes=0-0"}, stream=True, timeout=20) as response:
                    status = response.status_code
                    headers = response.headers
            if status >= 400:
                raise http_status(status, headers)
            mime_type = headers.get("Content-Type", "").split(";", 1)[0].lower()
            if mime_type in ("text/html", "application/xhtml+xml"):
                raise BridgeError("unsupported")
            if extension in IMAGE_EXTENSIONS and not mime_type.startswith("image/"):
                raise BridgeError("unsupported")
        entry = gallery_entry(provider, url, url, {"extension": extension})
        if entry is None:
            raise BridgeError("unsupported")
        return entry


def bounded_text(value, limit):
    if not isinstance(value, str):
        return ""
    return "".join(c for c in value[:limit] if c >= " " or c in "\n\t").strip()


def identifier(value):
    if isinstance(value, int):
        return str(value)
    if http_url(value):
        value = public_page(value)
    return bounded_text(value, 256) or None


def first_id(*values):
    return next((candidate for value in values if (candidate := identifier(value))), None)


def published_date(*values):
    for value in values:
        try:
            if isinstance(value, (int, float)):
                timestamp = datetime.fromtimestamp(value, timezone.utc)
            elif isinstance(value, datetime):
                timestamp = value
            elif isinstance(value, str):
                timestamp = (datetime.strptime(value, "%Y%m%d") if re.fullmatch(r"\d{8}", value)
                             else datetime.fromisoformat(value))
            else:
                continue
            if timestamp.tzinfo is None:
                timestamp = timestamp.replace(tzinfo=timezone.utc)
            return timestamp.astimezone(timezone.utc).isoformat()
        except (ValueError, OverflowError, OSError):
            continue
    return None


def public_page(url):
    if not http_url(url):
        return None
    parts = urlsplit(url)
    # Only these provider-defined identifiers are safe to keep on public source links.
    host = parts.hostname.removeprefix("www.").removeprefix("m.")
    path = parts.path.rstrip("/")
    key = None
    pattern = r"[a-zA-Z0-9_-]{1,128}"
    if host == "youtube.com" and path in ("/watch", "/playlist"):
        key = "v" if path == "/watch" else "list"
    elif host in ("pornhub.com", "pornhub.org") and path == "/view_video.php":
        key = "viewkey"
    elif host == "facebook.com" and path in ("/watch", "/video.php"):
        key = "v"
        pattern = r"[0-9]{1,32}"
    query = next((f"{key}={value}" for name, value in parse_qsl(parts.query)
                  if name == key and re.fullmatch(pattern, value)), "") if key else ""
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, ""))


def public_source(original, canonical):
    page = public_page(original)
    if page and urlsplit(page).query:
        return page
    return public_page(canonical) or page


def creator_feed(url):
    parts = urlsplit(url)
    path = parts.path.rstrip("/")
    host = parts.hostname.removeprefix("www.")
    if host in ("x.com", "twitter.com"):
        match = re.fullmatch(r"/([a-zA-Z0-9_]{1,15})(?:/(?:media|tweets|with_replies|timeline))?", path)
        if match and match[1].lower() not in {"home", "search", "explore", "notifications", "messages", "settings", "compose", "i", "intent"}:
            return urlunsplit((parts.scheme, parts.netloc, f"/{match[1]}/timeline", "", ""))
    elif host == "bsky.app":
        match = re.fullmatch(r"(/profile/[^/]+)(?:/(?:posts|media|replies))?", path)
        if match:
            return urlunsplit((parts.scheme, parts.netloc, match[1] + "/replies", "", ""))
    elif host in ("reddit.com", "old.reddit.com"):
        match = re.fullmatch(r"/(?:u|user)/([a-zA-Z0-9_-]+)(?:/submitted)?", path)
        if match:
            return urlunsplit((parts.scheme, parts.netloc, f"/user/{match[1]}/submitted", parts.query, ""))
    return url


def url_extension(url):
    return urlsplit(url).path.rsplit("/", 1)[-1].lower().rpartition(".")[2]


def creator_fields(data):
    author = data.get("author") or data.get("user") or data.get("account") or {}
    if not isinstance(author, dict):
        author = {"name": author}
    creator_id = first_id(data.get("channel_id"), data.get("uploader_id"), data.get("author_fullname"),
                          author.get("did"), author.get("id"), author.get("rest_id"), author.get("handle"), author.get("nick"))
    creator = next((value for key in ("displayName", "name", "display_name", "nick", "handle")
                    if (value := bounded_text(author.get(key), 512))), None)
    creator = creator or bounded_text(data.get("channel") or data.get("uploader"), 512) or None
    return creator_id, creator


def gallery_entry(provider, source_url, media_url, fields):
    if isinstance(media_url, str) and media_url.startswith("ytdl:"):
        media_url = media_url[5:]
    if not http_url(media_url):
        return None
    creator_id, creator = creator_fields(fields)
    file_id = first_id(fields.get("media_id"), fields.get("media_key"), fields.get("file_id"), fields.get("filename"))
    url_id = sha256((public_page(media_url) or "").encode()).hexdigest()[:32]
    post_id = first_id(fields.get("tweet_id"), fields.get("post_id"), fields.get("submission_id"),
                       fields.get("id"), fields.get("shortcode"), fields.get("gallery_id"), fields.get("uri"))
    locator = source_url
    if provider == "twitter" and fields.get("tweet_id"):
        locator = "https://x.com/i/web/status/" + quote(post_id, safe="")
    elif provider == "bluesky" and creator_id and fields.get("post_id"):
        locator = "https://bsky.app/profile/" + quote(creator_id, safe=":") + "/post/" + quote(post_id, safe="")
    elif provider == "reddit" and fields.get("permalink"):
        locator = http_url("https://www.reddit.com" + fields["permalink"]) or locator
    else:
        locator = http_url(fields.get("post_url") or fields.get("webpage_url")) or locator
    attachment_id = file_id or first_id(fields.get("num"), fields.get("index")) or url_id
    extension = (identifier(fields.get("extension")) or url_extension(media_url)).lower()
    media_extension = url_extension(media_url)
    if media_extension in ("m3u8", "mpd") or extension in VIDEO_EXTENSIONS or fields.get("type") == "article:video":
        kind = "video"
    elif extension in AUDIO_EXTENSIONS:
        kind = "audio"
    elif extension in IMAGE_EXTENSIONS:
        kind = "image"
    else:
        return None
    return {
        "provider": provider,
        "creatorId": creator_id,
        "postId": post_id or file_id or url_id,
        "attachmentId": attachment_id,
        "pageUrl": public_source(source_url, locator),
        "extractionUrl": locator,
        "mediaUrl": media_url,
        "title": bounded_text(fields.get("title") or fields.get("text") or fields.get("content"), 512) or "Media",
        "description": bounded_text(fields.get("description") or fields.get("text") or fields.get("content") or fields.get("selftext"), 4000),
        "creator": creator,
        "publishedAt": published_date(fields.get("date"), fields.get("createdAt"), fields.get("created_utc")),
        "kind": kind,
    }


def youtube_provider(metadata):
    return (metadata.get("extractor") or metadata.get("ie_key") or metadata.get("extractor_key") or "generic").lower().split(":", 1)[0]


def youtube_entry(info, source_url, parent=None):
    media_id = identifier(info.get("id"))
    source = info.get("webpage_url") or (info.get("url") if info.get("_type") in ("url", "url_transparent") else source_url)
    page = public_page(source) or public_page(source_url)
    if not media_id or not page or (info.get("live_status") in ("is_live", "is_upcoming", "post_live")):
        return None
    provider = youtube_provider(info)
    if provider == "youtube" and not public_page(source):
        page = "https://www.youtube.com/watch?v=" + quote(media_id, safe="")
    creator_id, creator = creator_fields(info)
    locator = http_url(source_url if parent else source) or page
    entry = {
        "provider": provider,
        "creatorId": creator_id,
        "postId": parent or media_id,
        "attachmentId": media_id,
        "pageUrl": public_page(locator),
        "extractionUrl": locator,
        "title": bounded_text(info.get("title"), 512) or "Media",
        "description": bounded_text(info.get("description"), 4000),
        "creator": creator,
        "publishedAt": published_date(info.get("timestamp"), info.get("release_timestamp"), info.get("upload_date")),
        "kind": "audio" if info.get("vcodec") == "none" else "video",
    }
    if http_url(info.get("thumbnail")):
        entry["thumbnailUrl"] = info["thumbnail"]
    return entry


def same_attachment(first, second):
    return all(first[key] == second[key] for key in ("provider", "postId", "attachmentId"))


def youtube_locator(metadata, source_url, exact_source):
    if exact_source:
        return source_url
    if metadata.get("_type") in ("url", "url_transparent") and (target := http_url(metadata.get("url"))):
        return target
    original = http_url(metadata.get("original_url"))
    return original if original != source_url else None


def youtube_candidates(ydl, metadata, source_url, parent=None, depth=0, exact_source=True):
    if depth > 3 or not metadata:
        yield None
        return
    if metadata.get("live_status") in ("is_live", "is_upcoming", "post_live"):
        return
    if metadata.get("availability") in ("private", "premium_only", "subscriber_only"):
        yield None
        return
    result_type = metadata.get("_type")
    if result_type in ("playlist", "multi_video"):
        if result_type == "multi_video":
            parent = identifier(metadata.get("id"))
            source_url = youtube_locator(metadata, source_url, exact_source) or http_url(metadata.get("webpage_url")) or source_url
        for item in metadata.get("entries") or ():
            yield from youtube_candidates(ydl, item, source_url, parent, depth + 1, exact_source=False)
    elif metadata.get("ie_key") == "YoutubeTab":
        target = http_url(metadata.get("url"))
        if not target or urlsplit(target).hostname not in ("www.youtube.com", "youtube.com", "m.youtube.com") or not re.fullmatch(
            r"/(?:@[^/]+|(?:channel|user|c)/[^/]+)/(?:videos|shorts|streams)/?", urlsplit(target).path,
        ):
            yield None
            return
        child = ydl.extract_info(target, download=False)
        yield from youtube_candidates(ydl, child, target, depth=depth + 1)
    else:
        entry = youtube_entry(metadata, source_url, parent)
        locator = source_url if parent else youtube_locator(metadata, source_url, exact_source)
        if entry and locator:
            entry["extractionUrl"] = locator
            entry["pageUrl"] = public_source(locator, entry["pageUrl"])
        yield entry


def list_entries(entries, limit, checkpoint, since, resolve_date=None):
    result = []
    seen = set()
    checkpoint, _, previous_limit = (checkpoint or "").partition(":")
    partial = previous_limit == "partial"
    unknown_date = previous_limit == "unknown"
    marker_found = not checkpoint
    seen_media = False
    last_marker = None
    cutoff = published_date(since)
    date_lookups = 0

    def continuation():
        suffix = ":unknown" if unknown_date else ":partial" if partial else ""
        return last_marker + suffix if last_marker else None

    try:
        for index, entry in enumerate(islice(entries, 10_001)):
            if index == 10_000:
                return result, continuation(), "scan_limit"
            if not entry:
                partial = True
                continue
            seen_media = True
            marker = sha256(json.dumps([entry["provider"], entry["postId"], entry["attachmentId"]]).encode()).hexdigest()
            if marker in seen:
                continue
            seen.add(marker)
            if not marker_found:
                marker_found = marker == checkpoint
                if marker_found:
                    last_marker = marker
                continue
            if len(result) >= limit:
                return result, continuation(), "limit"
            if cutoff and not entry["publishedAt"] and resolve_date:
                if date_lookups == 12:
                    return result, continuation(), "date_lookup_limit"
                date_lookups += 1
                try:
                    date = resolve_date(entry)
                except Exception as error:
                    failure = error_code(error)
                    if failure.code in ("authentication_required", "rate_limited"):
                        raise failure from error
                    date = None
                entry = {**entry, "publishedAt": date}
            last_marker = marker
            if cutoff:
                if not entry["publishedAt"]:
                    unknown_date = True
                    continue
                if entry["publishedAt"] < cutoff:
                    continue
            result.append(entry)
    except Exception as error:
        if not result:
            raise error_code(error) from error
        return result, continuation(), "partial"
    if not marker_found:
        return [], None, "checkpoint_missing"
    if unknown_date:
        return result, None, "unknown_publish_date"
    return result, None, "partial" if partial else None if seen_media else "no_media"


def inspection(url, provider, kind, entries, checkpoint, limitation, title=None, identity=(None, None)):
    creator_id, creator = identity
    if entries and kind == "item":
        creator_id = creator_id or entries[0]["creatorId"]
        creator = creator or entries[0]["creator"]
    return {
        "kind": kind,
        "provider": provider,
        "creatorId": creator_id,
        "creator": creator,
        "title": title or (entries[0]["title"] if kind == "item" and entries else creator) or urlsplit(url).hostname,
        "canonicalUrl": public_page(url) or url,
        "entries": entries,
        "checkpoint": checkpoint,
        "complete": limitation is None,
        "limitation": limitation,
    }


def http_status(status, headers):
    if status == 429:
        retry_after = headers.get("Retry-After")
        return BridgeError("rate_limited", int(retry_after) if str(retry_after).isdigit() and len(str(retry_after)) <= 5 else None)
    if status in (401, 403):
        return BridgeError("authentication_required")
    if status in (404, 410):
        return BridgeError("no_media")
    return BridgeError("failed")


def error_code(error):
    if isinstance(error, BridgeError):
        return error
    if isinstance(error, UnsupportedError) or isinstance(getattr(error, "exc_info", None), tuple) and isinstance(error.exc_info[1], UnsupportedError):
        return BridgeError("unsupported")
    if isinstance(error, (gallery_error.AuthenticationError, gallery_error.AuthorizationError)):
        return BridgeError("authentication_required")
    if isinstance(error, gallery_error.NotFoundError):
        return BridgeError("no_media")
    for inner in (error, getattr(error, "cause", None), getattr(error, "__cause__", None),
                  getattr(error, "exc_info", (None, None))[1] if getattr(error, "exc_info", None) else None):
        response = getattr(inner, "response", None)
        status = getattr(response, "status", None) or getattr(response, "status_code", None)
        if status:
            return http_status(status, response.headers)
        if isinstance(inner, HTTPError):
            return http_status(inner.status, inner.response.headers)
    if isinstance(error, DownloadError):
        details = str(error).lower()
        if "unsupported url" in details:
            return BridgeError("unsupported")
        if "no video" in details or "no formats" in details or "no media" in details:
            return BridgeError("no_media")
        if "sign in" in details or "login required" in details or "private video" in details:
            return BridgeError("authentication_required")
        if "http error 429" in details:
            return BridgeError("rate_limited")
    return BridgeError("failed")


def main():
    os.environ["YTDLP_NO_PLUGINS"] = "1"
    logging.disable(logging.CRITICAL)
    try:
        with redirect_stdout(sys.stderr):
            request = json.load(sys.stdin)
            operation = request["operation"]
            if operation == "capabilities":
                import yt_dlp_ejs
                available = bool(yt_dlp_ejs and all(shutil.which(name) for name in ("ffmpeg", "ffprobe", "node")))
                result = {
                    "available": available, "reason": None if available else "Required media runtime binaries are unavailable.",
                    "ytDlpVersion": yt_version, "galleryDlVersion": gallery_version,
                }
            elif operation in ("inspect", "enumerate"):
                result = Extraction(request).inspect(request)
            elif operation == "download":
                from media import download
                result = download(Extraction(request), request, write_message)
            else:
                raise BridgeError("failed")
        write_message("result", result=result)
    except Exception as error:
        failure = error_code(error)
        write_message("error", code=failure.code, retryAfter=failure.retry_after)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
