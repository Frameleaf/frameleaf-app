# Media downloads in Boards

Library can save media from a page URL and check a creator's feed for new posts. Downloads run on Library and continue after you close the browser. The original post, creator, publication time, capture time and post text remain available in the saved item's source details.

## Download a post

Choose **Download media** from Boards' Add menu, enter one or more URLs, and inspect them. Select the attachments, destination collection and tags before starting. A post with several attachments creates separate items. A playlist or account opens a preview so you can choose what to save.

Ordinary downloads preserve the best available original format. Segmented HLS/DASH streams, MPEG-TS and separate tracks are assembled into an MP4, keeping the original codecs where MP4 supports them. Separate videos stay separate items. Active livestreams and DRM-protected playback are unsupported.

Progress remains available after closing the download sheet. You can cancel unfinished work, retry failed items, and open saved results. Expired source links may require inspecting the page again.

## Creator subscriptions

Choose a creator URL and inspect it before subscribing. Select **All accessible history**, **Since a date**, or **New posts only**. Library creates a private Boards collection named `Creator · Site`; an optional parent must also be private. The collection uses normal Library storage and sharing permissions.

Checks run hourly by default. You can choose 15 minutes, hourly, every six hours, or daily, and use Check now, Pause, Resume, Change connection, or Unsubscribe. Unsubscribing retains the collection and its saved media.

Library includes creator-authored media posts and replies where the extractor supports them. Likes, unrelated reposts, comments and text-only posts are excluded by default. YouTube checks include completed uploads, Shorts and archived livestreams. An active stream waits for a downloadable recording.

Backfill resumes in batches. A login error, rate limit, truncated list or uncertain empty response does not mean that all history was saved. Discovery and saved counts are separate. Overlapping checks and weekly reconciliation look for delayed or newly accessible media without replacing your edited titles, notes, tags or collection names.

Removing an item from a subscription collection prevents that subscription from adding it again. Trashing or deleting saved media prevents automatic re-import for the same Library owner and source. Explicit manual re-import can override that removal decision.

## Connected sites

Connect only the site you want Library to access. Save to Frameleaf requests cookie access and the selected host permissions when you choose to connect. Library retains that site's access for scheduled downloads; sharing a collection never shares the connection. Some providers need supported credentials or tokens instead of browser cookies, such as a Bluesky app password or Reddit OAuth credentials.

Refresh access when a session expires. Disconnect removes the retained credentials and stops dependent work. Signing out of the browser extension leaves already accepted Library downloads and subscriptions running. Account disablement, subscription pause and destination permission changes are still enforced.

Site access is transferred over HTTPS. A Library address using a generated self-signed certificate can be used after Chrome trusts that certificate. **Open Library to trust its certificate**, then retry the extension request. If the browser exception does not apply to extension requests, import and trust the certificate for that Library address using Chrome's certificate manager or your operating system's trust settings, then retry. Saving a preference does not disable certificate verification.

Partitioned cookies are not converted into unrestricted cookies. If a connection depends on them, use a supported provider authorization method. The extension does not copy your browser profile or put site credentials in its persistent capture queue.

## Coverage

Individual media uses the installed yt-dlp extractors, including generic extraction, and gallery-dl for image and gallery coverage. Creator-feed support is checked separately for the supplied URL. There is no fixed list restricting individual URLs to four providers.

The bundled versions for capability format 1 are yt-dlp **2026.10.26**, gallery-dl **1.32.19**, yt-dlp-ejs **0.8.0**, and curl-cffi **0.17.0**. The Library API reports the installed engine versions and whether its isolated runtime is available.

| Provider                   | Individual media path               | Creator feed path                              | Live account qualification |
| -------------------------- | ----------------------------------- | ---------------------------------------------- | -------------------------- |
| YouTube                    | yt-dlp                              | Videos, Shorts and archived streams            | Pending                    |
| X                          | gallery-dl, yt-dlp where applicable | Authored posts and replies                     | Pending                    |
| Reddit                     | gallery-dl, yt-dlp where applicable | Creator submissions                            | Pending                    |
| Bluesky                    | gallery-dl                          | Authored posts and replies                     | Pending                    |
| Other supported extractors | Per-URL inspection                  | Offered when an identifiable feed is available | Provider dependent         |

Extractor catalogue presence is not a successful live account test. Sites change, accounts have different access, and providers can cap history. Consult the upstream [yt-dlp supported-site guidance](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) and [gallery-dl capabilities](https://gdl-org.github.io/docs/supportedsites.html); Library's actual inspection and error state determine what can be saved now.

## Operating Library

The image supplies the pinned Python runtime, Node EJS support and FFmpeg. Extraction requires Linux seccomp enforcement and uses a per-job Unix-socket broker that permits checked public network addresses. Redirects, manifests, media fragments and keys use the same boundary. Unsupported enforcement makes extraction unavailable; it never enables direct-network fallback. This network boundary is not a complete filesystem sandbox.

Keep the Library database and its private `.frameleaf-media/session.key` together when backing up or restoring connections. The key directory must belong to the Library process user with mode `0700`, and the key must have mode `0600`. Keep this key outside media exports. Custom-UID installations must retain matching ownership. Losing the key requires reconnecting sites; changing the key does not decrypt existing connections.

Library allows two concurrent downloads and serializes work for each provider/session. Its existing queue admission and storage limits also apply. Rate limits use bounded retry/backoff; authentication, unavailable destinations and quota problems require attention.

Metrics include queue age, retained download bytes, failures by extractor, expired connections, retries and subscription lag. They exclude cookies and source URLs. When reporting an error, include the Library version, extractor versions and the displayed error; do not attach cookies, signed media URLs or credential files.

Extractor updates ship in reviewed Library builds. Update both requirement pins and hashes, retain third-party notices, run the generated media/network fixtures on both image architectures, and repeat public and authorized-account qualification. Record limited histories and unsupported authentication separately from individual-post results.
