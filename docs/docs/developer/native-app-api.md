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

Asset responses may include `imageRenditions` with current-still availability for
`sdrPreview`, `sdrFullsize`, `hdrPreview`, and `hdrFullsize`. Omission means file
evidence was not loaded. Source HDR identification alone never enables an HDR
display or export action. Rendition identities remain server-private.

Focused `thumbnail` requests accept `dynamicRange=auto|sdr|hdr` with `size=preview`
or `size=fullsize`. Omission retains SDR-compatible delivery. `auto` uses an HDR
derivative when available, otherwise SDR; explicit `hdr` fails if unavailable.
Grids, face sources and thumbhash remain SDR. These routes retain existing asset
authorization, shared-link access, revocation and relay full-size restrictions.

HDR processing and delivery currently require `FRAMELEAF_HDR_IMAGES=experimental`.
This is a qualification gate, disabled by default. The candidate codec build has
not passed camera-media or physical-display acceptance. Existing derivatives
remain registered when the gate is disabled. New HDR and SDR renditions publish
together through the existing job lease; failed regeneration retains the prior
set. No original or Live Photo motion is rewritten.

The historical Develop renderer refuses detected HDR rather than silently
flattening it. Its `develop_hdr_render_unavailable` response retains the original,
previous working version, and Live Photo motion. Native clients retain their
unsaved recipe and show the server explanation. HDR-preserving recipe rendering
and delivery require the separately qualified renderer/rendition capability.

## HDR-preserving Develop revisions (experimental)

New edits use recipe version 6, renderer `frameleaf-develop-hdr/4`, and policy
`hdr: {version: 4, intent: "preserve", referenceWhite: 203, sdrToneMapper: "libultrahdr/2.0.2-frameleaf.4"}`.
This policy adds ISO HDR-base PQ/HLG reconstruction with the authored SDR alternate,
and includes centered sampling of reduced ISO gain maps and fractional container crops,
with RGB conversion before geometry and aggregate raw-surface/retained-buffer admission.
The installed renderer is reported by `imageCapabilities.renderer`. Rendering a
revision with another renderer fails with `develop_renderer_unsupported`; published
files remain available and unchanged. Editing a historical HDR recipe creates a
new v6 revision, preserving unknown fields rather than mutating historical rows.

Historical version 5 retains `frameleaf-develop-hdr/3` and policy version 3,
with `sdrToneMapper: libultrahdr/2.0.2-frameleaf.3`.
Historical version 4 retains `frameleaf-develop-hdr/2` and HDR policy version 2,
with `sdrToneMapper: libultrahdr/2.0.2-frameleaf.2`. Clients promote recognized
historical policies only when creating a new editing revision; unknown policies remain opaque.

Historical recipe version 3 names renderer `frameleaf-develop-hdr/1` and policy
`hdr: {version: 1, intent: "preserve", referenceWhite: 203, sdrToneMapper: "libultrahdr/2.0.2"}`.
Omitted policy fields receive those defaults. Historical v1 and native RAW v2
revisions keep their renderer identity. Clients must preserve unknown envelope
fields and must not rewrite v3, v4, v5 or v6 recipes as v1. Unsupported fields fail rendering.

Preview requests and revision-file requests accept `dynamicRange=auto|sdr|hdr`.
Omission retains SDR-compatible output; explicit HDR fails when unavailable.
Versions 3–6 render HDR master/preview and SDR master/preview together using the
isolated worker. The server validates the set before publication. Regeneration
keeps the last accepted set available during failure or cancellation.

Revision responses add `outputDynamicRange`, `hdrRenderStatus`, `hasHdrMaster`,
and `hasHdrPreview`. Availability remains capability-gated; saved HDR pixels
do not prove the current display can show HDR. The experimental gate is not
camera-media or physical-display qualification. Still-only Live Photo saves
retain original motion and pairing.

### Explicit still exports

