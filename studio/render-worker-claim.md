# One-claim input adapter (FL-145 / FL-106)

This command uses an **already admitted worker session** to claim one real `studio-export`
operation through the server API. It does not enroll or admit a worker. The hardware probe
does not supply a qualifying session.

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
to 32 MiB in aggregate for this specimen, held only in memory, and cleared on every exit.
Grant URLs, graph contents and credentials are not printed.

Heartbeats precede each read and the final failure report. Each read has a maximum ten-second
timeout inside the acknowledged lease. A pause, refusal, lost heartbeat acknowledgement or
expired lease stops further reads/writes; cancellation clears inputs before acknowledgement.
The server remains authoritative for claim ownership and operation limits.

The Node HTTP fixtures exercise credential/redirect isolation, grant refusal, changed bytes and
lease loss. They are wire-contract regression evidence, not real-server or GPU qualification.
The server service regression asserts that the authorized stored revision is handed out without
mutating the job; existing access-revocation coverage still refuses to read or claim that graph.

Remaining work: adapt the authorized graph/resources into the pinned headless engine, implement
real render execution and output/checkpoint limits, map the server staging directory into the
worker, verify encoded output and perform validation/completion. Hardware and codec/container
measurements, admission, real-server hosted claim/render evidence and FL-144 editor/lost-ack
browser acceptance remain open. No capability flags are set by this slice.
