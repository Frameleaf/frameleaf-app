"""Local generated fixtures through both HTTP transports, with no external destinations."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import select
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest

from transport import read_exact

TOKEN = "a" * 64
BRIDGE = Path(__file__).with_name("fixture_extractors.py").resolve()
FIXTURE = "http://fixture.invalid:8080"
CDN = "http://cdn.fixture.invalid:8080"


class FixtureHttp(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def redirect(self):
        if self.path != "/redirect.mp4":
            return False
        self.send_response(302)
        self.send_header("Location", FIXTURE + "/video.mp4")
        self.end_headers()
        return True

    def do_GET(self):
        if self.path.startswith("/gallery?post="):
            self.send_response(200)
            self.send_header("Set-Cookie", "fixture_grant=authorized; Path=/")
            self.end_headers()
            return
        if self.path.startswith("/gated"):
            if ("fixture_grant=authorized" not in (self.headers.get("Cookie") or "")
                    or self.headers.get("X-Fixture-Attachment") != "protected"
                    or self.headers.get("User-Agent") != "FrameleafFixture/1.0"
                    or self.headers.get("X-API-Key") != "fixture-key"
                    or self.headers.get("X-Auth-Token") != "fixture-token"):
                self.send_error(403)
                return
            if self.path == "/gated-redirect.mp4":
                self.send_response(302)
                self.send_header("Location", CDN + "/redacted.mp4")
                self.end_headers()
                return
            if self.path == "/gated-cross.m3u8":
                original = Path(self.directory, "vod.m3u8").read_text()
                payload = original.replace("vod0.ts", CDN + "/redacted/vod0.ts").replace(
                    "vod1.ts", CDN + "/redacted/vod1.ts").encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/vnd.apple.mpegurl")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            self.path = "/vod.m3u8" if self.path.endswith(".m3u8") else "/video.mp4"
        elif self.path in ("/cross-file.mp4", "/redacted.mp4") or self.path.startswith("/redacted/"):
            per_file = "protected" if self.path == "/cross-file.mp4" else None
            if (self.headers.get("Host") != "cdn.fixture.invalid:8080"
                    or any(self.headers.get(key) for key in ("X-API-Key", "X-Auth-Token", "Cookie"))
                    or self.headers.get("X-Fixture-Attachment") != per_file
                    or self.headers.get("User-Agent") != "FrameleafFixture/1.0"):
                self.send_error(403)
                return
            self.path = self.path.removeprefix("/redacted") if self.path.startswith("/redacted/") else "/video.mp4"
        if not self.redirect():
            super().do_GET()

    def send_head(self):
        requested = self.headers.get("Range", "")
        if self.path != "/range.m4s" or not requested.startswith("bytes="):
            return super().send_head()
        start, end = map(int, requested.removeprefix("bytes=").split("-"))
        file = Path(self.directory, "range.m4s").open("rb")
        size = file.seek(0, os.SEEK_END)
        file.seek(start)
        data = file.read(end - start + 1)
        file.close()
        self.send_response(206)
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        from io import BytesIO
        return BytesIO(data)

    def do_HEAD(self):
        if not self.redirect():
            super().do_HEAD()


class FixtureSocks(socketserver.BaseRequestHandler):
    def handle(self):
        client = self.request
        client.settimeout(5)
        try:
            version, count = read_exact(client, 2)
            if version != 5 or 2 not in read_exact(client, count):
                return
            client.sendall(b"\x05\x02")
            if read_exact(client, 5) != b"\x01\x03job" or read_exact(client, 1) != bytes([len(TOKEN)]):
                return
            if read_exact(client, len(TOKEN)) != TOKEN.encode():
                return
            client.sendall(b"\x01\x00")
            if read_exact(client, 4) != b"\x05\x01\x00\x03":
                return
            (length,) = read_exact(client, 1)
            if read_exact(client, length) not in (b"fixture.invalid", b"cdn.fixture.invalid") or read_exact(client, 2) != b"\x1f\x90":
                return
            with socket.create_connection(self.server.fixture_origin) as remote:
                client.sendall(b"\x05\x00\x00\x01" + b"\x00" * 6)
                while True:
                    readable, _, _ = select.select((client, remote), (), (), 10)
                    for connection in readable:
                        data = connection.recv(65536)
                        if not data:
                            return
                        (client if connection is remote else remote).sendall(data)
                    if not readable:
                        return
        except OSError:
            pass


def make_video(directory, filename, *format_options):
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "2",
        "-c:v", "libx264", "-threads", "1", "-g", "10", "-c:a", "aac",
        *format_options, filename,
    ], cwd=directory, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


class RuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory(prefix="flmd-test-", dir="/tmp")
        cls.addClassCleanup(cls.workspace.cleanup)
        cls.directory = Path(cls.workspace.name)
        cls.directory.chmod(0o711)
        fixtures = cls.directory / "fixtures"
        fixtures.mkdir()
        make_video(fixtures, "video.mp4")
        make_video(fixtures, "silent.mp4", "-an")
        make_video(fixtures, "ts.ts", "-f", "mpegts")
        make_video(fixtures, "vod.m3u8", "-hls_time", "1", "-hls_list_size", "0")
        make_video(fixtures, "dash.mpd", "-f", "dash", "-seg_duration", "1")
        key = fixtures / "key.bin"
        key.write_bytes(bytes(range(16)))
        (fixtures / "keyinfo").write_text(f"key.bin\n{key}\n")
        make_video(fixtures, "encrypted.m3u8", "-hls_time", "1", "-hls_list_size", "0", "-hls_key_info_file", "keyinfo")
        make_video(fixtures, "range.m3u8", "-hls_time", "1", "-hls_list_size", "0", "-hls_segment_type", "fmp4",
                   "-hls_flags", "single_file")
        range_playlist = (fixtures / "range.m3u8").read_text()
        split = range_playlist.index("#EXTINF:", range_playlist.index("#EXTINF:") + 1)
        (fixtures / "range.m3u8").write_text(range_playlist[:split] + "#EXT-X-DISCONTINUITY\n" + range_playlist[split:])
        manifest = (fixtures / "vod.m3u8").read_text()
        (fixtures / "broken.m3u8").write_text(manifest.replace("vod1.ts", "missing.ts"))
        (fixtures / "live.m3u8").write_text(manifest.replace("#EXT-X-ENDLIST\n", ""))
        (fixtures / "local.m3u8").write_text(manifest.replace("vod1.ts", "file:///etc/hosts"))
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), partial(FixtureHttp, directory=fixtures))
        cls.proxy_path = str(cls.directory / "s")
        cls.proxy = socketserver.ThreadingUnixStreamServer(cls.proxy_path, FixtureSocks)
        cls.proxy.daemon_threads = True
        os.chmod(cls.proxy_path, 0o666)
        cls.proxy.fixture_origin = cls.http.server_address
        for server in (cls.http, cls.proxy):
            threading.Thread(target=server.serve_forever, daemon=True).start()
            cls.addClassCleanup(server.server_close)
            cls.addClassCleanup(server.shutdown)

    def run_bridge(self, operation, **request):
        work = tempfile.TemporaryDirectory(dir=self.directory)
        self.addCleanup(work.cleanup)
        env = {**os.environ, "PATH": os.environ["PATH"], "XDG_CONFIG_HOME": work.name, "XDG_CACHE_HOME": work.name}
        command = [sys.executable, "-Bs", str(BRIDGE)]
        if launcher := shutil.which("frameleaf-media-test-launcher"):
            command = [launcher, work.name, "203721", *command]
        process = subprocess.run(
            command, cwd=work.name, env=env, text=True, capture_output=True, check=False, timeout=75,
            input=json.dumps({"operation": operation, "socketPath": self.proxy_path, "token": TOKEN, **request}),
        )
        self.assertTrue(process.stdout.strip(), process.stderr)
        messages = list(map(json.loads, process.stdout.splitlines()))
        return messages[-1], Path(work.name)

    def download(self, resource, *, direct=False, **options):
        if direct:
            entry = {"provider": "generic", "postId": "ts", "attachmentId": "ts",
                     "kind": "video", "pageUrl": FIXTURE + "/" + resource, "mediaUrl": FIXTURE + "/" + resource}
        else:
            inspection, _ = self.run_bridge("inspect", url=FIXTURE + "/" + resource)
            self.assertEqual(inspection["type"], "result", inspection)
            (entry,) = inspection["result"]["entries"]
        return self.run_bridge("download", entry=entry, maxBytes=5_000_000, **options)

    def test_missing_direct_media_is_not_reported_as_accessible(self):
        response, _ = self.run_bridge("inspect", url=FIXTURE + "/absent.mp4")
        self.assertEqual(response["type"], "error")
        self.assertEqual(response["code"], "no_media")

    def test_inspects_and_downloads_original_through_unix_socks(self):
        response, folder = self.download("redirect.mp4")
        self.assertEqual(response["type"], "result", response)
        self.assertEqual(response["result"], [{"filename": "media.mp4", "mimeType": "video/mp4"}])
        self.assertGreater((folder / "media.mp4").stat().st_size, 1000)

    def test_assembles_hls_dash_and_transport_stream_with_audio(self):
        for resource, direct in (("vod.m3u8", False), ("dash.mpd", False), ("ts.ts", True)):
            with self.subTest(resource=resource):
                response, folder = self.download(resource, direct=direct)
                self.assertEqual(response["type"], "result", response)
                self.assertEqual(response["result"], [{"filename": "media.mp4", "mimeType": "video/mp4"}])
                kinds = subprocess.check_output([
                    "ffprobe", "-v", "error", "-show_entries", "stream=codec_type",
                    "-of", "csv=p=0", str(folder / "media.mp4"),
                ], text=True).splitlines()
                self.assertEqual(sorted(kinds), ["audio", "video"])

    def test_query_identified_video_is_replayed_without_publishing_query(self):
        inspection, _ = self.run_bridge("inspect", url=FIXTURE + "/player.php?clip=original&signature=private")
        self.assertEqual(inspection["type"], "result", inspection)
        (entry,) = inspection["result"]["entries"]
        self.assertEqual(entry["pageUrl"], FIXTURE + "/player.php")
        self.assertEqual(entry["attachmentId"], "original")
        self.assertEqual((entry["section"], entry["tags"], entry["duration"]), ("video", ["Fixture", "clip"], 2.0))
        self.assertNotIn("playlistId", entry)
        self.assertIsNone(inspection["result"]["profile"])
        result, _ = self.run_bridge("download", entry=entry, maxBytes=5_000_000)
        self.assertEqual(result["type"], "result", result)

    def test_extractor_fields_name_a_short_and_gallery_tags(self):
        inspection, _ = self.run_bridge("inspect", url=FIXTURE + "/player.php?clip=short")
        self.assertEqual(inspection["result"]["entries"][0]["section"], "short")
        inspection, _ = self.run_bridge("inspect", url=FIXTURE + "/gallery?post=fixture")
        (entry,) = inspection["result"]["entries"]
        self.assertEqual((entry["tags"], entry["duration"]), (["fixture", "protected"], 2.0))
        self.assertNotIn("section", entry)

    def test_quality_limits_height_and_sound_only_drops_the_picture(self):
        response, folder = self.download("player.php?clip=original", quality="720")
        self.assertEqual(response["result"], [{"filename": "media.mp4", "mimeType": "video/mp4"}], response)
        response, folder = self.download("player.php?clip=original", quality="audio")
        self.assertEqual(response["result"], [{"filename": "media.m4a", "mimeType": "audio/mp4"}], response)
        kinds = subprocess.check_output([
            "ffprobe", "-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(folder / "media.m4a"),
        ], text=True).splitlines()
        self.assertEqual(kinds, ["audio"])

    def test_nested_query_locators_replay_exact_flat_and_resolved_leaves(self):
        response, _ = self.run_bridge("inspect", url=FIXTURE + "/fixture-collection/nested")
        self.assertEqual(response["type"], "result", response)
        entries = response["result"]["entries"]
        self.assertEqual([entry["attachmentId"] for entry in entries], ["flat", "resolved"])
        self.assertEqual({(entry["playlistId"], entry["playlistTitle"]) for entry in entries}, {("nested", "Fixture collection")})
        for entry in entries:
            with self.subTest(attachment=entry["attachmentId"]):
                self.assertEqual(entry["pageUrl"], FIXTURE + "/player.php")
                self.assertEqual(entry["extractionUrl"], FIXTURE + "/player.php?clip=" + entry["attachmentId"] + "&signature=private")
                result, _ = self.run_bridge("download", entry=entry, maxBytes=5_000_000)
                self.assertEqual(result["type"], "result", result)

    def test_gallery_credentials_stay_on_source_through_cdn_media_redirect_and_segments(self):
        for post in ("crossfile", "redirect", "crossmanifest"):
            with self.subTest(post=post):
                result, _ = self.download("gallery?post=" + post)
                self.assertEqual(result["type"], "result", result)
                self.assertEqual(result["result"], [{"filename": "media.mp4", "mimeType": "video/mp4"}])

    def test_selected_gallery_file_reuses_extractor_cookie_and_file_header(self):
        for post in ("fixture", "stream"):
            with self.subTest(post=post):
                result, _ = self.download("gallery?post=" + post)
                self.assertEqual(result["type"], "result", result)
                self.assertEqual(result["result"], [{"filename": "media.mp4", "mimeType": "video/mp4"}])

    def test_gallery_download_refreshes_url_and_rejects_unmatched_identity(self):
        response, _ = self.run_bridge("inspect", url=FIXTURE + "/gallery?post=fixture")
        self.assertEqual(response["type"], "result", response)
        (entry,) = response["result"]["entries"]
        # The old direct link points at different bytes. Re-extraction must use the fresh selected media.
        entry["mediaUrl"] = FIXTURE + "/silent.mp4"
        result, folder = self.run_bridge("download", entry=entry, maxBytes=5_000_000)
        self.assertEqual(result["type"], "result", result)
        self.assertEqual((folder / "media.mp4").read_bytes(), (self.directory / "fixtures" / "video.mp4").read_bytes())

        for change in ({"attachmentId": "different"}, {"provider": "different"}):
            with self.subTest(change=change):
                result, folder = self.run_bridge("download", entry={**entry, **change}, maxBytes=5_000_000)
                self.assertEqual(result["code"], "no_media", result)
                self.assertFalse(list(folder.glob("media.*")))

    def test_combined_selection_rejects_video_with_no_audio_packets(self):
        result, folder = self.download("player.php?clip=silent")
        self.assertEqual(result, {"type": "error", "code": "incomplete", "retryAfter": None})
        self.assertFalse(list(folder.glob("media.*")))

    def test_assembles_aes128_and_discontinuous_byte_ranges(self):
        for resource in ("encrypted.m3u8", "range.m3u8"):
            with self.subTest(resource=resource):
                response, folder = self.download(resource, direct=True)
                self.assertEqual(response["type"], "result", response)
                media = subprocess.check_output([
                    "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                    str(folder / "media.mp4"),
                ], text=True)
                self.assertGreaterEqual(float(media), 1.9)

    def test_rejects_missing_fragment_unfinished_stream_and_local_url(self):
        for resource in ("broken.m3u8", "live.m3u8", "local.m3u8"):
            with self.subTest(resource=resource):
                response, folder = self.download(resource, direct=True)
                self.assertEqual(response["type"], "error", response)
                self.assertFalse(list(folder.glob("media.*")))


if __name__ == "__main__":
    unittest.main()
