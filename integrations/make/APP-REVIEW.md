# Make private app review materials

Use this when submitting the private Frameleaf app for Make's review. Nothing here publishes the app.

## App listing

- **Name:** Frameleaf
- **Summary:** Automate the photos and videos in your own Frameleaf Library: react to new photos and album additions, search, download display copies, upload photos and videos, add tags and organise albums.
- **Access model:** each person connects their own self-hosted Library over HTTPS with OAuth 2.0 (PKCE, rotating refresh tokens). The Library's consent page lets them choose the albums the connection can read and add to. Revocation is in the Library under Settings → Connected apps.
- **Data handling:** the app sends requests only to the server URL the person enters, under `/api/connect`. Make receives only what a module returns. No location, people, owner details, storage paths or original filenames are returned.

## Scopes

| Scope | Why | Modules |
| --- | --- | --- |
| `library:read` | Read chosen albums and their photos | Search, Get, Download, List albums, API call |
| `events:read` | New photos, album additions, Studio exports | Watch events |
| `albums:write` | Create albums; add readable photos to writable albums | Create an album, Add photos to an album |
| `tags:write` | Tag photos in writable albums | Add tags |
| `photos:upload` | Upload JPEG, PNG or MP4 into writable albums | Upload a photo or video |

## Reviewer test setup

1. A Frameleaf administrator registers a public app with return address `https://www.make.com/oauth/cb/app` and shares its client ID.
2. In Make, create a Frameleaf connection with the Library's HTTPS origin and that client ID. Sign in, choose one album to read and one to add to.
3. Run one scenario per module, matching `scenarios/<module>.json`: watch events after adding a photo to the album, search with a limit above 100, get and download a photo, upload a JPEG with a Source ID and run it again (same receipt), add a tag, create an album twice with the same Source ID (one album), add a photo to the writable album, and call `GET /albums` through the API call module.

## Native qualification (before submission)

Run against an owner-authorised test Library reachable over public HTTPS, with synthetic media only:

- Full OAuth round trip, including that `uuid` gives independent random values and the 108-character verifier is accepted.
- Refresh while two scenarios share one expiring connection, then another rotation afterwards. A replayed refresh token revokes the grant, so Make must serialise refresh per connection; if it does not, document the limit or move refresh into a Frameleaf-run broker.
- Revocation from Connected apps and from deleting the Make connection; narrowed album access mid-scenario.
- `sha256` and `length` on a mapped file buffer; binary PATCH upload; binary download file name; `rpc://albums?writable=true`; RPC `iterate.condition`.
- Operators `=`, `&&` and `||` in conditions; pagination with `body.page + 1`; trigger dedupe by `deliveryId`/`occurredAt`.
- Make execution logs show no tokens, codes, verifiers, ticket URLs or request bodies.
- Direct customer HTTPS and Frameleaf relay.

Evidence, credentials and test media stay outside this repository.

## Owner and Make steps

- A Make developer account (organisation) to own the app.
- Owner approval to request Make's app review and any publication.
- Any vendor enablement Make requires for private apps.
