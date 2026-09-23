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
