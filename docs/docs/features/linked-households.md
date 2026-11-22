# Linked Households

Two families on separate Frameleaf servers can link their servers once and then share spaces with each other's people. Each person who accepts a space gets their own copies on their own server, so nothing disappears when the other household deletes a photo, removes it from the space or ends the link.

:::note
This page is the design the Linked Households work follows (FL-755). The first half describes the feature as people meet it; the second half is the protocol, the data model and the threat model for developers. Parts are still being built: each section names the issue that builds it.
:::

## What it does

- An administrator links this server with another household's server: one side creates an invitation, the other accepts it. Both servers need a Server licence and a link to Frameleaf Cloud.
- A space owner adds people from the linked household to a space, by name. Nobody on either side sees an email address from the other household.
- Each invited person accepts on their own server and gets a space of their own, filled with their own copies of the photos, videos and people in it.
- A copy follows the original (description, date, location, rating, people) until its owner edits that detail. From then on that detail is theirs.
- Comments and likes travel in both directions, so the space reads as one conversation.

## What never happens

- **Nothing is deleted across households.** Deleting a photo, removing it from the space, removing a person from the space or ending the link stops the other side's copy from following. The copy itself stays.
- **Locked and hidden items never leave.** An item you locked, or that your Locked rules hide, is left out of everything a linked household can read. Locking an item that was already shared stops the other side's copy from following; it does not take the copy back.
- **Your library is not shared.** A linked household can read only the spaces its people were invited to and accepted. Partner sharing (a whole library) does not work across households.
- **No account is created for the other household's people.** They appear by name and picture on comments and in the member list, and cannot sign in to your server.

## How the two servers reach each other

Linked servers talk to each other directly, never through Frameleaf Cloud. Cloud only introduces them and tells each one the other's addresses.

- On the same home network, the servers use their home addresses.
- Away from each other, a server is reached at its Frameleaf direct address or relay address. Those are listed only while that server's owner has the Frameleaf Cloud plan, exactly as for the phone apps and Buddy Backup (see Remote access). Without the plan a server is reachable on its home network only, and the link says so instead of looking broken.

---

## Developer reference

Everything below reuses the server-to-server trust built for Buddy Backup: the Ed25519 instance identity (`InstanceIdentityRepository`), Cloud-brokered pairing, five-minute Cloud grants bound to the caller's key, a DPoP proof on every request and a signed reply (`server/src/utils/buddy-backup-protocol.ts`, `server/src/services/buddy-backup-peer.service.ts`). Linked Households adds a new grant type, a new peer API beside `buddy/v1`, and tables of its own. It shares no state with Buddy Backup: a household link and a Buddy pairing between the same two servers are independent.

### Terms

| Term     | Meaning                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| Link     | The pairing of two servers. One row in Cloud, one row on each server.                                       |
| Sender   | The server that owns a space and publishes it.                                                              |
| Receiver | The server whose accounts were invited to that space. A link carries shares in both directions.             |
| Share    | One space offered over one link (`household_share`). Its unit of access is the share member.                |
| Member   | One account on the receiver invited to a share (`household_share_member`), identified by its user id there. |
| Grant    | A `household-grant+jwt` signed by Cloud that lets one server call the other for five minutes.               |

### 1. Pairing (FL-928 Cloud, FL-952 server)

