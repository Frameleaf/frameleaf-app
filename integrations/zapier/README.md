# Frameleaf Connect for Zapier

A private-beta Zapier CLI app for Frameleaf Connect protocol 1 ([`docs/developer/connect-api.md`](../../docs/developer/connect-api.md)). It is independently written and MIT-licensed, imports no Library code or generated SDK, and is not published. Setup help for people using it is in [`help/`](help/en.md) in all eleven Frameleaf languages.

| Kind     | Key                       | Connect call                                                        |
| -------- | ------------------------- | ------------------------------------------------------------------- |
| Trigger  | `asset_ready`             | `GET events/latest?type=asset.ready`                                |
| Trigger  | `album_asset_added`       | `GET events/latest?type=album.asset.added[&albumId]`                |
| Trigger  | `studio_export_completed` | `GET events/latest?type=studio.export.completed`                    |
| Search   | `find_asset`              | `GET assets/:id` or `GET assets?q&albumId&type`                     |
| Search   | `find_album`              | `GET albums`, exact name (also find-or-create with `create_album`)  |
| Create   | `create_album`            | `POST albums`                                                       |
| Create   | `add_to_album`            | `POST albums/:id/assets`                                            |
| Create   | `add_tags`                | `POST assets/:id/tags`                                              |
| Create   | `upload_file`             | `POST uploads`, `PATCH uploads/:id`, `POST uploads/:id/commit`      |
| Hydrator | `rendition`               | `GET assets/:id/rendition?variant` when a later step uses a file    |

Two hidden triggers (`album_list`, `writable_album_list`) feed album dropdowns.

## Connection

Native OAuth 2.0 with Zapier PKCE (`enablePkce: true`) and Zapier's credential storage. The only inputs are `serverUrl` (canonical public HTTPS origin) and `frameleafClientId` (the non-secret public client ID an administrator issues after registering the app's exact Zapier callback in Connect setup). No client secret, API key or dynamic registration is used. Requested scopes: `library:read library:download albums:write tags:write photos:upload boards:upload events:read`; a token with any other set is refused.

The stored credential pins the Connect resource and client ID. Every request re-checks that binding before sending the token, uses a fixed path, a deadline, a response bound and no redirects. Refresh tokens rotate on every refresh; both tokens are replaced together, and a malformed, broadened or unchanged refresh result is refused. The adapter never retries a token request or keeps its own token store. A 401 hands refresh to Zapier (`RefreshAuthError`).

Zapier must reach the Library over public HTTPS. Customer-managed HTTPS needs no Frameleaf Cloud plan; Frameleaf relay follows the existing Cloud entitlements. LAN-only Libraries cannot be used from Zapier's hosted service.

## Behaviour

- **Bounded polling.** Each poll reads `events/latest` for the newest 1,000 matching events across at most ten pages of 100, newest first, with the delivery ID as Zapier's deduplication `id`. A burst of more than 1,000 events between polls omits the oldest; this is not lossless sync. Test data uses `events/sample`, which never moves a checkpoint.
- **Stable Source IDs.** `create_album` and `upload_file` require a Source ID. The Connect request ID is `zapier-<kind>-sha256(kind, album or workspace, Source ID)`, and every start field is deterministic, so Zapier replays, retries and simultaneous runs reach the Library's per-grant receipt instead of creating duplicates. Reusing a Source ID with different details fails as `SourceIdReused`.
- **Deferred files.** Trigger and search records carry a dehydrated `file`. Hydration runs only when a later step uses it, with the connection's current token, so revoked or narrowed access applies at that moment. Renditions must declare a length of at most 100 MiB.
- **Bounded source fetch.** `upload_file` downloads the previous step's file with plain `fetch`, never `z.request`, so no Library credential can be attached. Only public HTTPS hosts, at most three re-validated redirects, a 60-second deadline and a byte ceiling of `min(maxUploadBytes, 100 MiB)` enforced while streaming. The type is sniffed from the bytes and must be accepted for the album's workspace. Uploads resume from the durable offset after a 409.
- **Errors.** Revoked grant (refresh fails → reconnect), narrowed consent (`Forbidden`), expired cursor (`CursorExpired`), missing or unavailable rendition (`NotFound`), oversized file (`TooLarge`) and temporary hierarchy changes (`ThrottledError`, retried by Zapier) stay distinguishable. No error copies response bodies, tokens, transfer URLs or filenames.

Zapier's OAuth schema has no disconnect callback, so removing a Zapier connection does not revoke the Library grant. People revoke it in Frameleaf Connected Apps. Revocation stops later fetches; it cannot erase files already delivered to other Zap steps.

## Translations

Labels, help text and errors are in English plus `fr`, `es`, `de`, `it`, `pt`, `nl`, `pl`, `sv`, `da` and `nb_NO` (`locales.json`). Zapier descriptor text is static, so each language is a separate private-app entry point:

```sh
node render.cjs fr > /path/to/private-copy/index.js
node render.cjs fr --help > help/fr.md
```

`help/<locale>.md` is generated this way; tests fail if it drifts from `locales.json`.

## Local checks

Node.js 22, matching Zapier's runtime:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run validate
```

Tests use the real `zapier-platform-core` tester with synthetic, network-isolated responses (`nock`). They cover PKCE and token binding, rotation result shapes, separate concurrent refreshes, redirect refusal, response bounds, log redaction, the ten-page polling bound and omitted flood events, cursor/filter pairing, sample loading, distinguishable errors, deferred hydration with the current token, credential-free source fetch, chunked and resumed uploads, idempotent replays, Source ID reuse, input bounds and all eleven catalogues.

`zapier-platform validate` reports no errors or publishing tasks. Its remaining warnings are for help links (public setup docs are not published yet), manual domain validation (implemented and tested here) and ID fields without dropdowns (asset IDs and Source IDs come from earlier steps).

What remains for release is in [`REVIEW.md`](REVIEW.md).
