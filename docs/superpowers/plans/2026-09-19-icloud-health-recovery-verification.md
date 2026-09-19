# iCloud sync and media recovery verification — 2026-09-19

This records the initial implementation checks. The subsequent [pre-push audit](2026-09-19-media-repair-pre-push-audit.md) found defects those fixtures missed, records the fixes, and supersedes the readiness assessment below.

Implemented in the local fork checkout. No production deployment, GitHub Actions run, or live Apple-account sync was performed. The reported production orphan inventory was not scanned or modified.

## Demonstrated behavior

- Locate compares content SHA-256 and content SHA-1, including renamed files with absent/stale size metadata; path SHA-1, filenames, visual similarity, and duration cannot authorize relinking.
- Downloaded originals can repair a matching missing/corrupt managed asset in place by identity. The real PostgreSQL/filesystem fixture generates a PNG, fully decodes it with Sharp, promotes verified bytes, preserves the same asset ID and associations, resolves health findings, and reuses the healthy destination on the second pass.
- Apple original/edit assets use native Stacks. Edit/revert, local-primary preservation, shared original with distinct source edits, and native Live Photo still/motion links have database tests. Hidden motion components can repair independently; Locked/suppressed media remains consent-protected.
- Fork-owned source records, atomic page/checkpoint/session persistence, leases, byte reservations, version refresh, bounded retries, committed outbox replay, and cleanup are exercised with real PostgreSQL and synthetic input. A 500,000-record fixture verifies bounded keyset materialization.
- Album identity/nesting/rename/move and source membership provenance are tested. Partial snapshots cannot remove memberships. Favorite, hidden, and capture-date metadata preserve local changes and native locks.
- API tests use a real Nest HTTP controller with mocked authentication/provider dependencies. Svelte tests render actual components with mocked SDK requests. Go and TypeScript transport tests use synthetic/redacted protocol and stream fixtures; the production bridge imports pinned Rclone APIs.

## Final checks

| Scope | Result |
| --- | --- |
| Focused server unit/HTTP suites | 158 tests across 12 files passed |
| PostgreSQL integration suites | 60 tests across 7 files passed |
| Svelte component tests | 6 passed |
| Server TypeScript | Passed |
| Web TypeScript | Passed |
| Svelte diagnostics | Passed, zero errors/warnings |
| Server Nest build | Passed |
| OpenAPI generation and SDK build | Passed |
| Changed server/web TypeScript and Svelte lint/format | Passed |
| Go bridge race tests and vet | Passed |
| Compose overlay | Previously validated against the release base with fixture configuration |
| Git diff whitespace check | Passed with the verbatim upstream MIT license trailing blank line excepted |

Node was pinned for commands to `/Users/adamtaylor/.local/share/mise/installs/node/24.21.0/bin/node` (abbreviated `node24` below), with the same directory prepended to PATH. Commands ran in the indicated package.

### Server unit and HTTP checks

From `server/`:

```sh
node24 node_modules/vitest/vitest.mjs --config test/vitest.config.mjs run \
  src/repositories/job.repository.spec.ts \
  src/fork-schema/catalog.spec.ts \
  src/repositories/fork-handoff.repository.spec.ts \
  src/controllers/icloud-sync.controller.spec.ts \
  src/services/icloud-sync.service.spec.ts \
  src/services/icloud-staging.service.spec.ts \
  src/services/media-health.service.spec.ts \
  src/services/media-integrity.service.spec.ts \
  src/services/media-recovery.service.spec.ts \
  src/repositories/icloud-transport.repository.spec.ts \
  src/utils/icloud-records.spec.ts src/utils/icloud-sync.spec.ts
node_modules/.bin/tsc --noEmit
node_modules/.bin/nest build
```

### PostgreSQL integration

The local harness used PostgreSQL 16 at `127.0.0.1:55491`, an empty `mich` template, and the existing `getKyselyDB()` isolated database fixture. The temporary Vitest config imported `server/test/vitest.config.medium.mjs`, disabled its Docker global setup, supplied `IMMICH_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:55491/mich`, and included:

- `test/medium/specs/fork-schema/icloud-sync.spec.ts` — 2 tests
- `test/medium/specs/repositories/icloud-sync.repository.spec.ts` — 9 tests
- `test/medium/specs/repositories/icloud-retention.repository.spec.ts` — 7 tests
- `test/medium/specs/repositories/media-recovery.repository.spec.ts` — 18 tests
- `test/medium/specs/repositories/icloud-album.repository.spec.ts` — 9 tests
- `test/medium/specs/repositories/icloud-relations.repository.spec.ts` — 7 tests
- `test/medium/specs/repositories/icloud-metadata.repository.spec.ts` — 8 tests

Executed from `server/`:

```sh
node24 node_modules/vitest/vitest.mjs --config /tmp/immich-all-icloud-vitest.mjs run
```

These suites also remain runnable through the repository's normal medium-test configuration and Docker setup. No production database was used.

### Web, generated client, and bridge

```sh
# server/
node24 dist/bin/sync-open-api.js
# repository root, pinned oazapfts 7.5.0
/Users/adamtaylor/.local/share/mise/installs/npm-oazapfts/7.5.0/bin/oazapfts --optimistic --argumentStyle=object --useEnumType --allSchemas open-api/immich-openapi-specs.json packages/sdk/src/fetch-client.ts
pnpm --filter @immich/sdk build
# web/
node24 node_modules/vitest/vitest.mjs run 'src/routes/(user)/utilities/icloud-sync/ICloudSync.spec.ts'
node_modules/.bin/tsc --noEmit
pnpm run check:svelte
# icloud-bridge/, Go 1.26
/tmp/immich-icloud-rclone-audit/go/bin/go test -race ./... -count=1
/tmp/immich-icloud-rclone-audit/go/bin/go vet ./...
```

Prettier `--write` and ESLint `--fix --max-warnings 0` ran against the changed server TypeScript and web component/route files. GitNexus impact checks and `detect_changes(scope=all)` ran. Its stale graph does not resolve the new connector symbols and produces unrelated name matches; direct source inspection and the targeted regressions provide the scope cross-check. Shared media-health paths remain a high-impact integration surface, not a risk-free change.

## Schema and deployment

Migration `0000000000090-ICloudSync.ts` introduces seven `immich_fork` tables: connections, runs, checkpoints, raw records, resources, albums, and memberships. Catalog/handoff checks preserve dormant connector state and reconcile removed public owners/assets/albums. No connector tables were added to `public`.

The Compose overlay adds a private TLS Go bridge, file-backed bearer/encryption secrets, and a private staging mount. The bridge pins Rclone v1.75.1 at `687d264b689b8c49a67e2e52a8a5e0caa01c04ce` and packages its original MIT notice. No image was built or installed on production.

## Concrete limits and remaining acceptance

- Live iCloud authentication, ADP approval, enumeration/download, and restart behavior need an operator Apple-account run. No live compatibility is claimed.
- Shared Albums/CMM, SMS authentication, Apple adjustment rendering, edited Live Photo pairing, and special slow-motion/HDR edit fidelity are unsupported. Source captions/location/timezone semantics are not verified; existing destination data remains intact.
- New retained edit versions require review beyond 20 distinct fingerprints per source photo. Existing assets and staged recovery bytes are never pruned automatically. Inventories beyond 100 libraries or 10,000 albums fail explicitly.
- Health scan totals include native hidden motion assets; visible-photo statistics use a narrower population. This explains a scope difference, not the exact unexplored production discrepancy.
- The original's hash cannot identify a differently encoded transcode or XMP sidecar. The reported 40,000 orphan files remain a separate production reconciliation; none were deleted.
