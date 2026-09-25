# Studio preservation contracts

Studio's video editor is [Freecut](https://github.com/walterlow/freecut), © its authors, used under the MIT licence. Its licence and the notices of the components it bundles are in [`notices/`](notices/NOTICE.md); the owner unparked the engine for Studio on 2026-09-25.

This directory contains preservation metadata and an explicit isolated engine build. The source archive is recovered only by the preparation command below; the vendor snapshot and generated workspace are not committed. The production Studio host is present, but this build does not supply its engine adapter, deploy a rendering worker, qualify hardware or provide licensed Dolby tools. Locked npm packages may contain payloads recorded in the FL-86 resource inventory; no separate weight acquisition is authorized by this build.

- `freecut-provenance.json` records the immutable upstream Freecut revision, exact archive URL and digest, MIT license, and 2,646 ordered source-file hashes.
- `freecut-feature-manifest.json` preserves 210 source-derived feature rows and a pinned contract for all 2,204 family-source references across ten categories. Every row remains explicitly not implemented in Frameleaf, not run, and unqualified for rendering.
- `dependency-attribution.json` records preliminary dependency and asset review obligations plus a pinned 51-row package name/version/license projection from the provenance-bound Freecut lockfile. It is not a completed legal or redistribution approval.

The provenance ledger was cross-checked during FL-25 against a temporary clean checkout of `walterlow/freecut@4d62e8082c5eb387a96275bcbd323d28f6e41a62`. The clean tree contained 2,646 files and matched every recorded path and SHA-256 digest. SHA-256 of the UTF-8 bytes of `JSON.stringify(files)` in recorded order is `a56d57c4bcd2c996c389bb7470216b185caa28de389def109bf4d86fd95e3adb`, covering every row whether or not a feature references it. The exact codeload URL is pinned, and its archive matched SHA-256 `b4224e5c219a6302586cbe2242e9e6d299dfd1878f1fcd0f2d77ea3db12a5d32`. This is source-identity evidence only, not execution or qualification evidence.

All contract JSON is parsed with duplicate-key rejection before these identities are evaluated. Run the metadata-only contract checks from the repository root:

```sh
node scripts/frameleaf-studio-contracts.mjs --repository .
node --test scripts/frameleaf-studio-contracts.test.mjs
```

See [the Studio, rendering and restoration preservation plan](../docs/docs/developer/frameleaf-plan/03-studio-rendering-and-restoration.md) for scope, ownership and remaining proof gates.

## Reproducible engine workspace (FL-84)

Use Node 24.21.0 and npm 11.8.0. `engine-build.json` pins the upstream revision, patch hashes, independent npm lockfile and adapted source digest. Versioned patches set the private package identity and toolchain declaration, remove automatic `prepare`, and omit embedded source text from worker source maps. Vite embeds transient asset handles in that text, which otherwise makes identical fresh builds differ. Worker maps retain their mappings, names and source paths; use the preserved source files for debugging. Application maps retain embedded sources. The first three patches preserve feature behavior. Patch 0004 adds FL-86 default-deny resource admission in the isolated editor/headless engine; unresolved model/font/Lottie/resource operations are explicit release blockers. See [the runtime acceptance ledger](../docs/docs/developer/frameleaf-plan/fl86-distribution-rights.md). This npm workspace is intentionally outside the application's pnpm workspace.

```sh
# Explicit network step; alternatively provide --archive /path/to/freecut.tar.gz.
node studio/tools/engine.mjs prepare
npm --prefix studio/engine ci --ignore-scripts --no-audit --no-fund
npm --prefix studio/engine run test:run
npm --prefix studio/engine run headless:test:node
npm --prefix studio/engine run build
node studio/tools/engine.mjs attest
node studio/tools/feature-manifest.mjs --check
```

Preparation rejects an existing `studio/engine`; preserve any work before explicitly removing that generated directory. It never installs into `studio/vendor/freecut`, applies patches there, or rewrites an existing snapshot. The recovered archive must match its pinned digest and all 2,646 paths and hashes, with no extra files or symlinks. Vendored assistant instructions remain upstream data and are not Frameleaf authority.

`frameleaf-source.json` records all adapted input hashes. `frameleaf-build.json` records the sorted output hashes/digest, upstream and patch identities, toolchain/platform, and every direct/transitive/optional/development package's lockfile license declaration. Missing declarations remain `UNDECLARED`. The original MIT license and bundled SoundTouch/WebSR notices are retained. These records do not establish redistribution approval; FL-86 retains that gate, including external models, fonts and assets.

The dedicated read-only Actions workflow runs the upstream unit and Node headless contracts, builds twice from separately prepared workspaces, compares artifact digests, and rechecks the complete original snapshot. Both build manifests are retained even on comparison failure, and mismatches report the affected artifact paths. Uploaded provenance is build evidence only after the exact candidate passes. Browser/GPU/media headless tests, full feature conformance, HDR/Dolby qualification and application integration remain separate gates.