`GET /assets/:id/develop/revisions/:revisionId/file?kind=master&format=sdr-jpeg|hdr-jpeg|hdr-heic`
exports a saved version. `format` overrides the viewing `dynamicRange`; omission
keeps the existing rendition request. Explicit exports require both owner edit
access and download permission, including API-key download scope. They retain
relay transfer limits, locked/hidden filtering, and session authorization.

HDR JPEG serves the published gain-map master without another encode. SDR JPEG
serves the paired, tone-mapped master of an HDR revision. Historical SDR versions
get a temporary sRGB JPEG copy through the existing isolated worker, with capture
metadata stripped; this does not change their recipe, renderer, or stored pixels.
An external version without verified SDR pixels is refused. Unsupported HDR HEIC
returns `hdr_heic_export_unavailable`; it never substitutes JPEG or SDR.
When the codec probe verifies ten-bit PQ encoding, HDR HEIC is made from the
published HDR master through the same worker. It preserves the source gamut and
alpha, emits verified PQ/nclx signaling, and strips capture metadata. Its temporary
copy is delivered only after permission and revision revalidation, then removed.
HEIC compatibility varies by decoder; the gain-map JPEG remains the compatible
HDR choice with an authored SDR baseline.

Export filenames identify these as still images. An edited Live Photo still does
not include motion or claim to be an edited Live Photo pair. Authorized original
and original Live Photo downloads continue through their existing routes. Clients
must retain unsaved edits when an export is refused, and must not advertise HDR
HEIC until the server's separate export capability includes it.

`GET /assets/:id/original?format=sdr-jpeg|hdr-jpeg|hdr-heic` converts an unedited
photo to a separate still, without creating a Develop revision. Omission keeps
original download behavior. Conversion uses the same isolated worker, binds the
captured bytes to the stored checksum, and revalidates download permission and
source identity before delivery. Original byte length is not the export length;
clients must use response headers. Temporary outputs use private, uncached
responses and are removed after delivery or joined cancellation. Explicit HDR
requests fail when reconstruction or the required encoder is unavailable; they
never flatten to SDR. Motion files and substituted saved edits are refused.
Live Photo still conversion retains its original motion link and files.

`GET /server/features` also exposes optional `imageCapabilities`. Its `decode`,
`render`, and `export` lists are independent and come from a probe inside the
existing isolated image worker. `codecs` records the installed library versions.
`experimentalEnabled` reports the administrator gate; `qualified` remains false
until real-media and physical-display acceptance pass. An absent field means an
older server with unknown capabilities. A missing codec reports empty lists,
without preventing ordinary server feature discovery. Apple gain-map HEIC and ISO
adaptive HEIF decoding are reported separately when installed. ISO reconstruction
accepts supported SDR bases with sRGB signaling, or at least ten-bit PQ/HLG HDR
bases with supported nclx primaries and a reconstructable authored SDR alternate.
Reduced gain maps and supported fractional container crops use centered sampling;
container transforms apply exactly once. HDR-base ICC profiles, invalid metadata,
and unsupported reconstruction fail explicitly. This does not claim adaptive HEIF
encoding. HDR HEIC export is
offered only after the installed encoder passes the worker's ten-bit PQ probe.

Adaptive JPEG reconstruction requires a primary RGB matrix ICC profile with supported
BT.709, Display P3, or BT.2020 primaries and an sRGB transfer compatible with the
installed decoder. Missing, corrupt, or unsupported primary color interpretation
reports `reconstructionAvailable: false` with `fallbackReason: hdr-profile-unsupported`.
Supported JPEG profiles expose their identified `colorPrimaries`. Clients must not
infer sRGB when this information is unavailable. Authorized original downloads and
explicit, color-managed SDR JPEG base export remain available; HDR export is refused.

### HDR preview histogram

Recipe v3–v6 preview responses optionally carry `X-Frameleaf-HDR-Histogram`, exposed
for cross-origin clients. The image and histogram come from the same admitted
worker render. The histogram uses linear pixels before output tone mapping, so
choosing SDR display does not remove highlight evidence. No source metadata is
included and the response remains private and uncached.

