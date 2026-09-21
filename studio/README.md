# Studio preservation contracts

This directory contains preservation metadata and an explicit isolated engine build. The source archive is recovered only by the preparation command below; the vendor snapshot and generated workspace are not committed. There is no integrated editor, rendering worker, downloaded model weights, hardware qualification or licensed Dolby tools.

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

Use Node 24.21.0 and npm 11.8.0. `engine-build.json` pins the upstream revision, patch hashes, independent npm lockfile and adapted source digest. Versioned patches set the private package identity and toolchain declaration, remove automatic `prepare`, and omit embedded source text from worker source maps. Vite embeds transient asset handles in that text, which otherwise makes identical fresh builds differ. Worker maps retain their mappings, names and source paths; use the preserved source files for debugging. Application maps retain embedded sources. The patches do not alter Freecut feature behavior. This npm workspace is intentionally outside the application's pnpm workspace.

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

No library startup script, web/server entry point or Docker image invokes this build or imports its output. Ordinary Frameleaf library startup therefore does not fetch the Freecut archive or any engine model/font/asset. Launching the standalone upstream editor is outside this isolation guarantee; its external asset behavior must be adapted before production integration. This slice does not mount or ship that editor.
