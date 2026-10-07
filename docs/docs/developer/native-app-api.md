---
title: Native app API changes
---

# Native app API changes

The native Frameleaf apps (iOS and Android, in their own repositories) generate their clients from
`open-api/immich-openapi-specs.json`. When a live end-to-end test finds an API that is missing or insufficient, the server
is extended rather than worked around in the app (owner instruction, 2026-10-03). This page records each gap, the decision
and the operationIds involved.

Decisions are one of:

- **Existing endpoint**: the API already supports the journey; the app was pointed at it.
- **Extended**: an existing endpoint or DTO gained a backwards-compatible field or parameter.
- **New**: no existing endpoint fitted, so one was added.

## Access rule: home network for everyone, remote access for subscribers

Owner decision, 2026-10-03: only Frameleaf Cloud subscribers whose plan includes remote access can use the relay
or remote access. Without that subscription, or when the app is not signed in to a Frameleaf account, an app reaches a
server only on its home network, for browsing and for backup.

- **Server:** a linked server always publishes its home-network (`local`) candidates in the heartbeat. When the edge
  worker reports none (remote access off or not enrolled), the server publishes its plain-HTTP LAN fallback, the same
  candidate `getServerConnections` returns. The admin's LAN discovery switch (`server.lanDiscovery`) turns this off
  together with the DNS-SD broadcast. Relay, WAN, IPv6 and custom-hostname candidates come only from the edge worker,
  which enrols only when remote access (entitlement checked) or Buddy backup needs it.
- **Cloud:** the resources API (`GET /v1/instances`, `GET /v1/instances/:id/connections`) is the authority on which
  remote-access candidates an account sees, because a self-hosted server is not trusted to enforce a plan. See the
  instance contract in frameleaf-cloud (`docs/instance-contract.md`, Connections). Since
  Frameleaf/frameleaf-cloud#293 it keeps only `local` entries while the relay policy blocks a server.
- **Apps:** race `local` candidates at home. Race `wan`, `ipv6`, custom or `relay` candidates only when the
  `GET /v1/instances` item says `remoteAccess.entitled: true` (Frameleaf/frameleaf-cloud#293, contracts 0.0.5; a
  missing value means not entitled); otherwise show "Available on your home network. Remote access needs Frameleaf
  Cloud."

## Deleting media never syncs

Owner rule, 2026-10-03, permanent: a deletion on a phone, in iCloud or in any other source never deletes,
trashes or hides a Frameleaf asset. Sync may only add media and album memberships, and may only take back album
memberships it added itself (album source links, FL-331). An audit of the server on 2026-10-03 found no path that
propagates a device deletion: removing a backup device only marks the device record deleted, and an iCloud
sync counts media deleted in iCloud as `source_removed` and keeps it (FL-68). The planned FL-296 "device-deletion
mirror" option is void.

## Cloud admin share and server administration

Owner decision, 2026-10-03: a Frameleaf Cloud admin share keeps granting server administration (`frameleaf_role`
`admin`), and the promotion is made visible:

- `linkFrameleafAccount` (`POST /oauth/frameleaf/link`) applies a promotion at once, not at the next sign-in, and
  returns `FrameleafLinkResponseDto`: the account plus `linked`, `roleChange` (`none` | `granted-admin`),
  `confirmToken` and `confirmExpiresAt`.
- With `preview: true` nothing is linked. The response reports the role change and a `confirmToken`, valid for 10
  minutes and for this session only, which `confirmFrameleafAccountLink` (`POST /oauth/frameleaf/link/confirm`)
  redeems. Apps can show "Linking this Frameleaf account makes you an administrator of this server." before
  confirming.
- Every promotion from Frameleaf Cloud (link or sign-in) notifies the other administrators with a `SystemMessage`
  notification (`"<name> became an administrator through Frameleaf Cloud"`), besides the `admin-granted` audit row.
- Demotions are unchanged: applied at sign-in, never to the last administrator.

## Gaps

