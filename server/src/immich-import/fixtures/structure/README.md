# Frozen structural evidence

These files are passive fixtures. Production import reads only the JSON catalogs;
it never restores this SQL or executes upstream migrations.

- `upstream-3.1.0.sql.gz.base64` is the existing exact-tag PostgreSQL 14.19 dump
  copied from the repository's previous official-schema fixture. The pinned tag
  commit is `8aa95c67470a02a8ddedf03c2e52963af33065ff`.
- `3.1.0.sql` extracts its enum definitions, UUID default function, table columns,
  primary/foreign/check/unique constraints, unique indexes and identity definition.
  It excludes rows, triggers, nonunique indexes and extension DDL. Hosted PG19 tests
  supply pgvector and uuid-ossp themselves. These omissions do not change the
  catalogs compared by the importer.
- `3.0.0-from-3.1.0.sql` reverses the one structural column difference, introduced
  by `1784647658615-AddOAuthBearerTokenToSession` at 3.1.0. Other 3.0.x/3.1 changes
  concern data/preferences, which are copied as stored values.
- `3.2.0-from-3.1.0.sql` retains the exact structural SQL from the five included
  `.ts.txt` migrations at commit `db355f79d910bbfc6378117ed10868493c97b922`.
  3.2.0 through 3.2.4 have the same structural schema and migration-name set.
- The three JSON files statically transcribe that DDL. Table and column sets were
  cross-checked against each pinned tag's declarations. `migration_overrides` is
  created by SQL tools rather than decorators and is included from the dump.
- `provenance.json` records original upstream file paths, immutable commit IDs,
  source hashes and extracted SQL hashes. Text fixtures include original up/down
  functions as evidence; the test executes only the extracted structural SQL.

The hosted `test/medium/specs/immich-import/source-schema.spec.ts` restores the
structural SQL into isolated PostgreSQL 19 databases and compares PostgreSQL's
actual catalog with every supported release's JSON fixture. Negative cases remove
or alter real constraints/defaults/nullability. Static extraction does not itself
prove those tests pass; no database or test was run locally during preparation.

CLIP's vector dimension is intentionally variable because upstream changes it
when its configured model changes. Its actual typmod is fingerprinted and checked
for transfer separately. Index fillfactor is physical tuning, not constraint
semantics. Other column types/defaults/nullability, identity/generated state,
enums, constraints and free-standing unique indexes must match.

Full source triggers/functions and nonunique/extension-specific indexes are not
executed or imported. Source runtime semantics are not adopted by the destination;
Frameleaf uses its own canonical schema and code.