The version 1 JSON object contains `version: 1`, `bins: 64`, `minStops: -10`,
`maxStops: 6`, `referenceWhite: 203`, `peakStops`, `samples`, `max`, and four
64-element count arrays: `red`, `green`, `blue`, `luma`. Bin positions are
`floor((log2(value) + 10) / 16 * 64)`, clamped to 0–63; 0 EV is reference white.
Transparent pixels are excluded. `clipped.shadows` is the fraction at or below
zero luminance; `clipped.highlights` is the fraction with a channel at the
encoder's 10,000-nit ceiling. Missing or invalid evidence is unavailable, never
reconstructed from an 8-bit display canvas. This describes the rendered preview,
not a measurement of the screen's available brightness.

### Studio still exports

The existing Studio export endpoint additionally accepts `sdr-jpeg`, `hdr-jpeg`,
and `hdr-heic`, with `resolution=original`, `color=preserve`, and high quality.
An absent range selects frame zero; an explicit range must select exactly one
main-timeline frame. Video mastering, subtitle settings, and Smooth motion do
not apply to still output. HDR formats require an explicitly HDR document and
the experimental server gate. Unknown document intent retains the existing SDR
intent. A still export does not create or replace Live Photo motion.

Still outputs and individual image inputs are limited to 48 million pixels,
with at most 64 million decoded input pixels per export. HDR processing uses
one isolated image worker with a combined 6 GiB surface budget. Photo exports
have a 180-second ceiling and honor stricter worker claims. The compositor
rejects images beyond the device's upload-buffer limit or GPU allocation
failures before publishing an output.

The immutable render snapshot includes a version 1 image contract: dimensions,
frame, format, output dynamic range, document output intent, reference white of
203 cd/m², and renderer `frameleaf-studio-image-v1`. The existing worker executes
it through the float compositor and isolated codec. SDR documents use the
renderer’s SDR output conversion; SDR exports of HDR documents use the pinned
codec’s tone mapper. HDR output regenerates a gain map or writes ten-bit PQ HEIC.
Every still is sanitized again on the server and verified before publication.

HDR documents admit brightness, contrast, exposure, saturation, temperature and tint,
grayscale, invert, sepia, Gaussian blur, box blur, motion blur, and normal straight-alpha compositing in the linear BT.709
working domain (1.0 = 203 cd/m²). Spatial filters accumulate premultiplied light
and coverage, then return straight alpha. Unreviewed effects, transitions and
non-normal blends fail with `HdrRenderUnavailableError`; clients must retain
unsaved edits and show the explanation. SDR documents retain their existing
encoded effect semantics.
The transaction records the canonical file’s checksum and size. Worker artifacts
remain private and immutable while a failed publication retries.

Render evidence must prove the specific still writer and its container,
independently of video encoders. A compositor probe alone does not enroll or
qualify a worker. Existing destination, revision, source-access, locking,
private-download, cancellation, and publication checks remain authoritative.
These formats remain gated until codec, corpus, and hardware acceptance pass.

### Existing-library backfill

With `FRAMELEAF_HDR_IMAGES=experimental`, the existing missing-metadata queue also
selects non-RAW images without an encoding inspection. Successful and failed
inspections are retained, so repeat enumeration skips them; a deliberate forced
metadata run retries failed inspections. Video and RAW metadata behavior stays
unchanged. After inspection, the existing missing-thumbnail queue selects
reconstructable HDR sources missing either original HDR rendition. Edited sources
are excluded from this additional selection, and historical Develop revisions
are not rerendered. Hidden sources retain their existing thumbnail exclusion.

Both selections use the existing durable queue manifest, concurrency, retries,
leases and cancellation. Generated files belong to an attempt; previous SDR/HDR
renditions remain available until the complete new set is adopted. Disabling the
gate stops this additional selection and HDR generation without removing existing
media, originals or recipes.