Server changes land on branch `aj/native-api-gaps` through [Frameleaf/frameleaf-app#176](https://github.com/Frameleaf/frameleaf-app/pull/176) (draft) and, for album source links, [Frameleaf/frameleaf-app#178](https://github.com/Frameleaf/frameleaf-app/pull/178) (draft). Cloud changes, all merged: [#291](https://github.com/Frameleaf/frameleaf-cloud/pull/291) (SigLIP mirror entry), [#292](https://github.com/Frameleaf/frameleaf-cloud/pull/292) (runbook link), [#293](https://github.com/Frameleaf/frameleaf-cloud/pull/293) (remote-access gating, `remoteAccess.entitled`); [#295](https://github.com/Frameleaf/frameleaf-cloud/pull/295) (first-party apps skip the separate consent step) merges when its checks pass.

| Reported by                                         | Journey                                                                                                                                                                                                        | Decision                                                                                              | operationIds                                                                                                                                                                                                                  | Change                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ios-live (FL-218)                                   | Settings > Preferences: changing any preference (for example Memories) forced every session of the account to drop its mirror and re-sync the whole library                                                    | Existing endpoint, behaviour fixed                                                                    | `updateMyPreferences` (and `updateMyPreferencesV3`), unchanged                                                                                                                                                                | The server now requests a sync reset only when the Locked rules (`privacy.suppression`: people, pets, tags, scope) actually change. Other preferences reach devices as an ordinary `UserMetadataV1` upsert. Reordering the same ids is not a change                                                           |
| ios-live (FL-218)                                   | Backup > Back Up Now: every resumable upload was refused with 400 `Invalid Asset-Metadata` because `isFavorite` was a JSON boolean                                                                             | Extended (backwards compatible)                                                                       | `createAssetUploadResource` (`POST /assets/uploads`), header description only                                                                                                                                                 | `Asset-Metadata` JSON now accepts `isFavorite` as a JSON boolean, matching its OpenAPI `boolean` type. The legacy strings `"true"`/`"false"` are still accepted; other values are still refused. `duration` is integer milliseconds                                                                           |
| android-live via live-stack (FL-218)                | Sign-in: the plain-HTTP `local` candidate (`GET /server/connections`) and the DNS-SD advertisement named the container's bind port, which a port-mapped server (host 2290 to container 2283) doesn't answer on | Existing endpoint, behaviour fixed                                                                    | `getServerConnections` (unchanged shape)                                                                                                                                                                                      | When `FRAMELEAF_LOCAL_URL` names the LAN address, the fallback candidate and the `_frameleaf._tcp` advertisement use its scheme and port                                                                                                                                                                      |
| android-live via live-stack (FL-218)                | Discovery: a linked server with remote access off reported `endpoints: []`, so `GET /v1/instances` listed no connection and the app could not reach it even on the same Wi-Fi                                  | Existing heartbeat, behaviour fixed (owner decision 2026-10-03)                                       | none (heartbeat `endpoints`, cloud `connections[]`)                                                                                                                                                                           | The heartbeat carries the plain-HTTP `local` fallback whenever the edge worker reports no `local` candidate, gated on `server.lanDiscovery`                                                                                                                                                                   |
| ios-albums / android-albums (FL-331, owner request) | Phone albums and folders sync to server albums without duplicates                                                                                                                                              | New (separate PR, [Frameleaf/frameleaf-app#178](https://github.com/Frameleaf/frameleaf-app/pull/178)) | `getAlbumSourceLinks`, `resolveAlbumSources`, `addAlbumSourceAssets`, `removeAlbumSourceAssets`, `updateAlbumSourceLink`, `deleteAlbumSourceLink`; sync `AlbumSourceLinksV1` (`AlbumSourceLinkV1`, `AlbumSourceLinkDeleteV1`) | Fork migration 0000000000222. Resolve: existing link, else merge into the oldest owned album with the same name, else create; locks give one album per source and per new name across devices. Removal only undoes the sync's own memberships; unlink keeps the album. PATCH re-keys an Android folder rename |

### Album source-link synchronization acknowledgements

Clients requesting `AlbumSourceLinksV1` through `POST /sync/stream` must use `getSyncAckV2`
(`GET /sync/ack/v2`) to retrieve their complete session checkpoint view, including
`AlbumSourceLinkV1` and `AlbumSourceLinkDeleteV1`. The existing `getSyncAck` (`GET /sync/ack`)
retains its legacy response enum and omits these new families so installed typed clients can
continue decoding it. Both GET routes require `SyncCheckpointRead` and a session; checkpoints
belong to that session, including when one owner has multiple devices.

Send stream ACK strings unchanged to the existing `POST /sync/ack`. They are opaque cursors,
not source IDs. The existing `DELETE /sync/ack` accepts both source-link families for a selective
reset. The legacy response view does not delete or narrow stored checkpoints: source-link
stream resume still uses the full ACK and tag state. No native app changes are part of this
server API repair.

## Server issues found by the live tests

### FL-330: default smart-search model missing from the model mirror

- **Found by:** live-stack, 2026-10-03. Every SmartSearch job failed with HTTP 500 on a fresh server.
- **Root cause:** the server has defaulted `machineLearning.clip.modelName` to `ViT-B-16-SigLIP-384__webli` since
  2026-05-18. The Frameleaf model mirror (`https://models.frameleaf.cloud`) was set up later and only carried
  `ViT-B-32__openai`, so the ML service could not download the default model.
- **Decision:** keep the default and publish the model on the mirror. The owner approved Apache-2.0 redistribution on
  2026-10-03. The catalogue change is in frameleaf-cloud (`infra/models/models.json`, Frameleaf/frameleaf-cloud#291, merged) and
  the operator reports that the mirror now serves the model. The operator's 2026-10-03 live-stack report records 263 of 263 items
  re-embedded on the default model at 768 dimensions with no failures; this qualification branch has not independently verified that run.
- **Guard:** `server/test/model-mirror/default-models.spec.ts` (`pnpm test:model-mirror` in `server/`, workflow
  `model-mirror-defaults.yml`) checks that every default CLIP, facial-recognition and OCR model answers 200 on the mirror.
  It runs on pull requests that touch the ML defaults or model source, and weekly.
- **API impact:** none. No operationIds changed.

## HEIC retention and Live Photo still edits

Duplicate suggestions always rank RAW first, HEIC/HEIF/HIF second, and other formats third, then file size, EXIF coverage and stable asset ID. `preferOriginalFormat` is deprecated and accepted for compatibility; false does not disable this ordering. Format preference does not establish capture provenance.

Duplicate lists and review groups may include `reviewRequiredReasons`: `edited-copy`, `develop-history`, `distinct-motion`, or `evidence-unavailable`. Clients must not apply bulk suggested keepers to these groups. Historical Develop, external and video edit versions remain protected after reset (`develop-history` covers all retained edit history). Resolution rechecks disposal safety on the server before merging metadata or trashing copies. Keep the protected copies; a suggested HEIC is not permission to discard an edited JPEG or its motion. Burst groups never receive a single-keeper suggestion.

Develop can save and render the visible still image of a Live Photo. Its asset identity, original, motion link and original motion are unchanged. Reset moves only the still's current revision. Native viewers must display the edited still while idle and the original motion only during playback. An edited still export must be identified separately from an original Live Photo pair.

## Source image encoding

Asset and sanitized shared-link responses may include `imageEncoding`. Older
servers may omit it. `dynamicRange: unknown` means evidence is unprocessed or
unavailable; clients must not translate it to SDR. The object carries technical
container, transfer, primaries, bit depth, gain-map and reconstruction information
when known, without exposing capture EXIF or location.

`reconstructionAvailable` describes source decoder support. It does not imply an
HDR rendition has been published, that the codec has passed camera-media
qualification, or that the current display can show HDR. `referenceWhite` is the
processing reference in cd/m², never a screen measurement. `fallbackReason` and
`inspectionStatus` distinguish unsupported reconstruction from failed inspection.
Existing media requests still return SDR-compatible renditions.

The historical Develop renderer refuses detected HDR rather than silently
flattening it. Its `develop_hdr_render_unavailable` response retains the original,
previous working version, and Live Photo motion. Native clients retain their
unsaved recipe and show the server explanation. HDR-preserving recipe rendering
and delivery require the separately qualified renderer/rendition capability.
