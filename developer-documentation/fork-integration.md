# Frameleaf integration and validation

Frameleaf maintains its server, schema, SQL tooling, deployment images and release assets independently. Immich stable 3.x through 3.2.4 is a frozen, read-only source for the one-time [offline importer](../docs/docs/administration/import-library.md). Source attribution and pinned dependency checksums remain in the repository; there is no ongoing upstream merge, database handoff or return procedure.

## Ordinary checks

The Test workflow runs server, web, CLI, e2e, workflow and generated-file checks. Cloud integration tests exercise the installed, immutable `@frameleaf/cloud-contracts` package, existing discovery/push/scheduling behavior and credential isolation. Archive size and digests identify the dependency bytes; they do not create a separate approval state. The package retrieval job cannot execute repository code with its registry credential, and consumer jobs have only source-read permissions.

Integration image and native RAW checks exercise the owned runtime. Releases retain build provenance, digest pinning and explicit publication authorization. Passing source tests does not mean that an image was published, a server was deployed or a restore was exercised.

## Manual development artifacts

On `aj/FL-333-pg19` or `master/frameleaf-implementation`, dispatch the existing **Test** workflow with `development_validation=true`. This calls `development-validation.yml` from the same commit and selects development diagnostics instead of the full suite. The reusable workflow can also be dispatched directly once GitHub exposes its workflow definition.

The Linux job generates `pnpm-lock.yaml` with `--lockfile-only --ignore-scripts`, installs that lock, reports server types and lint, builds generators, starts a fresh owned PostgreSQL 19 container, applies the canonical baseline, and regenerates OpenAPI, the TypeScript API client, SQL queries and the schema catalog. Vendored SQL tools require no build step.

The `frameleaf-development-<commit>` artifact contains the source commit, generated files, a binary Git patch, per-step logs and outcomes. Generation continues after independent failures so diagnostics survive; the final job fails unless every required check and generator succeeded. A file copied into an artifact may be unchanged input after a failed generator: consult `step-outcomes.json` before using it.

Review and apply the generated patch in the implementation branch, then run the ordinary full Test workflow without the development flag. This workflow does not push, publish or promote artifacts. Record hosted run conclusions for the exact commit separately from deployment and runtime acceptance.

## Frozen media fixtures

`scripts/checkout-test-assets.sh` consumes the frozen source commit recorded in that script. The dedicated fixture workflow packages that checkout with source attribution into a Frameleaf-owned asset. Tests retain the same fixture provenance without a submodule or floating upstream branch. Publishing an owned asset remains an explicitly authorized release action.
