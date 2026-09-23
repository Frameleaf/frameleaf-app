# Studio preservation contracts

This directory currently contains metadata only. It does not contain an integrated editor, a vendored Freecut checkout, a renderer, a worker, model weights, hardware qualification, or licensed Dolby tools.

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

## Web integration boundary (FL-88)

The Svelte host for the editor is already in the production application, and it does not
depend on this directory containing anything yet:

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
