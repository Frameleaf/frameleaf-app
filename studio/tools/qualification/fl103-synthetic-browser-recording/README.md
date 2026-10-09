# Private FL-103 synthetic Chromium recording packet

Source-only qualification tooling. This packet has not launched a browser or captured audio. It adds no production behavior, application dependency or admission exception. Root review and separate authority for one actual run are required before `--execute-reviewed`.

The five cases import the prepared production MicRecorder/meter/monitor, recording controller/stores and the adapter's actual VirtualWorkspace/watchLocalImports. Constructor observations delegate to native AudioContext, MediaRecorder and Worker; getUserMedia delegates to the native browser implementation. No encoded recording, track, WebAudio node or permission error is synthesized in JavaScript.

| Case        | Required native/local witnesses                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| grant       | Granted browser permission, actual MediaRecorder start/pause/resume/final data/stop, nonzero meter and decoded audio, finite duration, ended tracks and closed contexts.                                                                                                                                                                                                                                                               |
| denial      | A fresh context with CDP Browser.setPermission denied using its native Target browserContextId; navigator.permissions denied; actual NotAllowedError; controller refusal and no artifact/upload/placement.                                                                                                                                                                                                                             |
| late-cancel | Hold delivery of a stream actually returned by native getUserMedia, dispose the actual recorder, release it, require AbortError, ended tracks and zero meter/recorder allocation. This is an artificial stream-delivery barrier, **not OS permission-prompt cancellation or latency**.                                                                                                                                                 |
| monitor     | Retired native late stream refuses before metering; ordinary production monitor gets actual meter samples then stops all tracks and closes its native context.                                                                                                                                                                                                                                                                         |
| ownership   | Controller cancellation before delivery creates no artifact. Ordinary take writes decodable source/metadata/project association and one clip anchored at frame 12. A second admitted source close is held through workspace/project A→B→A; successful bytes and association remain in A, B stays empty and the retired take places no current clip/selection/error. Production import-watch File bytes must hash to the actual source. |

The upload callback is an explicit local observation sink. Its acknowledgement does not prove server upload, access control, persistent project storage or save/reopen. The fixture mounts production controller/store modules; it does not claim toolbar interaction or the full product baseline. Production controller enumeration sees the browser's synthetic capture devices; no operator device is selected or requested.

Only two synthetic media flags are admitted: `--use-fake-device-for-media-stream` and `--use-file-for-fake-audio-capture=<owned WAV>`. The third custom launch argument forces loopback through the proxy. Fake permission UI, branded Chrome, other cached browsers, browser downloads, personal profiles and physical input capture are forbidden. A new isolated context is used for every case.

The WAV is generated in memory, never committed: 6 seconds, mono 48 kHz signed 16-bit integer triangle wave, 576,044 bytes, SHA-256 `de4c3c25a77c114b4c7ce27feb3879a9492b7af91edfb8baa83a0db6f19e86c4`. Native lossy encoded output is decoded and measured; it is not compared byte-for-byte with the input WAV.

## Binding and network guards

The only prepared input root is `/Users/adamtaylor/.codex/worktrees/fl105-durable-sidecar/immich`, read-only. The original exact-head check refused when root integrated unrelated work; that receipt is preserved. Root authorized a replacement guard: require `d93bdd45453983700b23ff423b45a92ce0170fab` ancestry, an unchanged tracked `studio` subtree against that base, a clean input root, and separately freeze its actual current HEAD. Any change after freezing requires a new review.

Every preflight inventories the full adapted engine and calls existing admitAdaptedSource with `5b29142999ca0f06d8d9f151ad0bfeae95b6b75892b70c38a9532b2152de32ec`. It verifies every patch and the 12 existing COMPOSITION_SOURCES hashes. Adapter sources, shared tools, packet files, configuration/provenance/lock/receipt files, installed browser resources and selected bundler/Playwright/native bundler package files are separately bound. Receipts are read and hashed, never rewritten or imported as measurements.

