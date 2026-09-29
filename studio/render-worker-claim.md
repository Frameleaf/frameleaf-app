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
the other resource adapters; real render execution and output/checkpoint limits; map the server staging directory into the
worker, verify encoded output and perform validation/completion. Hardware and codec/container
measurements, admission, real-server hosted claim/render evidence and FL-144 editor/lost-ack
browser acceptance remain open. No capability flags are set by this slice.
