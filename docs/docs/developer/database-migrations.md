# Database migrations

Frameleaf owns a canonical PostgreSQL 19 schema in `public`. A fresh database starts at `server/src/schema/migrations/0000000000000-FrameleafBaseline.ts`. `server/src/schema/migrations/ORDER` defines the current migration order. The only migration ledger is `public.frameleaf_migrations`; `public.frameleaf_migrations_lock` serializes migration execution.

The baseline includes content tables, Frameleaf features formerly kept in a separate schema, durable job queues, the import journal and transient shared-service tables. The schema catalog generator captures all canonical database objects, including SQL helpers that are not represented by decorated model definitions. Source import copies selected data; it does not copy an Immich migration history or indexes.

Use the vendored `@frameleaf/sql-tools` workspace runtime and CLI. It has no separate build step and does not fetch a maintained upstream tool at runtime. From an installed source checkout with `DB_URL` pointing to a disposable PostgreSQL 19 database:

```sh
pnpm --dir server migrations:run
pnpm --dir server migrations:verify-order
pnpm --dir server exec tsx scripts/snapshot-frameleaf-schema-catalog.ts /absolute/path/frameleaf-schema-catalog.json
```

Keep migration names and released SQL stable. New schema changes need a new migration and an updated ORDER file, plus generated query/catalog changes where applicable. CI verifies the canonical migration order and generated SQL. Use an isolated database for generation; schema-reset commands destroy the selected schema.

Do not revert the canonical baseline in a live installation or edit ledger rows to bypass a mismatch. Restore a matching backup into a fresh database when recovery is required. Review generated changes and hosted diagnostics before adopting them; a generated catalog alone is not a successful migration or recovery check.
