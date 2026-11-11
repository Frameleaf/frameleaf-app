"""Synthetic provider extractors for the offline runtime tests."""
from contextlib import contextmanager

from gallery_dl import extractor
from gallery_dl.extractor.common import Extractor
from gallery_dl.extractor.message import Message
from yt_dlp.extractor.common import InfoExtractor

import bridge

ROOT = "http://fixture.invalid:8080"
CDN = "http://cdn.fixture.invalid:8080"


@extractor.add
class GalleryFixtureExtractor(Extractor):
    category = "gallery-fixture"
    subcategory = "post"
    pattern = r"http://fixture\.invalid:8080/gallery\?post=([a-z]+)"
    root = ROOT
    useragent = "FrameleafFixture/1.0"

    def items(self):
        self.session.headers.update({"X-API-Key": "fixture-key", "X-Auth-Token": "fixture-token"})
        self.request(self.url)
        post = self.groups[0]
        url = {
            "stream": self.root + "/gated.m3u8",
            "crossfile": CDN + "/cross-file.mp4",
            "redirect": self.root + "/gated-redirect.mp4",
            "crossmanifest": self.root + "/gated-cross.m3u8",
        }.get(post, self.root + "/gated.mp4")
        yield Message.Url, url, {
            "post_id": post,
            "media_id": "protected-video",
            "extension": "mp4",
            "_http_headers": {"X-Fixture-Attachment": "protected"},
        }


class QueryFixtureIE(InfoExtractor):
    _VALID_URL = r"http://fixture\.invalid:8080/player\.php\?clip=(?P<id>[a-z]+)"

    def _real_extract(self, url):
        identity = self._match_id(url)
        return {
            "id": identity,
            "title": "Synthetic query-identified clip",
            "webpage_url": ROOT + "/player.php",
            "formats": [{
                "url": ROOT + ("/silent.mp4" if identity == "silent" else "/video.mp4"),
                "ext": "mp4", "vcodec": "h264", "acodec": "aac",
            }],
        }


class QueryCollectionIE(InfoExtractor):
    _VALID_URL = r"http://fixture\.invalid:8080/fixture-collection/(?P<id>[a-z]+)$"

    def _real_extract(self, url):
        flat_url = ROOT + "/player.php?clip=flat&signature=private"
        resolved_url = ROOT + "/player.php?clip=resolved&signature=private"
        extractor = QueryFixtureIE(self._downloader)
        resolved = extractor._real_extract(resolved_url)
        resolved.update({
            "original_url": resolved_url,
            "extractor": extractor.IE_NAME,
            "extractor_key": extractor.ie_key(),
        })
        return self.playlist_result([
            self.url_result(flat_url, extractor.ie_key(), "flat", webpage_url=ROOT + "/player.php"),
            resolved,
        ], self._match_id(url))


class FixtureExtraction(bridge.Extraction):
    @contextmanager
    def youtube(self, *args, **kwargs):
        with super().youtube(*args, **kwargs) as ydl:
            for provider in (QueryFixtureIE, QueryCollectionIE):
                fixture = provider(ydl)
                ydl.add_info_extractor(fixture)
                ydl._ies = {fixture.ie_key(): fixture, **ydl._ies}
            yield ydl


if __name__ == "__main__":
    bridge.Extraction = FixtureExtraction
    raise SystemExit(bridge.main())
