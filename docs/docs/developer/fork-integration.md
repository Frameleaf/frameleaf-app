# Fork integration checklist

Use this checklist when bringing upstream changes into `fork/main`. The **Fork integration** workflow runs for pull requests targeting `fork/main`, pushes to that branch, and manual dispatches. It uses the Node version in `.nvmrc`, the frozen pnpm lockfile, and the locked Extism JavaScript/Binaryen and oazapfts tools. It requires no upstream Push-O-Matic app credentials.

## Preserve the fork during a merge

- Record the upstream commit and fork base. Review both sides of each conflict; do not resolve conflicts by replacing whole files with upstream versions.
- Preserve fork routes, DTO fields, privacy filters, jobs, configuration persistence, and client methods. Trace callers when upstream changes a shared contract and retain regression coverage for both behaviors.
- For API changes, regenerate the OpenAPI specification and TypeScript/Dart clients with `mise run //:open-api`. Review generated diffs for missing fork endpoints and fields; do not hand-edit generated clients to hide contract drift.
- Preserve migration identities and released SQL semantics. Keep the exact certified v3.1.0 ledger and catalog gate; a newer upstream version does not automatically become a certified return target. Register and test reversible post-certified changes, including data preservation. Never bypass a fingerprint mismatch or remove migration rows merely to pass a check.

## Run the integration gate

Install the tools pinned in `mise.toml` and use the Node version in `.nvmrc` (Node 24). A working local Docker daemon is required for the medium tests. Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @immich/sdk build
pnpm --filter @immich/plugin-sdk build
pnpm --filter @immich/plugin-core build
pnpm --filter immich build
pnpm --filter immich exec node dist/bin/sync-open-api.js
git diff --exit-code -- open-api/immich-openapi-specs.json
oazapfts --optimistic --argumentStyle=object --useEnumType --allSchemas open-api/immich-openapi-specs.json packages/sdk/src/fetch-client.ts
git diff --exit-code -- packages/sdk/src/fetch-client.ts
pnpm --filter @immich/sdk build
pnpm --filter immich check
pnpm --filter immich lint
pnpm --filter immich test --run
pnpm --filter immich test:medium --run
pnpm --filter immich-web exec svelte-kit sync
pnpm --filter immich-web check:typescript
pnpm --filter immich-web check:svelte
pnpm --filter immich-web test --run
pnpm --filter @immich/cli check
pnpm --filter @immich/cli lint
pnpm --filter @immich/cli test --run
pnpm --filter @immich/cli build
node packages/cli/bin/immich migrate --help
pnpm --filter immich-e2e check
```

The plugin build must produce current `packages/plugin-core/dist/plugin.wasm` before running the medium tests. Those tests exercise actual plugin behavior and local PostgreSQL migrations; stale WASM can give misleading results. The workflow installs only the two WASM build tools and oazapfts in addition to Node and pnpm. It generates OpenAPI from the built server in Nest preview mode, then regenerates the TypeScript client and fails if either tracked file changes. This catches missing runtime DTO imports that type checking alone can miss. The mobile job generates the Dart client before compilation; regenerate it locally after API changes through `mise run //:open-api`.

The mobile job also checks newly required API response fields against the PR base specification, retaining the explicit backward-compatibility patch gate.

The separate mobile job installs the locked Flutter SDK, installs dependencies with the lockfile enforced, regenerates Drift/Pigeon/localization/build-runner output, and runs Dart analysis and Flutter tests for the app and UI package. Dart SDK generation also repairs native enum defaults emitted by the pinned OpenAPI generator; keep that shared generation step rather than editing generated models by hand.

The CLI gate checks both checksum formats and builds the executable before verifying `migrate --help`. The ML job installs frozen CPU test dependencies and runs the mocked suite offline; the three full-model prediction tests remain a separate hardware/model acceptance check. Run it locally from `machine-learning/`:

```sh
uv sync --frozen --extra cpu --group test --no-default-groups
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 MACHINE_LEARNING_TEST_FULL=false .venv/bin/python -m pytest -q
```

## Record the evidence separately

- Require a successful **Fork integration** run for the exact candidate commit. Local results are useful evidence but do not establish that the GitHub runner passed.
- Keep **Fork schema official-container certification** (`.github/workflows/fork-roundtrip.yml`) as the separate gate for real official-container handoff and return. Unit and medium tests do not replace its three certification lanes.
- Record deployment and runtime acceptance independently. A passing integration or certification run does not establish that production was deployed or verified.

The migration-order workflow validates the complete sorted migration inventory and append-only history separately for upstream and fork migrations. This allows new upstream timestamps to precede the fork’s reserved timestamps without renumbering released migrations. CLI publishing and signed mobile release workflows remain upstream-only; fork CLI and mobile validation run in **Fork integration**. Documentation builds and migration checks use the ordinary repository token.
