import ssl
import unittest
from datetime import datetime, timezone
from http.cookiejar import CookieJar
from urllib.request import Request
from unittest.mock import patch

import requests
from gallery_dl.extractor.nozomi import NozomiExtractor

from bridge import BridgeError, Extraction, creator_feed, creator_profile, gallery_entry, inspection, list_entries, public_page, youtube_candidates
from transport import cookie_policy, gallery_session_factory, load_session_cookies


class BridgeTests(unittest.TestCase):
    def test_attachment_identity_excludes_signed_media_url(self):
        metadata = {
            "tweet_id": 123,
            "media_id": 456,
            "extension": "jpg",
            "author": {"id": 789, "name": "Fixture", "nick": "fixture"},
        }
        first = gallery_entry("twitter", "https://x.com/fixture", "https://pbs.twimg.com/media/a?sig=first", metadata)
        second = gallery_entry("twitter", "https://x.com/fixture", "https://pbs.twimg.com/media/a?sig=second", metadata)
        self.assertEqual(first["provider"], "twitter")
        self.assertEqual(first["creatorId"], "789")
        self.assertEqual(first["postId"], "123")
        self.assertEqual(first["attachmentId"], "456")
        self.assertEqual(first["kind"], "image")
        self.assertEqual(first["pageUrl"], "https://x.com/i/web/status/123")
        self.assertEqual(first["attachmentId"], second["attachmentId"])
        self.assertNotEqual(first["mediaUrl"], second["mediaUrl"])

    def test_checkpoint_survives_feed_insertions_and_missing_marker_is_incomplete(self):
        def entries(ids):
            for post_id in ids:
                yield {"provider": "test", "postId": post_id, "attachmentId": "one", "publishedAt": None}

        first = list_entries(entries(["a", "b", "c"]), 2, None, None)
        self.assertEqual([item["postId"] for item in first[0]], ["a", "b"])
        self.assertEqual(first[2], "limit")
        second = list_entries(entries(["new", "a", "b", "c"]), 2, first[1], None)
        self.assertEqual([item["postId"] for item in second[0]], ["c"])
        self.assertIsNone(second[2])
        self.assertEqual(list_entries(entries(["new", "c"]), 2, first[1], None)[2], "checkpoint_missing")

    def test_saves_filter_before_the_page_limit_and_keep_unknown_kinds(self):
        def entries():
            for index, (kind, section) in enumerate([
                ("video", "short"), ("video", "video"), ("video", "live"), ("image", "pin"),
                ("video", "reel"), ("audio", None), ("video", None), ("video", "video"),
            ]):
                yield {"provider": "test", "postId": str(index), "attachmentId": "one", "publishedAt": None,
                       "kind": kind, **({"section": section} if section else {})}

        def kept(saves, limit=100):
            extraction = Extraction({"socketPath": "/tmp/fixture-socket", "token": "fixture-token", "saves": saves})
            return [entry["postId"] for entry in list_entries(entries(), limit, None, None, keep=extraction.keeps)[0]]

        self.assertEqual(kept({}), ["0", "1", "2", "3", "4", "5", "6", "7"])
        self.assertEqual(kept({"shorts": False, "live": False, "reels": False}), ["1", "3", "5", "6", "7"])
        self.assertEqual(kept({"videos": False, "shorts": True}), ["0", "2", "3", "4", "5"])
        self.assertEqual(kept({"pins": False}), ["0", "1", "2", "4", "5", "6", "7"])
        self.assertEqual(kept({"shorts": False}, limit=2), ["1", "2"])

    def test_since_filters_old_entries_without_assuming_feed_sort_order(self):
        def entries():
            for time in ("2026-01-01T00:00:00+00:00", "2026-01-05T00:00:00+00:00"):
                yield {"provider": "test", "postId": time, "attachmentId": "one", "publishedAt": time}

        cutoff = datetime(2026, 1, 3, tzinfo=timezone.utc).isoformat()
        result = list_entries(entries(), 2, None, cutoff)
        self.assertEqual([item["postId"] for item in result[0]], ["2026-01-05T00:00:00+00:00"])

    def test_since_leaves_history_incomplete_for_unknown_dates(self):
        entry = {"provider": "test", "postId": "unknown", "attachmentId": "one", "publishedAt": None}
        entries, checkpoint, limitation = list_entries(iter([entry]), 2, None, "2026-01-01")
        self.assertEqual(entries, [])
        self.assertIsNone(checkpoint)
        self.assertEqual(limitation, "unknown_publish_date")

    def test_exact_date_lookup_resumes_after_a_bounded_page(self):
        def entries():
            for index in range(14):
                yield {"provider": "youtube", "postId": str(index), "attachmentId": "one", "publishedAt": None}

        looked_up = []
        def resolve(entry):
            looked_up.append(entry["postId"])
            return "2026-01-01T00:00:00+00:00" if int(entry["postId"]) < 12 else "2026-01-04T00:00:00+00:00"

        first = list_entries(entries(), 100, None, "2026-01-03", resolve)
        self.assertEqual(first[0], [])
        self.assertIsNotNone(first[1])
        self.assertEqual(first[2], "date_lookup_limit")
        self.assertEqual(len(looked_up), 12)
        final = list_entries(entries(), 100, first[1], "2026-01-03", resolve)
        self.assertEqual([entry["postId"] for entry in final[0]], ["12", "13"])
        self.assertIsNone(final[1])
        self.assertIsNone(final[2])
        self.assertEqual(looked_up[-2:], ["12", "13"])

    def test_cookie_domain_path_secure_and_expiry(self):
        session = {"domains": ["example.org"], "cookies": [
            {"name": "fixture", "value": "value", "domain": "example.org", "path": "/private",
             "secure": True, "httpOnly": True, "hostOnly": True},
            {"name": "expired", "value": "value", "domain": ".example.org", "path": "/",
             "secure": False, "httpOnly": False, "hostOnly": False, "expires": 1},
        ]}
        jar = CookieJar(cookie_policy())
        load_session_cookies(jar, session)
        for url, expected in [
            ("https://example.org/private/file", "fixture=value"),
            ("http://example.org/private/file", None),
            ("https://child.example.org/private/file", None),
            ("https://example.org/private-file", None),
        ]:
            req = Request(url)
            jar.add_cookie_header(req)
            self.assertEqual(req.get_header("Cookie"), expected)

    def test_creator_defaults_include_authored_replies_and_exclude_comment_listings(self):
        self.assertEqual(creator_feed("https://x.com/fixture"), "https://x.com/fixture/timeline")
        self.assertEqual(creator_feed("https://bsky.app/profile/fixture.example"), "https://bsky.app/profile/fixture.example/replies")
        self.assertEqual(creator_feed("https://www.reddit.com/u/fixture/"), "https://www.reddit.com/user/fixture/submitted")
        self.assertEqual(creator_feed("https://x.com/fixture/status/123"), "https://x.com/fixture/status/123")
        self.assertEqual(creator_feed("https://x.com/fixture/likes"), "https://x.com/fixture/likes")

    def test_youtube_channel_flattening_defers_live_and_keeps_archives(self):
        root = "https://www.youtube.com/@fixture"
        def items(tab, values):
            return {"_type": "playlist", "webpage_url": root + tab, "entries": [
                {"_type": "url", "id": identity, "ie_key": "Youtube", "live_status": status,
                 "url": "https://www.youtube.com/watch?feature=share&v=" + identity}
                for identity, status in values
            ]}
        metadata = {"_type": "playlist", "entries": [
            items("/videos", [("video", "not_live")]),
            items("/shorts", [("short", "not_live")]),
            items("/streams", [("archive", "was_live"), ("active", "is_live")]),
        ]}
        entries = list(youtube_candidates(None, metadata, root))
        self.assertEqual([entry["attachmentId"] for entry in entries], ["video", "short", "archive"])
        self.assertEqual([entry["section"] for entry in entries], ["video", "short", "live"])
        self.assertTrue(all("playlistId" not in entry for entry in entries))
        self.assertEqual(entries[0]["pageUrl"], "https://www.youtube.com/watch?v=video")
        self.assertEqual(public_page("https://youtube.com/watch?list=playlist&v=video"), "https://youtube.com/watch?v=video")

    def test_section_comes_from_extractor_fields_only(self):
        def section(**info):
            (entry,) = youtube_candidates(None, {"id": "one", "extractor": "Fixture", **info}, "https://fixture.invalid/one")
            return entry.get("section")

        self.assertEqual(section(webpage_url="https://www.youtube.com/shorts/one"), "short")
        self.assertEqual(section(media_type="short"), "short")
        self.assertEqual(section(webpage_url="https://www.facebook.com/reel/1"), "reel")
        self.assertEqual(section(live_status="was_live"), "live")
        self.assertEqual(section(), "video")
        self.assertIsNone(section(vcodec="none"))
        fields = {"extension": "jpg", "id": 1}
        self.assertEqual(gallery_entry("twitter", "https://x.com/fixture", "https://cdn.fixture.invalid/a.jpg", fields)["section"], "post")
        self.assertEqual(gallery_entry("pinterest", "https://fixture.invalid/pin", "https://cdn.fixture.invalid/a.jpg", fields)["section"], "pin")
        self.assertNotIn("section", gallery_entry("fixture", "https://fixture.invalid/a", "https://cdn.fixture.invalid/a.jpg", fields))

    def test_tags_playlist_and_duration_are_bounded_and_optional(self):
        fields = {
            "extension": "mp4", "id": 1, "duration": 31.4159,
            "hashtags": ["#larch", "larch", "x" * 200, 7, *(f"tag{index}" for index in range(40))],
            "board": {"id": 42, "name": "Mountain rooms"},
        }
        entry = gallery_entry("pinterest", "https://fixture.invalid/pin", "https://cdn.fixture.invalid/a.mp4", fields)
        self.assertEqual(entry["tags"][:3], ["larch", "x" * 64, "tag0"])
        self.assertEqual(len(entry["tags"]), 30)
        self.assertEqual((entry["playlistId"], entry["playlistTitle"], entry["duration"]), ("42", "Mountain rooms", 31.416))
        plain = gallery_entry("fixture", "https://fixture.invalid/a", "https://cdn.fixture.invalid/a.jpg",
                              {"extension": "jpg", "tags": "not a list", "duration": float("inf")})
        self.assertFalse({"tags", "playlistId", "playlistTitle", "duration"} & plain.keys())

    def test_playlist_names_its_items_and_a_channel_does_not(self):
        def items(**playlist):
            return list(youtube_candidates(None, {"_type": "playlist", **playlist, "entries": [
                {"_type": "url", "id": "one", "ie_key": "Youtube", "url": "https://www.youtube.com/watch?v=one",
                 "duration": 12, "playlist_id": "untrusted", "playlist_title": "Untrusted"},
            ]}, "https://www.youtube.com/playlist?list=PLfixture"))

        (listed,) = items(id="PLfixture", title="Joinery", channel_id="UCfixture")
        self.assertEqual((listed["playlistId"], listed["playlistTitle"], listed["duration"]), ("PLfixture", "Joinery", 12.0))
        (uploaded,) = items(id="UCfixture", title="Fixture - Videos", channel_id="UCfixture")
        self.assertNotIn("playlistId", uploaded)

    def test_creator_profile_reports_only_account_fields(self):
        channel = {
            "channel_id": "UCfixture", "channel": "Fixture", "uploader_id": "@fixture", "description": "About the channel",
            "channel_url": "https://www.youtube.com/channel/UCfixture",
            "thumbnails": [{"id": "avatar_uncropped", "url": "https://cdn.fixture.invalid/avatar"},
                           {"id": "banner_uncropped", "url": "https://cdn.fixture.invalid/banner"},
                           {"id": "0", "url": "file:///etc/hosts"}],
        }
        self.assertEqual(creator_profile(channel, "youtube"), {
            "handle": "@fixture", "about": "About the channel", "url": "https://www.youtube.com/channel/UCfixture",
            "avatarUrl": "https://cdn.fixture.invalid/avatar", "bannerUrl": "https://cdn.fixture.invalid/banner",
        })
        # One video's description is not the channel's, and a video has no account pictures.
        self.assertEqual(creator_profile({**channel, "thumbnails": None}, "youtube", feed=False),
                         {"handle": "@fixture", "url": "https://www.youtube.com/channel/UCfixture"})
        author = {"author": {"id": 1, "name": "fixture", "nick": "Fixture", "description": "Offcuts",
                             "profile_image": "https://cdn.fixture.invalid/a.jpg", "profile_banner": "javascript:alert(1)"}}
        self.assertEqual(creator_profile(author, "twitter"),
                         {"handle": "fixture", "about": "Offcuts", "avatarUrl": "https://cdn.fixture.invalid/a.jpg"})
        self.assertIsNone(creator_profile({}, "fixture"))
        result = inspection("https://fixture.invalid/feed", "twitter", "feed", [], None, None,
                            identity=["1", "Fixture", creator_profile(author, "twitter")])
        self.assertEqual(result["profile"]["handle"], "fixture")
        self.assertIsNone(inspection("https://fixture.invalid/feed", "fixture", "feed", [], None, None)["profile"])

    def test_public_source_keeps_known_provider_identity_only(self):
        self.assertEqual(
            public_page("https://www.pornhub.com/view_video.php?token=secret&viewkey=phfixture"),
            "https://www.pornhub.com/view_video.php?viewkey=phfixture",
        )
        self.assertEqual(
            public_page("https://www.facebook.com/watch/?v=123&token=secret"),
            "https://www.facebook.com/watch/?v=123",
        )
        self.assertEqual(
            public_page("https://fixture.invalid/view_video.php?viewkey=secret"),
            "https://fixture.invalid/view_video.php",
        )

    def test_original_known_identity_survives_queryless_extractor_canonical_url(self):
        canonical = "https://www.pornhub.com/view_video.php"
        original = canonical + "?viewkey=phfixture&token=secret"
        (entry,) = youtube_candidates(None, {"id": "phfixture", "extractor": "PornHub", "webpage_url": canonical}, original)
        self.assertEqual(entry["pageUrl"], canonical + "?viewkey=phfixture")
        self.assertEqual(entry["extractionUrl"], original)

    def test_nested_multi_video_keeps_its_parent_locator_for_each_attachment(self):
        playlist = "https://fixture.invalid/collection"
        parent = "https://fixture.invalid/player.php?bundle=fixture"
        metadata = {"_type": "playlist", "entries": [{
            "_type": "multi_video",
            "id": "bundle",
            "original_url": parent,
            "entries": [
                {"_type": "url", "id": "first", "ie_key": "Fixture", "url": parent + "&clip=first"},
                {"_type": "url", "id": "second", "ie_key": "Fixture", "url": parent + "&clip=second"},
            ],
        }]}
        entries = list(youtube_candidates(None, metadata, playlist))
        self.assertEqual([(entry["postId"], entry["attachmentId"]) for entry in entries],
                         [("bundle", "first"), ("bundle", "second")])
        self.assertEqual([entry["extractionUrl"] for entry in entries], [parent, parent])

    def test_unknown_feed_does_not_borrow_the_first_post_author(self):
        entry = {"creatorId": "post-author", "creator": "Post author"}
        result = inspection("https://fixture.invalid/search?query=token", "fixture", "feed", [entry], None, None)
        self.assertIsNone(result["creatorId"])
        self.assertEqual(result["canonicalUrl"], "https://fixture.invalid/search")

    def test_two_origin_gallery_metadata_retains_browser_origin_without_credentials(self):
        session_type = gallery_session_factory("/tmp/fixture-socket", "fixture-token", {})
        with session_type() as session, patch.object(requests.Session, "send") as outgoing:
            session.headers.update({
                "Origin": NozomiExtractor.root,
                "X-API-Key": "fixture-key",
                "X-Auth-Token": "fixture-token",
            })
            session.get("https://n.nozomi.la/index.nozomi")
            session.get(f"https://j.{NozomiExtractor.domain}/fixture.json")
            source, metadata = [call.args[0].headers for call in outgoing.call_args_list]
            self.assertEqual(source["X-API-Key"], "fixture-key")
            self.assertEqual(source["X-Auth-Token"], "fixture-token")
            self.assertEqual(metadata["Origin"], NozomiExtractor.root)
            self.assertNotIn("X-API-Key", metadata)
            self.assertNotIn("X-Auth-Token", metadata)

    def test_cross_origin_delivery_and_redirect_retain_only_valid_origin(self):
        source = "https://fixture.invalid/post"
        destination = "https://cdn.fixture.invalid/file"
        session_type = gallery_session_factory("/tmp/fixture-socket", "fixture-token", {})
        cases = [
            ("https://fixture.invalid", True),
            ("http://[2001:db8::1]:8080", True),
            ("https://fixture.invalid/", False),
            ("https://fixture.invalid?secret", False),
            ("https://fixture.invalid?", False),
            ("https://fixture.invalid#secret", False),
            ("https://name:secret@fixture.invalid", False),
            ("https://fixture.invalid:65536", False),
            ("https://fixture.invalid:1\n", False),
            ("https://fixture.invalid https://other.invalid", False),
            ("null", False),
        ]
        with session_type() as session, patch.object(requests.Session, "send") as outgoing:
            response = requests.Response()
            response.request = session.prepare_request(requests.Request("GET", source))
            for value, valid in cases:
                with self.subTest(value=value):
                    expected = value if valid else None
                    redirected = session.prepare_request(requests.Request("GET", destination))
                    redirected.headers["Origin"] = value
                    redirected.headers["X-Auth-Token"] = "fixture-token"
                    session.rebuild_auth(redirected, response)
                    self.assertEqual(redirected.headers.get("Origin"), expected)
                    self.assertNotIn("X-Auth-Token", redirected.headers)

                    delivery = session.prepare_request(requests.Request("GET", destination))
                    delivery.headers["X-Auth-Token"] = "fixture-token"
                    with session.file_headers(source, destination, {"Origin": value}):
                        session.send(delivery)
                    delivered = outgoing.call_args.args[0].headers
                    self.assertEqual(delivered.get("Origin"), expected)
                    self.assertNotIn("X-Auth-Token", delivered)

    def test_mounted_gallery_tls_context_survives_unix_pool_routing(self):
        from gallery_dl.extractor.common import RequestsAdapter

        context = ssl.create_default_context()
        context.set_ciphers("ECDHE-RSA-AES128-GCM-SHA256")
        adapter = RequestsAdapter(context)
        with gallery_session_factory("/tmp/fixture-socket", "fixture-token", {})() as session:
            session.mount("https://", adapter)
            chosen = session.get_adapter("https://fixture.invalid/")
            pool = chosen.poolmanager.connection_from_url("https://fixture.invalid/")
            self.assertIs(chosen, adapter)
            self.assertIs(pool.conn_kw["ssl_context"], context)
            self.assertEqual(pool.ConnectionCls._new_conn.__qualname__.split(".")[-2], "UnixConnection")

    def test_partitioned_cookie_is_rejected(self):
        with self.assertRaises(BridgeError) as error:
            load_session_cookies(CookieJar(), {"domains": ["example.org"], "cookies": [{
                "name": "fixture", "value": "value", "domain": "example.org", "path": "/",
                "secure": True, "httpOnly": True, "hostOnly": True, "partitionKey": {"topLevelSite": "https://example.org"},
            }]})
        self.assertEqual(error.exception.code, "unsupported_session")


if __name__ == "__main__":
    unittest.main()
