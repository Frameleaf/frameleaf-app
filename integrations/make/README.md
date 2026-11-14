# Frameleaf Connect for Make

Source for a private Make custom app that uses Frameleaf Connect protocol 1 ([docs/developer/connect-api.md](../../docs/developer/connect-api.md)). It is independently written, MIT-licensed, imports no Library code or SDK, and needs no custom IML JavaScript functions. Nothing here is published; publication, the Make developer account and Make's app review are separate steps (see [APP-REVIEW.md](APP-REVIEW.md)).

## Components

Create the app in Make's app editor, then paste each file into the matching tab.

| Component | Tab | Source |
| --- | --- | --- |
| Base | Base | `base/base.json` |
| Connection (OAuth 2.0) | Communication / Parameters / Default scope / Scope list | `connection/communication.json`, `connection/parameters.json`, `connection/scope.json`, `connection/scopes.json` |
| Common data | Common | `{}` (no shared secret) |
| RPC `albums` | Communication / Parameters | `rpcs/albums/` |
| Each module | Communication / Mappable or static parameters / Interface / Scope | `modules/<id>/communication.json`, `parameters.json`, `interface.json`, and `scope` from `module.json` |
| Groups | Groups | `groups.json` |

`module.json` holds each module's label, description, type and its single minimum scope.

| Module | Type | Scope | Connect route |
| --- | --- | --- | --- |
| Watch events | trigger | `events:read` | `GET events/latest` |
| Search photos and videos | search | `library:read` | `GET assets` |
| Get a photo or video | action | `library:read` | `GET assets/:id` |
| Download a photo | action | `library:read` | `GET assets/:id/rendition` (thumbnail, preview, display) |
| Upload a photo or video | action | `photos:upload` | `POST uploads`, `PATCH uploads/:id`, `POST uploads/:id/commit` |
| Add tags | action | `tags:write` | `POST assets/:id/tags` |
| List albums | search | `library:read` | `GET albums` |
| Create an album | action | `albums:write` | `POST albums` |
| Add photos to an album | action | `albums:write` | `POST albums/:id/assets` |
| Make a Connect API call | universal | `library:read` | any path under `/api/connect` |

## Connection

The callback is exactly `https://www.make.com/oauth/cb/app` (`oauth.makeRedirectUri`). A Frameleaf administrator registers it on each server and gives the person its public client ID. The server URL is a canonical HTTPS origin that Make can reach; a private LAN address alone is not enough. A direct customer HTTPS connection needs no Frameleaf Cloud plan; relay follows the existing Cloud entitlements.

Authorization uses PKCE S256 and the Connect `resource`. The connection starts with `library:read`; Make asks the person to extend the grant when they add a module that needs another scope, and the Library's consent page decides which albums each grant covers. Originals, Boards uploads, people, sharing and deletion are not offered.

Refresh tokens rotate on every use. `token` and `refresh` store both new tokens together; a spent refresh token cannot be retried. Deleting the Make connection calls `invalidate`, which revokes the grant. Revoking in Frameleaf **Connected apps** remains the reliable control.

The verifier joins three `uuid` values (108 characters) to satisfy RFC 7636's 43–128 range. Make's documentation does not state that `uuid` is cryptographically random; native qualification must confirm it.

## Behaviour

- **Paths.** Every module URL is relative to `{{connection.serverUrl}}/api/connect`. IDs placed in a path must match a lowercase UUID and are URL-encoded. The universal module accepts only `/segment/segment` paths made of letters, digits, `_` and `-`, a query string built from `key`/`value` pairs, `GET`/`POST`/`DELETE`, and no custom headers, so it cannot reach other Library APIs, traverse paths or replace the bearer token.
- **Source ID.** Create an album and Upload require a Source ID, sent as the Connect `requestId`. Retrying with the same Source ID returns the same album or receipt. Upload's date taken is a required mapped value so a retry sends an identical request.
- **Files.** Download returns a Make file (`fileName`, `data`). Upload takes a mapped file (`.jpg`, `.jpeg`, `.png` or `.mp4`) and appends it in one request, so a file must fit within the Library's `maxAppendBytes`. An upload whose earlier attempt stopped part-way cannot resume in Make; use a new Source ID. After an interrupted run, Make skips the append when the Library already has the bytes and commits.
- **Watch events.** The trigger reads the newest-first `events/latest` window (at most 1000 events), follows `nextCursor` while `hasMore`, and uses `deliveryId` and `occurredAt` as Make's persisted trigger position, so each event fires once.
- **Pagination.** Search requests 100 per page and stops at `total` or the module limit.
- **Errors.** 401 → `InvalidAccessTokenError` (reconnect), 403 → `InvalidConfigurationError`, 404 and 410 → `DataError`, 409 and 429 → `RateLimitError` so Make's retry repeats the same Source ID, anything else → `RuntimeError`. Messages never include tokens.
- **Logs.** Base, token and refresh steps sanitize authorization headers, request bodies, search text, ticket URLs and filenames in response headers.
- **Text.** Make custom apps have one language. Module text is English. Connection text is supplied in eleven languages through `locales.json` and `render.mjs` (for example `node integrations/make/render.mjs fr parameters`).

## Tests

```sh
node --test integrations/make/test/*.test.mjs
```

`test/iml.mjs` executes the shipped JSON with a small IML subset and Make's documented runtime parameter validation; `test/library.mjs` is a synthetic Library with strict OAuth (PKCE, rotation, reuse revocation) and the Connect routes the modules use. `scenarios/` holds one test scenario per module. The suite also covers pagination, the event cursor across runs, error mapping, 409 retries, concurrent duplicate uploads, refresh rotation, stale-token revocation, disconnect, and the path restrictions.

This is not Make's engine. A native Make round trip is still required: see [APP-REVIEW.md](APP-REVIEW.md).
