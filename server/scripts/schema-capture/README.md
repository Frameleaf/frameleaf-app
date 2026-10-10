# Canonical schema capture and immutable baseline

The runtime and CLI use `src/schema/catalog/desired-schema.catalog.json`. The initial migration reads only `baseline.sql` and verifies its digest. It never imports models or raw helper builders. Missing artifacts are a hard error, not a fallback to a moving baseline.

Before the first freeze, the development workflow explicitly bootstraps an empty disposable PG19 database with `bootstrap-frameleaf-schema.ts --empty-development-database`. This capture-only builder preserves current model, feature, queue, shared-service and import DDL. The production migration does not call it.

Capture these files from the same database and exact committed source:

- `frameleaf-baseline.sql`: `pg_dump --schema-only --no-owner --no-privileges`, PG19.
- `frameleaf-schema-catalog.json` and `frameleaf-capture-source.json`: `tsx scripts/snapshot-frameleaf-schema-catalog.ts <directory>/frameleaf-schema-catalog.json`.
- `frameleaf-raw-metadata.json`: the development workflow's independent `pg_get_constraintdef`/`pg_get_triggerdef` query.

Run `tsx scripts/freeze-frameleaf-schema.ts <capture-directory> <new-output-directory>` on that exact source checkout. It requires PG19, current source hashes, a warning-free full catalog, the manifest schema sentinels, and agreement with raw constraint/trigger metadata. It strips only pg_dump client/session setup and the two provider-owned migration ledgers, preserving application DDL and function bodies. It refuses an existing output directory.

Review and commit the output under `server/src/schema/catalog`. The Nest assets configuration copies the SQL and JSON to the runtime. The development workflow initially exports this bundle under `generated/catalog` and installs it into its disposable source/build tree for hosted validation. That generated bundle is not committed automatically. A follow-up source commit must install the real reviewed artifacts. The bd15 capture predates durable manifests and is not a valid final authority.

Run `tsx scripts/verify-frameleaf-schema.ts <exact-base-commit>` in hosted CI. It checks model/helper hashes, all artifact digests and, once the base contains a frozen baseline, byte-for-byte preservation of the baseline migration, SQL, catalog and manifests. Omit the base only for source/hash verification. CI must provide the PR base SHA to enforce immutable migration history. The normal SQL-tools generation CLI also checks model/helper provenance before generating a migration.

After the initial freeze, append migrations through the common ORDER provider. To author a schema change, apply the intended DDL to a disposable authoring database, capture it on the committed schema-source revision, then run `freeze-frameleaf-schema.ts <capture-directory> server/src/schema/catalog --desired-only`. This updates only the evolving desired catalog/provenance; it verifies and preserves the initial baseline. Generate a migration against an unchanged baseline-plus-existing-migrations database with the SQL-tools CLI, review it, and append it to ORDER. Do not use the mutable bootstrap to replace historical migrations.

Hosted acceptance must replay the pinned baseline and the full migration chain into fresh databases, report no reader warnings/no-op drift, detect and repair an extra application table and missing manifest index, and retain the second-migration runtime/CLI exact-once tests. The authored `frozen-baseline.spec.ts` covers the fresh replay and real drift repair; these checks have not been run locally.
