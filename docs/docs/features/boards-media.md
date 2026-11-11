# Creators in Boards

Boards has two areas: **Items**, your collections, and **Creators**, where Library saves media from the web. Follow a channel or account and Library keeps its own copy of what they post. Downloads run on Library and continue after you close the browser.

## Add from the web

Open **Creators** and paste an address into the box. Library reads the address and chooses for you:

- **A whole channel, account, profile or page is followed.** Choose what to save, the video quality, how far back to go and how often to look for new posts. How far back is always asked; nothing is chosen for you. You can change all of it later on the creator's page.
- **One video or post is downloaded.** It comes with its title, description, tags and posting date. Its creator is added under Creators so the item has a home, but you are not following them unless you turn on **Follow them too**.
- **Any other page** lists the media Library found on it, for you to choose from.

Ordinary downloads keep the best available original format unless you pick a lower quality. Segmented HLS/DASH streams, MPEG-TS and separate tracks are assembled into an MP4, keeping the original codecs where MP4 supports them. Active livestreams and DRM-protected playback are unsupported.

## A creator's page

Each creator has a page laid out for their platform: YouTube has Videos, Shorts, Live and Playlists; X has Posts, Media and Videos; Pinterest has Boards and All pins; Facebook has Posts, Photos, Videos and Reels. Other sites get a general layout.

Filter by videos or pictures and by **Not watched yet**, sort, and search within the creator. Open an item to see its details: the title, description, tags and posting date from the post, who posted it, and whether it came from your subscription or a single download. Library remembers what you have watched and where you stopped.

For a creator you follow, **Check now**, **Pause** and **Subscription** are on the page. Unfollowing keeps everything already saved. Removing or deleting an item means it is not downloaded again.

Creators can be put in folders. A folder is a private Boards collection. A creator's collection starts private; sharing it later never shares your connection to the site.

Checks run hourly by default; you can choose 15 minutes, hourly, every six hours or daily. A login error, rate limit, truncated list or uncertain empty response does not mean that all history was saved.

## Connected sites

Connect only the site you want Library to access. Save to Frameleaf requests cookie access and the selected host permissions when you choose to connect. Library retains that site's access for scheduled downloads; sharing a collection never shares the connection. Some providers need supported credentials or tokens instead of browser cookies, such as a Bluesky app password or Reddit OAuth credentials.

Refresh access when a session expires. Disconnect removes the retained credentials and stops dependent work. Signing out of the browser extension leaves already accepted Library downloads and subscriptions running. Account disablement, subscription pause and destination permission changes are still enforced.

Site access is transferred over HTTPS. A Library address using a generated self-signed certificate can be used after Chrome trusts that certificate. Choose **Open Library**, accept the certificate in the browser, then choose **Retry** in the extension. If the browser exception does not apply to extension requests, import and trust the certificate for that Library address using Chrome's certificate manager or your operating system's trust settings, then retry. Saving a preference does not disable certificate verification.

Partitioned cookies are not converted into unrestricted cookies. If a connection depends on them, use a supported provider authorization method. The extension does not copy your browser profile or put site credentials in its persistent capture queue.

## Coverage

Individual media uses the installed yt-dlp extractors, including generic extraction, and gallery-dl for image and gallery coverage. Creator-feed support is checked separately for the supplied URL. There is no fixed list restricting individual URLs to these providers.

The bundled versions for capability format 1 are yt-dlp **2026.10.26**, gallery-dl **1.32.19**, yt-dlp-ejs **0.8.0**, and curl-cffi **0.17.0**. The Library API reports the installed engine versions and whether its isolated runtime is available.

| Provider                   | Single items                        | Following a creator                            | Tried on the real site |
| -------------------------- | ----------------------------------- | ---------------------------------------------- | ---------------------- |
| YouTube                    | yt-dlp                              | Videos, Shorts and archived streams            | Not yet                |
| X                          | gallery-dl, yt-dlp where applicable | Authored posts and replies                     | Not yet                |
| Facebook                   | yt-dlp, gallery-dl                  | Where the extractor offers a feed              | Not yet                |
| Pinterest                  | gallery-dl                          | Profiles and boards                            | Not yet                |
| Reddit                     | gallery-dl, yt-dlp where applicable | Creator submissions                            | Not yet                |
| Bluesky                    | gallery-dl                          | Authored posts and replies                     | Not yet                |
| Other supported extractors | Per-URL inspection                  | Offered when an identifiable feed is available | Provider dependent     |

Extractor catalogue presence is not a successful live account test. Sites change, accounts have different access, and providers can cap history. Consult the upstream [yt-dlp supported-site guidance](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) and [gallery-dl capabilities](https://gdl-org.github.io/docs/supportedsites.html); Library's actual inspection and error state determine what can be saved now.

## Operating Library

The image supplies the pinned Python runtime, Node EJS support and FFmpeg. Extraction requires Linux seccomp enforcement and uses a per-job Unix-socket broker that permits checked public network addresses. Redirects, manifests, media fragments and keys use the same boundary. Unsupported enforcement makes extraction unavailable; it never enables direct-network fallback. This network boundary is not a complete filesystem sandbox.

Keep the Library database and its private `.frameleaf-media/session.key` together when backing up or restoring connections. The key directory must belong to the Library process user with mode `0700`, and the key must have mode `0600`. Keep this key outside media exports. Custom-UID installations must retain matching ownership. Losing the key requires reconnecting sites; changing the key does not decrypt existing connections.

Library allows two concurrent downloads and serializes work for each provider/session. Its existing queue admission and storage limits also apply. Rate limits use bounded retry/backoff; authentication, unavailable destinations and quota problems require attention.

Metrics include queue age, retained download bytes, failures by extractor, expired connections, retries and subscription lag. They exclude cookies and source URLs. When reporting an error, include the Library version, extractor versions and the displayed error; do not attach cookies, signed media URLs or credential files.

Extractor updates ship in reviewed Library builds. Update both requirement pins and hashes, retain third-party notices, run the generated media/network fixtures on both image architectures, and repeat public and authorized-account qualification. Record limited histories and unsupported authentication separately from individual-post results.
