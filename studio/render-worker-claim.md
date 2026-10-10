# One-claim input adapter (FL-145 / FL-106)

This command uses an **already admitted worker session** to claim one real `studio-export`
operation through the server API. It does not enroll or admit a worker. The hardware probe
does not supply a qualifying session.

Prepare the pinned engine first (`node studio/tools/engine.mjs prepare`) and install its locked
dependencies (`npm --prefix studio/engine ci --ignore-scripts --no-audit --no-fund`). This slice
uses its actual headless media resolver/server and pinned Sharp/tsx dependencies. Only direct
still-image timelines made from library assets are adapted; unsupported graphs fail closed.

```sh
FRAMELEAF_URL=https://your-home-network-server.example \
FRAMELEAF_WORKER_SESSION="$YOUR_EXISTING_WORKER_SESSION" \
node studio/tools/render-worker-claim.mjs
```

Use an expendable integration export: the command consumes the claim by reporting
`worker_executor_unavailable` after successful preparation. This can use an automatic retry
attempt or fail the job. An empty queue returns `idle`; other outcomes exit nonzero. It never
reports rendering progress, validates output or publishes an asset.

The server resolves the snapshot's immutable stored revision and current owner access before
claiming. Its response now includes that same authorized graph under `snapshot.studio.graph`;
the persisted job retains its revision reference. The command binds a copy of the snapshot,
settings and authorized input bytes to the operation, revision and claim token in memory.
It never requests a mutable project head or follows graph URLs or filesystem paths.

Every input must use the exact operation-specific grant endpoint on the configured origin.
Redirects are refused; the server rechecks current access and signed grant binding for every
read. The client also checks available SHA-1/SHA-256 hex or base64 checksums. Inputs are bounded
to 32 MiB in aggregate for this specimen. The image adapter rechecks those bytes' SHA-256,
verifies the prepared engine source digest, and applies the server's full graph resource extractor.
Every extracted reference must name one of the direct library images; nested models, presets and
other non-byte resources are refused even when they have no input grant. Graph violations are refused.
Before writing any temporary copy, the adapter decodes every source with the lockfile-pinned Sharp:
only non-animated PNG/JPEG/WebP, at most 32 MiB encoded and 16,777,216 pixels, with a five-second
decoder timeout and invalid-data warnings treated as failures. PNG animation chunks are explicitly
refused because a decoder may otherwise expose only their first frame. A matching hash or valid
header alone is insufficient. Private temporary copies use generated filenames and the decoded
format for the correct MIME type. Freecut's actual loopback media server exposes each under an independent random
source key only while the lease is live. Its `project`/`media` payload preserves the graph and
uses the original media IDs; no credentials or remote grants enter that payload. Source bytes
are kept byte-identical for the eventual renderer, and optional image metadata is left absent rather than
invented. The current command disposes the adapter before reporting executor unavailability.
Temporary files are removed and retained input buffers cleared on exit. Grant URLs, graph
contents, local source URLs and credentials are not printed.

Heartbeats precede each read and the final failure report. Each read has a maximum ten-second
timeout inside the acknowledged lease. A pause, refusal, lost heartbeat acknowledgement or
expired lease stops further reads/writes; cancellation clears inputs before acknowledgement.
The server remains authoritative for claim ownership and operation limits.

The Node HTTP fixtures exercise credential/redirect isolation, grant refusal, changed bytes and
lease loss. An additional test drives the real prepared Freecut media resolver/server, checks
full and Range reads, graph preservation, identity substitution and source refusal after lease
loss. They are input-contract regression evidence, not real-server or GPU qualification.
Negative cases also cover nested models/presets, text and video bytes, SVG, truncated PNG and
corrupted pixel data with matching grant hashes; successful preparation uses an actual PNG fixture.
The server service regression asserts that the authorized stored revision is handed out without
mutating the job; existing access-revocation coverage still refuses to read or claim that graph.

Remaining work: video/audio probing and metadata, generated media, nested compositions and
the other resource adapters; real render execution and output/checkpoint limits; use the server-owned artifact transport below for encoded output and validation/completion. Hardware and codec/container
measurements, admission, real-server hosted claim/render evidence and FL-144 editor/lost-ack
browser acceptance remain open. No capability flags are set by this slice.

## Whole-export artifact transport (FL-107 prerequisite)

The server owns staging. A worker does not mount a writable server directory or send a filesystem
path for a Studio export. This protocol does not add an executor or admit unsupported graphs.
The existing input preparation command continues to report `worker_executor_unavailable`.

An export claim includes `artifactInputDigest`: a server SHA-256 binding of its immutable revision
and currently authorized resource identities/checksums, plus an explicit PQ mastering profile when
present. Changing that profile invalidates completed artifact recovery. Plan exactly one checkpoint, sequence `0`,
using that digest as `inputDigest`, plus the existing chunk key, effect/config/history digests,
seed, declared timebase and whole-export tick range. Reuse still requires the entire existing
checkpoint plan to match. A completed artifact is also opened as a regular file and rehashed;
missing/corrupted bytes or changed sources refuse recovery. Old path-reported checkpoints cannot
be trusted merely because they have a completed state.

Upload the actual encoded bytes with
`PUT /render-workers/operations/{id}/artifacts/0` and `application/octet-stream`.
Keep the worker session in the existing `x-frameleaf-worker-session` header and the current claim
in `x-render-claim-token`; neither credential belongs in the URL. Query metadata is `chunkKey`,
`checksum` (SHA-256 hex), `sizeInBytes` (decimal safe integer), and optional `role` (`media` or
`subtitle`, default `media`). Media requires a positive size. The server streams with
backpressure, enforces the declared exact byte count and existing operation output/wall-clock
limits, and uses an exclusive private generated partial filename. It flushes and atomically
renames the file, independently validates actual bytes, then conditionally completes the pending
checkpoint under the active lease. Rejected/disconnected uploads and losing concurrent uploads
remove their own partial/final file. A server crash cannot leave a checkpoint pointing at a partial
file; orphaned staging files remain subject to the existing staging lifecycle.