Pinned existing Playwright is 1.60.0; headless-shell revision 1223, browser 148.0.7778.96; executable SHA-256 `aa25f2e795c02d5cb5ef5d6987745cc5bbe7d8bea58827390c7a4c81c8d2dd7b`. Source inventory and package hashes are checked before/after a run. Lockfile identity and the selected installed package inventories do not independently certify every transitive installed package against npm's published integrity.

The runner owns its Vite instance with a reserved strict loopback port. Filesystem access is limited to the private fixture, the verified engine/dependency tree and adapter source directory; no broad user-directory allowlist. Vite cache/build output is outside the input tree. The existing deny-all cross-browser proxy is mandatory: a transparent entry GET, only proxied requests to the single origin, no overrides, tunnels, blocked external requests or proxy errors. HMR and service workers are disabled. A race for a released reservation fails strict binding rather than silently changing ports.

## Bounds and cleanup

Each operation has an 8-second default, each complete case 30 seconds, the supervised child 180 seconds plus a 10-second termination grace. Cleanup attempts fixture, context, browser connection, browser server, proxy, Vite and both reserved ports in order even after an error; total callback budget is bounded. Reports/logs are capped at 1 MiB and written exclusively with mode 0600 into an existing mode-0700 evidence directory. The WAV uses exclusive creation, so a second attempt cannot overwrite a prior recording input.

Fixture disposal failures remain refusals even if emergency native cleanup succeeds. The parent supervises one detached process group, observes ancestry/start identities every 250 ms, retains observed detached descendants, checks ports, and signals only that owned group and observed identity-matching descendants. A nonempty terminal census, timeout, signal, missing report, overflow or cleanup failure refuses measurement. A descendant that detaches before observation cannot be exhaustively certified; this limit is explicit in the report. No physical GPU/Metal identity, browser rendering/raster or worker admission is inferred.

## Source-only checks

Use the already installed pinned Node; no installation step:

```sh
/Users/adamtaylor/.local/share/mise/installs/node/24.21.0/bin/node --test studio/tools/qualification/fl103-synthetic-browser-recording/controls.test.mjs
```

The controls cover PCM headers/energy/golden digest, every bad identity pin, exact capture flags, proxy refusal, missing-witness timeout, report bounds, cleanup ordering after throw/hang, and observed detached/PID-reused process identities. They are harness CPU controls, not microphone qualification or a historical production RED.

The `--source-build` mode only bundles the fixture/imports through the installed Vite-plus core. It opens no server and invokes no browser or capture API. CPU bundle output and raw warning/error logs belong in the private audit directory. Production modules have been linked, but browser behavior remains unexecuted.

## Frozen future invocation — unexecuted

First root reviews the exact source commit/tree, evidence manifest and hash. This is a single-use command template for that reviewed packet, not authorization:

```sh
FL103_SOURCE_ROOT=/Users/adamtaylor/.codex/worktrees/fl105-durable-sidecar/immich \
FL103_EVIDENCE=/Users/adamtaylor/.codex/audits/fl103-browser-recording-gap-20261009/source-candidate \
/Users/adamtaylor/.local/share/mise/installs/node/24.21.0/bin/node \
/Users/adamtaylor/.codex/worktrees/fl103-synthetic-browser-recording/immich/studio/tools/qualification/fl103-synthetic-browser-recording/runner.mjs \
--execute-reviewed /Users/adamtaylor/.codex/audits/fl103-browser-recording-gap-20261009/source-candidate/frozen-binding.json <ROOT-REVIEWED-MANIFEST-SHA256>
```

The same environment plus `--freeze <new absolute manifest>` performs CPU preflight only. `--attempt` requires the supervisor token and is not a standalone entrypoint. Frozen file/HEAD changes refuse; do not refresh a manifest or reuse an output directory to hide a failed attempt.

No physical microphone permission UX, real device replacement/hotplug, OS acquisition delay, native latency, sample-accurate A/V sync, channel/pitch/EQ/master/monitor rendering, Safari/Firefox, native apps, backend privacy/durability/reopen, worker/export, silence/filler or caption acceptance is claimed. Full admitted-host microphone acceptance still needs a reviewed new scenario, current application image, genuine API ownership checks and fresh exact-source device admission. Source99 expiry and every production source/raster/device/admission guard remain unchanged.