No library startup script, web/server entry point or Docker image invokes this build or imports its output. Ordinary Frameleaf library startup therefore does not fetch the Freecut archive or any engine model/font/asset. Launching the standalone upstream editor is outside this isolation guarantee; its resource refusals are tested independently, while complete project-resource admission and offline lifecycle still require qualification before production integration. This slice does not mount or ship that editor.

## Web integration boundary (FL-88)

The Svelte host for the editor is already in the production application. The isolated build
above remains separate from that host until its adapter is implemented:

- `web/src/lib/frameleaf/studio/host-contract.ts` is the typed `mount` / `update` /
  `dispose` contract an adapter must satisfy, plus the data the host passes (project handle,
  authorized media URLs, identity, theme tokens, capabilities, online state) and the services
  it exposes back. The engine receives no token, no API base URL and no SDK.
- `web/src/lib/frameleaf/studio/commands.ts` is the canonical command vocabulary and
  registry; `bridge.ts` validates and routes it.
- `web/src/lib/frameleaf/studio/engine-loader.ts` resolves the engine. The adapter package
  (`studio/adapters/web`, not present) calls `registerStudioEngine` once from its entry
  point. The loader refuses any module whose `engineRevision` is not the pinned commit in
  `freecut-provenance.json`, and the route renders an honest unavailable state until an
  engine registers.

Adapters live outside `vendor/freecut`; nothing in the vendored snapshot is edited, and any
unavoidable patch is recorded as a versioned patch with its licensing note.

## Graph resource inventory (FL-90)

`resource-inventory.json` is the inventory of every resource class a Studio project graph can
reference or a Studio job can produce: library assets, edited masters, project imports, fonts,
LUTs, models, presets, captions, audio, vector graphics, generated intermediates, nested
sequences and remote preview frames. For each class it records the owner, the access check the
server applies, whether the bytes may leave the machine (local, LAN worker, RunPod) and the
retention rule. It is generated from `server/src/utils/studio-resources.ts`, which is the
registry as code; `server/src/utils/studio-resources.spec.ts` fails when the two drift, and

```sh
pnpm --dir server exec tsx src/bin/studio-resource-inventory.ts > studio/resource-inventory.json
```

regenerates it.

`server/src/services/studio-resource.service.ts` is the resolver. Given a project graph and the
acting user it enumerates every reference, applies the library's own access checks (owner,
shared album, partner, Locked exclusion, sensitive and suppressed content), refuses URLs, blob
strings, host paths, traversal, remote fonts and subresources, undeclared imports, cyclic or
over-deep nesting and oversized graphs, and returns an authorized manifest plus the refused
references with reasons. The render (FL-95) and preview (FL-96) paths accept only a complete
manifest the service issued and read source bytes only through its short-lived, revision-bound,
worker-bound grants, which are re-checked against live access on every use. A cloud
destination without recorded consent fails before anything is enumerated. Nothing in this
directory or in the resolver claims that a graph renders; that remains the engine conformance
work.

## Canonical command catalogue (FL-92)

`frameleaf-studio-commands.json` is the published Studio command vocabulary: 88 commands,
each with its payload fields, scope, whether it changes the stored graph, whether it is
undoable, the worker capability it needs, the story that owns its semantics, the prototype
function or pinned Freecut feature that specifies it, and the manifest rows it is the way
to reach.

Payload fields typed `time`, `duration` and `rate` are exact rationals, never floats
(FL-93 / `VID-102`): an instant on the timeline, a length, and a cadence or speed
multiplier. They travel as a reduced `{ num, den }` pair of integers — `StudioTime`,
`StudioDuration` and `StudioRate` on the web side, `isRational` on the server, and
`FrameleafStudioRational` with named integer fields on native. `object` and `object[]`
fields are opaque and travel unread.

The catalogue is the single source for three checked-in contracts:

- `web/src/lib/frameleaf/studio/commands.ts` — the typed web vocabulary FL-88's bridge routes.
- `server/src/utils/studio-commands.generated.ts` — the server mirror used by
  `server/src/utils/studio-commands.ts` to validate an envelope without trusting a client.
- `mobile/lib/frameleaf/studio_commands.g.dart` — the native contract, so a tablet cannot
  express a command the web host and the server do not know.

`scripts/frameleaf-studio-commands.mjs` writes all three and, with no arguments, verifies
them. It fails when a checked-in file is stale, when the web vocabulary drifts from the
catalogue, when a mutating function of the prototype project model
(`design/frameleaf/template/src/studio-project.mjs`) has no command id, or when a row of
`freecut-feature-manifest.json` is neither mapped to a command nor listed in
`nonCommandRows` with a reason and an owner. 182 rows are reachable through a command and
28 are declared non-command rows (module inventories, playback and storage behaviour,
read-only surfaces, host lifecycle).

```sh
node scripts/frameleaf-studio-commands.mjs            # verify, the CI default
node scripts/frameleaf-studio-commands.mjs --write    # regenerate after editing the catalogue
node --test scripts/frameleaf-studio-commands.test.mjs
```

Publishing the vocabulary is not implementing it. Every row names a later story, and the
bridge answers `not-implemented` until that story lands; no command's editing semantics,
renderer or worker admission is delivered by this catalogue.