Cloud module `apps/api/src/modules/households/`, contracts `packages/contracts/src/households/` (`HOUSEHOLD_VERSION = 1`, every schema a `z.strictObject` carrying `version`, as Buddy's are).

| Cloud endpoint (instance DPoP origin, `InstanceAuthGuard`) | Purpose                                                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `POST /v1/households/invitations`                          | Create an invitation for this server. Returns `invitationId`, a 43-character `token`, `expiresAt` (7 days). |
| `GET /v1/households/invitations/:token`                    | Preview: the inviting server's name, instance id and public key. No account id, no email.                   |
| `POST /v1/households/invitations/accept`                   | Accept for this server. Creates the link `active`. The inviter confirms nothing (same decision as FC-139).  |
| `GET /v1/households/links`                                 | The caller's links with state, peer instance id, peer name and peer key.                                    |
| `POST /v1/households/links/:id/end`                        | End the link. Either side may. Idempotent.                                                                  |
| `POST /v1/households/grants`                               | Issue a grant for one link, with the peer's `connections`.                                                  |
| `POST /v1/households/grants/verify`                        | The destination checks a presented grant is still honoured (link active, both servers still linked).        |
| `GET /v1/households/jwks`                                  | Public keys that sign grants (`Cache-Control: public, max-age=300`).                                        |

Rules Cloud enforces, each with a test in `apps/api`:

- Both servers hold a live Server licence (`liveActivations(...).some((a) => a.kind === 'S')`) at invite, at accept and at every grant. An unlicensed server gets `403`.
- Both servers are linked to Cloud, not suspended and not a suspected clone; the instance key presented is the one registered (`pinned`, as Buddy).
- A server cannot link to itself. Two servers have at most one live link. A server holds at most 10 live links.
- Invitations: single use, 7 days, at most `INVITATIONS_PER_DAY` per account; the token is stored as a SHA-256 hash.
- The two servers may belong to the same Frameleaf account or to different ones. Cloud never tells one account the other's id or email.
- Audit events `household.invited`, `household.accepted`, `household.ended` (`writeAudit`); a read-only staff console view of links (ids, state, dates, no names).

Cloud tables (migration in `apps/api/src/schema/migrations/`):

- `household_link` (`id`, `instance_a_id`, `instance_b_id`, `state` `active|ended`, `created_at`, `ended_at`, `ended_by_instance_id`), unique on the unordered pair while `active`.
- `household_invitation` (`id`, `instance_id`, `account_id`, `token_hash`, `created_at`, `expires_at`, `accepted_at`, `link_id`).

The grant, `typ: household-grant+jwt`, `alg: EdDSA`, lifetime 300 s:

```json
{
  "version": 1,
  "iss": "https://api.frameleaf.cloud",
  "aud": "frameleaf-household",
  "sub": "<source instance id>",
  "jti": "<uuid>",
  "iat": 0,
  "exp": 0,
  "linkId": "<uuid>",
  "sourceInstanceId": "<caller>",
  "destinationInstanceId": "<peer>",
  "cnf": { "jkt": "<thumbprint>", "jwk": { "kty": "OKP", "crv": "Ed25519", "x": "..." } },
  "destinationKey": { "kty": "OKP", "crv": "Ed25519", "x": "..." }
}
```

`HouseholdGrantResponse` is `{ version, token, expiresAt, claims, connections }`. `connections` are the **destination's** addresses from `ConnectionsService.forInstances([destination], now, { homeOnlyWhenBlocked: true })`: home entries always; direct, IPv6, custom and relay entries only while the destination's owner has `REMOTE_ACCESS` active or in grace. A plan that lapses past grace loses those entries at the next grant, five minutes later at most.

Server side (FL-952):

- Table `household_link` (`id`, `cloudLinkId` unique, `peerInstanceId`, `peerName`, `peerPublicKey`, `addresses` jsonb, `state` text, `pausedReason` text null, `connectionPath` text null, `lastSeenAt`, `createdAt`, `endedAt`). `state` is `active`, `paused` or `ended`; it is a text column and the API reports it with separate booleans where a new value might be added later, because new enum values break the native apps' strict decoders.
- `HouseholdLinkService` and admin-only `HouseholdLinkController` at `/admin/household-links`: `POST invitations`, `GET invitations/:token` (preview), `POST invitations/accept`, `GET /`, `POST :id/refresh`, `DELETE :id`.
- `HouseholdPeerService.authorize()` and `HouseholdPeerController` at `household/v1/*`, excluded from the OpenAPI document like `buddy/v1`.
- Table `household_peer_request` (`jti` primary key, `linkId`, `expiresAt`): every admitted proof, kept until its grant expires, so a request cannot be replayed even across a restart or on another API worker.
- A timer on the microservices worker (the Buddy Backup pattern, no queue job): every five minutes it tries each active link's addresses in grant order (home, direct, relay) with `GET handshake` and records `connectionPath` and `lastSeenAt`; every hour it reconciles local rows with `GET /v1/households/links`, so a link ended on the other side ends here.
- Ending a link, from either side or from Cloud, sets `state = ended`, stops every job for it and deletes nothing that was received.

### 2. Transport and request signing (FL-952)

Every peer request carries the Cloud grant and a proof made with the caller's instance key, as Buddy does:

```
Authorization: DPoP <household grant>
DPoP: <proof JWT: htm, htu, iat, jti, ath = SHA-256 of the grant>
```

The destination runs these checks in order and refuses on the first failure. The order matters: nothing expensive runs for a caller that has not named a link this server knows.

1. The path names a link (`household/v1/links/:linkId/...`) whose local row is `active` and whose `peerInstanceId` matches. Otherwise `403` with no detail.
2. Rate limit for that link (below). Over it: `429`.
3. The grant verifies against the Cloud JWKS (cached on disk for Cloud outages, as Buddy), `iss` is this server's Cloud, `aud` is `frameleaf-household`, `exp` is in the future and at most 300 s after `iat`.
4. `linkId`, `destinationInstanceId` and `destinationKey.x` are this link and this server; `sourceInstanceId` and `cnf.jwk.x` are the peer and the key stored for it at pairing. A grant for another link, another server or another key is refused and logged with the link id.
5. The proof verifies against `cnf.jwk`, and its method, URL and grant hash match the request (`verifyBuddyProof`, generalised).
6. `POST /v1/households/grants/verify` at Cloud. A refusal revokes that grant locally until it expires. Only a transport outage (no answer or `5xx`) falls back to the checks above.
7. The proof `jti` is admitted once: it is inserted into `household_peer_request`, and a second request with the same `jti` is refused with `401`. Buddy Backup adds a server nonce because its admission state is a file; here the database row already makes a proof single-use across restarts and workers, so no nonce round trip is needed.

Replies to peer requests are JSON signed with the responder's instance key (`verifyBuddyResponse`), so a relay or proxy in the path cannot alter a manifest. Original files are streamed unsigned and checked by their checksum instead.

TLS is required off the home network; home addresses use the same certificate handling as Buddy. Photo traffic never passes through the Cloud API: it goes direct, or through the relay's data plane for subscribers.

The caller refreshes its grant when fewer than 60 s remain. When Cloud refuses a grant (licence gone, link ended, server unlinked) the caller sets the link `paused` with the reason and retries hourly; a link Cloud reports ended becomes `ended`.

### 3. Peer API (`household/v1/links/:linkId/`)

All routes are `@Authenticated({ public: true })` plus `HouseholdPeerService.authorize()`. JSON bodies use the private content type `application/vnd.frameleaf.household+json`, parsed only after authorisation, capped at 64 KiB unless noted.

| Route                                           | Caller   | Built in | Purpose                                                                                            |
| ----------------------------------------------- | -------- | -------- | -------------------------------------------------------------------------------------------------- |
| `GET handshake`                                 | either   | FL-952   | Protocol version, server name, `maxOriginalBytes`. Proves both keys.                               |
| `GET directory`                                 | sender   | FL-979   | The receiver's accounts that can be invited: `id`, display name, has-avatar. Never emails.         |
| `GET directory/:userId/avatar`                  | either   | FL-979   | A member's profile picture (≤ 1 MiB, image types only).                                            |
| `POST poke`                                     | sender   | FL-979   | "Something changed." No body. The receiver queues a poll. Dropped silently when rate limited.      |
| `GET shares`                                    | receiver | FL-979   | Shares offered over this link: id, space name, description, owner's name, members and their state. |
| `POST shares/:shareId/members/:userId/accept`   | receiver | FL-994   | The member accepted on their own server.                                                           |
| `POST shares/:shareId/members/:userId/leave`    | receiver | FL-994   | The member declined or left. They keep what they received.                                         |
| `GET shares/:shareId/manifest?cursor=`          | receiver | FL-979   | The paged change feed (below).                                                                     |
| `GET shares/:shareId/originals/:assetId?token=` | receiver | FL-979   | The original file. Supports `Range`. Needs the manifest's download token.                          |
| `POST shares/:shareId/comments`                 | receiver | FL-1012  | A receiver's member posts a comment or a like.                                                     |
| `PUT shares/:shareId/comments/:commentId`       | receiver | FL-1012  | Its author edits it.                                                                               |
| `DELETE shares/:shareId/comments/:commentId`    | receiver | FL-1012  | Its author deletes it.                                                                             |

A share route answers `403` unless the share belongs to this link and has at least one **accepted** member, except `GET shares`, the `accept` and `leave` routes, which need an invited member. `403` carries no reason, so a peer cannot tell "no such share" from "not yours".

### 4. The share unit (FL-979)

Sender tables:

- `household_share` (`id`, `albumId` → `album`, `linkId` → `household_link`, `createdAt`), unique (`albumId`, `linkId`). The album has `kind = 'space'`.
- `household_share_member` (`shareId`, `remoteUserId`, `displayName`, `role` text `viewer|contributor`, `invitedAt`, `acceptedAt`, `leftAt`), primary key (`shareId`, `remoteUserId`).
- `household_share_change` (`seq` bigint identity, `shareId`, `kind` text `asset|person|comment|space`, `entityId` uuid, `changedAt`), unique (`shareId`, `kind`, `entityId`). This is the change feed.

Owner API (space owner only, under `/shared-spaces/:id/households`): list links with their directory, invite remote accounts, change a role, remove a member. Removing the last member removes the share. The directory answer is relayed, never cached longer than five minutes, and never stored beyond the invited member's `displayName`.

In version 1 both roles read the space and may comment and like. A remote contributor adding photos back to the sender's space is out of scope; the role is stored and sent so that it can mean more later without a schema change.

**What a share exposes.** Exactly what a local member with the viewer role sees in that space, computed by the same queries (`AlbumRepository` and the FL-446 owner-rule filters in `server/src/utils/hidden-content.ts` and `utils/database.ts`), evaluated as "a member who is not the owner and whose session is locked":

- Included: assets in the space (direct, through linked albums, through linked people) that are not trashed, not archived out of the space view, not Locked, not hidden by the owner's Locked rules; their metadata including GPS; people linked to the space with their face boxes on those assets; comments and likes on the space and its items (FL-1012).
- Never included: Locked or rule-hidden items, trashed items, anything outside the space, other members' email addresses, storage paths, device ids, machine-learning embeddings, sensitive-content flags, Studio projects, the owner's favourites and private albums.

### 5. The manifest (FL-979)

`GET shares/:shareId/manifest?cursor=<seq>&limit=<n>` returns changes with `seq > cursor` in `seq` order. `limit` defaults to 200 and is capped at 200; a page is also cut at 2 MiB.

```json
{
  "version": 1,
  "shareId": "...",
  "entries": [
    { "seq": 41, "kind": "asset", "id": "...", "asset": { "...": "see below" } },
    { "seq": 42, "kind": "asset", "id": "...", "stop": true },
    {
      "seq": 43,
      "kind": "person",
      "id": "...",
      "person": {
        "name": "Nana",
        "faces": [{ "assetId": "...", "x1": 0, "y1": 0, "x2": 0, "y2": 0, "width": 0, "height": 0 }]
      }
    }
  ],
  "nextCursor": "43",
  "complete": true
}
```

- **How the feed is written.** A hook writes or bumps one `household_share_change` row (new `seq`, same key) whenever something in a shared space changes: items added or removed (space events), `recordAssetEdit`, metadata extraction, lock and unlock (`AssetLocked`), trash and restore, a Locked rule changing (a job bumps every item of that owner's shared spaces), a person linked or unlinked, a face added or removed.
- **How the feed is read.** The row holds only ids. The entry is resolved when the page is built: if the item is visible in the space view at that moment the entry carries its current state, otherwise it is `"stop": true`. Visibility is therefore decided at read time by the one query in section 4, and a bug in a hook can delay a change but can never expose an item.
- **Stop is not delete.** `stop` means "stop following this id". The receiver keeps the copy and never trashes it. The entry does not say why (locked, removed, deleted and trashed look the same).
- **Stable and resumable.** Because a changed item moves to a new `seq`, a reader that resumes from any cursor sees every item at least once in its latest state. `complete: true` marks the last page. A first read uses no cursor; when a share is created the sender seeds one row per item.
- **Full reconcile.** Once a week, and whenever the sender answers `410 Gone` to a cursor older than its retention, the receiver reads from the start and stops following every id it holds that the full read no longer lists.

An asset entry: `id`, `type`, `originalFileName` (≤ 255), `checksum` (SHA-1, as stored), `size`, `fileCreatedAt`, `localDateTime`, `timeZone`, `description` (≤ 10 000), `rating`, `latitude`, `longitude`, `city`, `state`, `country`, `width`, `height`, `duration`, `livePhotoVideoId`, `stackId` and `stackPrimary`, `updatedAt`, and `download: { token, expiresAt }`.

**Download token.** A compact Ed25519 signature by the sender's instance key over `{ linkId, shareId, assetId, checksum, exp }`, valid 15 minutes. The original route needs both the normal signed request and this token, and rechecks that the item is still visible in the space before the first byte. An expired token is renewed by reading that entry again.

### 6. Receiving (FL-994)

Receiver tables:

- `household_inbound_share` (`id`, `linkId`, `remoteShareId`, `userId` → `user`, `albumId` → `album` null, `spaceName`, `ownerName`, `state` text `invited|accepted|left`, `cursor`, `lastPulledAt`, `lastError`, `createdAt`), unique (`linkId`, `remoteShareId`, `userId`). One row per invited local account.
- `household_origin` (`localId`, `kind` text `asset|album|person`, `linkId`, `remoteId`, `userId`, `followUntilEdited` bool, `overriddenFields` text[], `remoteUpdatedAt`), primary key (`localId`, `kind`), unique (`linkId`, `remoteId`, `kind`, `userId`).
- `household_received_file` (`linkId`, `checksum`, `path`, `size`, `receivedAt`): originals this server already downloaded and verified from that link, so a second recipient does not download again.

Flow:

1. `HouseholdSharePoll` (every 15 minutes per active link, and on `poke`) reads `GET shares`, inserts `invited` rows for local accounts that exist, are not deleted and are named as members, and raises the normal in-app space invitation. A named user id this server does not have is ignored.
2. The account accepts: a local space (`album`, `kind = 'space'`) is created, owned by them, and the sender is told (`accept`). Declining tells the sender (`leave`).
3. `HouseholdSharePull` (BackgroundTask queue, honours quiet hours, one per inbound share at a time) reads the manifest from the stored cursor and, per entry:
   - **asset, new**: download the original to a temporary file unless `household_received_file` has that checksum for this link; verify size and SHA-1; refuse a file over the cap or with a type the uploader would refuse; then ingest through the normal upload path as an asset owned by the recipient, linked to the stored original by universal storage, and add it to the space. Thumbnails, metadata extraction and machine learning run locally as for any upload.
   - **asset, known and following**: apply each changed field that is not in `overriddenFields`.
   - **asset, `stop`**: set `followUntilEdited = false`. Nothing else.
   - **person**: after local face detection has run on the copies, match the manifest's face boxes to local faces by overlap, then create the recipient's person or merge into their matching person by face similarity (`partner-people.service.ts` rules, with undo in correction history). Only names and boxes cross; embeddings never do.
4. The cursor is saved after each page. An interrupted download resumes with `Range` from the temporary file.
5. When the recipient edits a followed field, the field name is added to `overriddenFields` (the hook partner copies use), and later sender changes to it are ignored.

Rules:

- Each recipient is charged the full size against their quota, as with partner copies. Over quota: the pull pauses with a status the recipient sees; nothing is dropped.
- A recipient who permanently deletes a received copy does not get it back: the origin row stays as a tombstone, as with partner copies.
- An account deleted on the receiver leaves the share (`leave`) before its data is removed.
- Unlinking, the sender removing the member, or the sender deleting the space: the inbound share becomes `left`, every origin row stops following, the local space and every copy stay.
- The same file reaching one recipient through two shares is one asset in their library (one copy per library, as partner sharing).

### 7. Comments and likes (FL-1012)

- Sender → receiver: comment entries in the manifest (`kind: "comment"`): `id`, `assetId` null for the space itself, `isLiked`, `comment` (≤ 4 000), `createdAt`, `updatedAt`, `author: { household: "local|remote", id, name }`, or `stop` when deleted.
- Receiver → sender: `POST/PUT/DELETE shares/:shareId/comments`. The body names the acting member's user id; the sender checks that id is an accepted member of that share and that the comment being edited or deleted was written by the same member.
- Table `household_remote_author` (`id`, `linkId`, `remoteUserId`, `displayName`, `avatarPath`), unique (`linkId`, `remoteUserId`). `activity` gains a nullable `remoteAuthorId`; a remote comment has it set and no local user. No local account is ever created for a remote person.
- A comment's own author may edit or delete it and that does propagate: comments are conversation, not media.
- Mentions carry the mentioned member's id; each server notifies only its own accounts.
- After the link ends or the member leaves, comment sync stops and the history stays on both sides.

### 8. Limits

| Limit                                    | Value                                                            | Where                                 |
| ---------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| Peer requests per link                   | 120 per minute (`RateLimitRepository`, key `household:<linkId>`) | destination                           |
| Failed authorisations per source address | 30 per minute, then `429` before any key work                    | destination                           |
| Concurrent original downloads per link   | 2                                                                | both                                  |
| `poke` per link                          | 1 per minute                                                     | destination                           |
| Comment posts per member                 | 30 per minute                                                    | sender                                |
| JSON body                                | 64 KiB                                                           | destination                           |
| Manifest page                            | 200 entries or 2 MiB                                             | sender, checked again by the receiver |
| Original file                            | `min(sender, receiver maxOriginalBytes)`, default 20 GiB         | receiver enforces while streaming     |
| Shares per link, members per share       | 200, 50                                                          | sender                                |
| Links per server                         | 10                                                               | Cloud                                 |
| Grant lifetime, download token lifetime  | 5 minutes, 15 minutes                                            | Cloud, sender                         |

### 9. Threat model

The peer is another family's server: honest most of the time, but outside this server's control, possibly compromised, possibly modified. Cloud is trusted to introduce servers and to report licences and plans, and is never given photos, names or manifests. Each risk lists what stops it and the test that proves it.

| #   | Risk                                                                                                                                        | Mitigation                                                                                                                                                                                                                                                     | Test                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | A stranger calls the peer API.                                                                                                              | No grant, no proof, or a link id this server does not hold: refused before any key work; failed attempts are rate limited per address.                                                                                                                         | `household-peer.service.spec`: unknown link → 403; no headers → 401. e2e: unauthenticated call refused.                                                               |
| T2  | A peer signs with another key, or presents a grant issued to another server.                                                                | The grant's `cnf.jwk` must equal the key stored at pairing and the proof must verify against it; refused and logged with the link id.                                                                                                                          | `household-peer.service.spec`: wrong key refused and logged (FL-952 acceptance).                                                                                      |
| T3  | A grant or proof is replayed.                                                                                                               | Five-minute grants; proof bound to method, URL and grant hash and valid for 60 s; `jti` admitted once (`household_peer_request`).                                                                                                                              | spec: same proof twice → 401; proof for another URL refused.                                                                                                          |
| T4  | A link was ended, or a licence lapsed, but the peer keeps calling with a live grant.                                                        | Local link state is checked first; Cloud `grants/verify` on every request; a refusal revokes the grant locally.                                                                                                                                                | Cloud: ended link → `grants` and `verify` refuse for both sides. Server spec: ended link → 403.                                                                       |
| T5  | Cloud is unreachable.                                                                                                                       | Cached JWKS and local checks only for transport outages, for at most the grant's remaining lifetime; no new grants, so the link pauses within five minutes.                                                                                                    | spec: outage fallback accepts a live grant, refuses an expired one, refuses on a Cloud `4xx`.                                                                         |
| T6  | A peer reads beyond its shares: another space, the library, another link's share.                                                           | Every share route resolves the share by (`linkId`, `shareId`) and requires an accepted member; the manifest is the viewer-member query, nothing else.                                                                                                          | medium `household-share`: share of link A requested over link B → 403; no accepted member → 403.                                                                      |
| T7  | Locked or rule-hidden items leave.                                                                                                          | Visibility is computed at read time by the FL-446 member view with a locked session, for both the manifest and the original route; the token alone is not enough.                                                                                              | medium: manifest equals a local viewer's view item for item; locked, rule-hidden, trashed items absent; original route → 403 after locking, with a still-valid token. |
| T8  | A peer enumerates this server's users.                                                                                                      | `directory` is the only route that lists accounts; it answers linked, authorised peers only, with display names; no email, no search, no "does this address exist".                                                                                            | spec: directory fields are exactly `id`, `name`, `hasAvatar`; snapshot test that no peer reply contains an `@`.                                                       |
| T9  | Email addresses cross in member lists, comments or mentions.                                                                                | Peer DTOs are strict schemas with no email field; remote authors are stored as name and picture only.                                                                                                                                                          | e2e (Gallery #890 case): every peer reply and every web response about a remote member is scanned for either household's addresses.                                   |
| T10 | The sender lies in a manifest: wrong checksum, a huge page, a million entries, long strings, bad dates or coordinates.                      | The receiver parses every page with a strict schema with length and range limits, refuses a page over the entry or byte cap, and treats a failed page as an error for that share only (retry with backoff, status shown).                                      | `household-receive.service.spec`: oversize page, unknown field, 1 MB description, latitude 900 → page refused, nothing written.                                       |
| T11 | The sender sends a huge or endless file, or a file that is not what the manifest said.                                                      | Size is enforced while streaming; SHA-1 and size are verified before the file is ingested; the type is checked like an upload; the temporary file is deleted on any failure and the item is reported.                                                          | spec: stream longer than declared is cut at the cap; checksum mismatch → not ingested; e2e: over-cap file refused and shown in the share status (FL-994 acceptance).  |
| T12 | The sender names a checksum of a file it does not have, hoping the receiver links the recipient to bytes another local user already stores. | A received asset is only ever created from bytes downloaded from that link and verified. Universal storage deduplicates afterwards. The local library is never searched by a peer-supplied checksum.                                                           | spec: a manifest entry whose checksum matches an existing local file still downloads; a failed download creates nothing.                                              |
| T13 | A malicious media file attacks the receiver's decoders.                                                                                     | Received files take the normal upload pipeline and its sandboxing, limits and timeouts; nothing peer-supplied is executed or rendered before that.                                                                                                             | Covered by the upload pipeline's own tests; spec asserts the ingest path is the upload path.                                                                          |
| T14 | The sender floods the receiver's disk or a recipient's quota.                                                                               | Per-recipient quota applies; pulls are pull-based and paced by the receiver; the recipient can leave; an administrator can end the link.                                                                                                                       | spec: over-quota pull pauses and keeps the cursor.                                                                                                                    |
| T15 | The receiver floods the sender with requests or downloads.                                                                                  | Per-link request limit, two download streams, relay throttles; the sender's administrator sees the link's request count and last error.                                                                                                                        | spec: request 121 in a minute → 429; third stream → 503.                                                                                                              |
| T16 | A receiver impersonates one of its users to comment, or edits someone else's comment.                                                       | The receiver's server is trusted to speak for its own accounts and for nobody else: the acting user id must be an accepted member of that share, and only a comment's recorded author may change it. A receiver can never act as one of the sender's accounts. | spec: comment as a non-member → 403; edit another member's comment → 403; author id of a local user → 403.                                                            |
| T17 | Comment text carries markup or scripts.                                                                                                     | Comments are stored and rendered as plain text, as local comments are; length capped.                                                                                                                                                                          | web spec: a remote comment with markup renders as text.                                                                                                               |
| T18 | A peer returns addresses or redirects that make this server call something else (SSRF).                                                     | This server only calls addresses from the Cloud grant, never an address a peer supplied; redirects are not followed; the reply must be signed by the peer's key.                                                                                               | spec: redirect reply → error; reply signed by another key → refused.                                                                                                  |
| T19 | A deletion on one side removes data on the other.                                                                                           | No protocol message deletes or trashes media. `stop` only ends following. Unlinking only changes state.                                                                                                                                                        | medium: sender deletes, removes, locks, unlinks → every recipient copy still present (FL-994 acceptance).                                                             |
| T20 | A person shared in a space is merged into the wrong local person.                                                                           | Merge uses the recipient's own face similarity threshold and is recorded in correction history with undo.                                                                                                                                                      | `partner-people`-style spec for the household path.                                                                                                                   |
| T21 | A peer learns whether a named account exists by inviting ids.                                                                               | Unknown ids in `GET shares` are ignored silently; the sender sees "invited" either way until someone accepts.                                                                                                                                                  | spec: unknown user id → no row, no error, same reply.                                                                                                                 |
| T22 | A stolen server database gives a third party the link.                                                                                      | The link is useless without the instance private key (kept as Buddy keeps it); a suspected clone is refused grants by Cloud.                                                                                                                                   | Cloud: clone-suspected instance → grant refused.                                                                                                                      |

What an administrator sees (FL-998): each link with the other household's name, when it was last reached and by which path, why it is paused, and how many spaces are shared each way; refused requests in the server log with the link id. What they can always do: end the link.

Accepted in version 1: a linked household learns the display names of this server's accounts; a recipient keeps everything already received, by design; a sender can see which items a recipient downloaded and when.

### 10. Cases carried over from Noodle Gallery's bug list

Run as cross-server e2e cases (two-server harness like `buddy-backup.e2e-spec.ts`):

- Member emails exposed to other members (#890): no response to a remote member or about one contains an address.
- An editor-role member could change the space's name, cover or member list: a remote contributor cannot change anything on the sender but their own comments.
- A removed member kept access through a cached link: a removed member's next manifest read is `403`; the copies they have stay.
- Items added by someone who later left vanished for the others: a sender's member leaving does not send `stop` for items still in the space.
- A space's people showed faces from photos outside the space: a person entry lists face boxes only on assets in the manifest.

### 11. Relay bandwidth

Direct connections cost Frameleaf nothing. A share only uses the relay when the destination is away from home, has the plan and has no working direct address. The plan's placeholders are `relay_mbps: 8` and `relay_gb_month: 200` per server, shared with phone and web traffic.

- A first sync of a 2 000-item space at 4 MB an item is about 8 GB: 4% of the monthly allowance, about 2 h 15 min at 8 Mbps.
- A 50 GB video-heavy space is a quarter of the allowance and about 14 hours at 8 Mbps.
- Steady state (30 new items a week) is about 0.5 GB a month.

So the caps hold for ordinary family spaces, and the pull job must: prefer home and direct paths every time it connects, download at most two files at once, back off when the relay answers `429` or the monthly allowance is spent, and show "waiting for the monthly relay allowance" rather than an error. A first sync over the relay is not paced below the plan's caps (decision 4 below).

### 12. Phone account switching (FL-937, FL-963)

Independent of the protocol above: the apps key sessions, caches, mirrors and upload queues by server **and** user, so one person can keep an account on their own server and on the grandparents', or two accounts on one server, and switch from the library title. Backup stays bound to the account chosen as its target. A received space is an ordinary space to the apps; they need no household API.

### 13. Decisions

Decided by the owner on 2026-11-22 (FL-911):

1. **Who can be found.** Every active account on a linked server is listed by name to the other household's space owners. There is no per-person opt-out in version 1. Email addresses are never listed.
2. **What a remote "contributor" may do.** Comment and like only in version 1. Adding photos back to the sender's space comes later.
3. **Largest file accepted from another household.** 20 GiB, with no setting in version 1.
4. **First sync over the relay.** No extra pacing beyond the plan's caps.