A replacement active claim can use
`GET /render-workers/operations/{id}/artifacts/0?chunkKey={key}` with the same two headers.
The matching completed checkpoint must retain the current source binding. The server verifies
size/SHA-256 and streams from the verified descriptor, with private/no-store caching and a
`Digest: sha-256=...` response header. It returns no server path. Expired, paused, cancelled,
replaced or revoked claims are refused; long transfers recheck access as they stream.

After the bytes are accepted, request validation and completion using the existing endpoints and
`{ claimToken, artifactSequence: 0, resultAssetId: null }`. Studio exports reject legacy `output`
path reports. Validation and staging reverify the actual artifact and current sources; durable
transitions guard expiry/pause/cancel as well as the claim token. Container type comes from the
server-selected export format. Existing publication still verifies encoded media, ownership,
privacy and source provenance before adopting a result. Preview and other operation kinds retain
their established output protocol. No engine patch or capability flag is changed.

This is transport/recovery infrastructure. Edited float PQ/HLG rendering, native Main10 encoding,
independently measured output PTS, multichannel order/layout, complete HDR metadata, real executor
restart, reference-monitor and deployment/hardware qualification still need genuine evidence.

## Sealed media and SRT pair (FL-105)

`subtitleMode: "sidecar"` requests a required SRT sibling for the supported local MP4/H.264
export with `color: "preserve"`. Unsupported timelines and unqualified worker profiles remain
refused. The server seals the canonical cue content against the immutable revision, authorized
manifest, engine revision and export range. The worker cannot supply new subtitle meaning or
replace the seal. This transport does not enable embedded subtitles or expand codec, audio,
container, HDR, provider or hardware support.

Both roles use the same sequence-zero checkpoint and claim credentials. Upload media with the
omitted/default role or `role=media`; upload the SRT with `role=subtitle`. Its declared SHA-256
and size must exactly match the seal. Only a sealed zero-cue SRT permits size zero. Installing
one role leaves the pair pending; completion requires both matching files. The serialized
checkpoint authority rechecks the claim after waits, verifies existing files, and applies the
shared operation output budget to the artifacts. An identical retry counts its stored role once;
both stored and incoming bytes are still verified. A different checksum or size receives no
retry exemption. Recovery GET accepts the same optional role;
subtitle recovery requires the sealed pair. Legacy media-only exports retain their role default.

Validation and publication recheck the current authorized sources and independently hash both
files. Pair moves occur under publication authority and path locks. A failed move attempts to restore
both roles and retains an unresolved recovery failure; a lost commit acknowledgement is settled
against durable version identity before any reverse move. Cleanup counts both roles' references and pins. Reusing an existing Library media
asset retains the export's required subtitle sibling.

`GET /studio/exports/{id}/subtitle` serves that sibling to the current owner session. API keys
and shared links do not grant access. The version, original source epochs, current source access,
Locked/sensitive session privacy and any Library result are checked again. The endpoint supports
one inclusive byte range and uses private/no-store/no-transform caching. The verified descriptor
is retained during delivery; current authority is checked before each body chunk. Revocation
stops later chunks but cannot retract bytes already delivered or queued by HTTP transport.

Schema migration `2100000002963-StudioSubtitleSidecarArtifacts` appends nullable paired fields;
legacy rows remain media-only. Buddy metadata includes both roles and source epochs for sealed
pairs. A missing required sibling refuses the pair rather than importing a partial export.

The local repository and stream controls exercise authority, rollback, cleanup and test bytes.
They are not an actual encoded-pair worker, measured profile or deployment receipt. Admission
requires fresh evidence for the exact coherent engine and server source.

## Explicit PQ mastering display

PQ exports (`color: "hdr10"`, or `color: "preserve"` with PQ sources) require `mastering` on
`POST /studio/projects/{id}/exports`: `{ "primaries": "bt2020", "maxNits": 1000, "minNits": 0.005 }` is an
example, not a default. Select the actual mastering display range. The API accepts BT.2020
primaries with D65 white, a positive maximum no greater than 10,000 nits, and a nonnegative
minimum below that maximum, both at ST 2086's 0.0001-nit precision. Unknown fields are refused;
source MaxCLL/MaxFALL and preview defaults are not mastering authority. SDR and HLG exports do
not accept this PQ profile.

The Studio export dialog starts with blank display limits. HDR10 requires them; Preserve
offers an explicit PQ declaration because HDR source flags alone cannot distinguish PQ from HLG.
Turning that declaration off omits the profile, and reopening clears it. The host forwards the
chosen profile through the existing export request; the server still decides whether the actual
source transfer and qualified worker permit the export.

The server copies the profile into the saved settings and immutable export contract handed to
the worker. Its artifact input digest includes the profile. Publication independently probes the
first decoded picture of the same selected video stream whose codec, depth and HDR tags were
validated, and verifies all eight chromaticity coordinates and both luminance values before moving
the output into the library. Missing, unreadable or different mastering metadata refuses publication. Contracts saved before explicit mastering retain their existing
checks; new PQ submission without a valid profile returns `studio_export_mastering_unknown`.

This binds declared mastering authority and encoded output. The production HDR renderer,
measured edited MaxCLL/MaxFALL and device qualification still need
implementation or evidence; this protocol does not enable HDR capabilities.
