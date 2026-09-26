# Fork schema

Fork migrations (`migrations/`) run in Kysely's ordered mode: a pending migration whose name sorts
before one a database already ran stops the server with "corrupted migrations".

When you add a fork migration, give it a number above the last entry of
`manifests/fork-migration-order.json` and append its name there (never reorder or insert).
`test/medium/specs/fork-schema/fork-migration-order.spec.ts` fails otherwise. A new fork table also
needs its entries in `manifests/fork-v2-catalog.json` and the ledger spec.

## Libraries created by the official server (FL-44)

A database the official v3.1.0 server created is classified `official-origin` on its first
Frameleaf boot. That boot runs only the certified official provider and the `immich_fork`
migrations: the public schema stays exactly the certified tag, and `immich_fork.state` is
`inactive` with schema version `1`. The library is readable but not yet a Frameleaf library, and
startup logs a warning saying so.

`immich-admin fork-schema adopt` (`official-adoption.ts`, `DatabaseRepository.adoptOfficialOrigin`)
completes it in one transaction:

- It refuses anything but an `inactive` / `1` state without Frameleaf tables whose ledger is the
  exact certified tag, optionally followed by an ordered prefix of the post-certified migrations.
- It refuses to run unless maintenance mode is on, and when `pg_stat_activity` shows another
  client backend that holds a transaction, is active, or connects from a different address. Idle
  connections from the admin process's own address (the same Unix socket, a pooler, `docker exec`
  into a server container) cannot be told apart from the admin's own pool. That is why maintenance
  mode is required.
- It sets the phase to `legacy`, the phase a fresh install starts in, so migrations that read the
  phase follow the same rules they follow on a fresh install.
- It applies every missing post-certified upstream migration through its registered apply in
  `post-certified-residue.ts`, and every Frameleaf public migration, in name order. It never runs
  `1779400000000-UpdateWorkflowTables`, whose official original `1778614946174` already ran.
- It repeats the parts of released `immich_fork` migrations that act only once the Frameleaf public
  schema exists (0000000000170, 0000000000172, 0000000000176, 0000000000201, and the face-decision
  carry-over of 0000000000175, which needs ClusterGroups). Those migrations already ran at the
  first boot, before the tables and columns existed.
- It checks that plugin, method and step rows are unchanged and that the workflow count is the same,
  then records an `official-origin-adoption` audit row. For every step that changes or deletes
  official data (`ADOPTION_STEP_COUNTERS`), `details.steps` records table counts taken right
  before and right after it. These are totals, not per-row change records. The operator guide says
  which ones are exact. `docs/docs/administration/upstream-handoff.md` lists these changes for operators.
- Its ledger timestamps follow the latest existing one, so a lagging clock cannot reorder the ledger.

A failure rolls everything back. The certified official server can still read the library, and the
command can be run again. Once it has succeeded, running it again changes nothing.

After adoption the ledger contains Frameleaf names, so startup classifies the database as `legacy`.
The combined provider leaves out `1779400000000` whenever the ledger holds the official marker, so
the rewrite never runs at a later boot either. From there, the normal backfill (`fork-schema start`)
and the certified handoff and return apply unchanged. The cutover sees a `current-fork`
installation whose workflow marker is already official, so it aliases nothing.

Adoption adds no migration. Adding an `immich_fork` migration that only acts when a Frameleaf public
table or column exists requires adding its follow-up step to `applyFrameleafSchemaForkFollowUps`, as well.
Adding a Frameleaf public migration that changes existing official data requires a counter in
`ADOPTION_STEP_COUNTERS` and an entry in the operator documentation.

## Libraries past the certified cutover (FL-180)

The cutover moves every Frameleaf public migration name out of `public.kysely_migrations` into
`immich_fork.migration_audit` (phase `ledger-cutover`, classification `legacy-fork`) and leaves the
Frameleaf public objects in place. From then on startup classifies the library `isolated` and runs
only the certified official provider, which never yields a Frameleaf public migration.

A Frameleaf public migration released after a library's cutover therefore runs through
`isolated-frameleaf-migrations.ts` and `ForkHandoffRepository.applyIsolatedFrameleafMigrations`:

- The library's Frameleaf ledger is its `ledger-cutover` rows plus the rows of phase
  `frameleaf-public`. A bundled Frameleaf public migration in neither is pending
  (`createFrameleafPublicMigrationProvider` yields only `GENERIC_LEGACY_FORK_MIGRATIONS`, never the
  Frameleaf copy of the workflow rewrite or an upstream migration).
- Pending migrations run in name order in one transaction that holds the `immich_fork.state` row,
  each followed by its `frameleaf-public` audit row, then `applyFrameleafSchemaForkFollowUps`. The
  transaction fails if the official ledger changed. Callers hold `DatabaseLock.Migrations`.
- Startup (and a database restore) applies them once the library is active again (`active`, schema
  version 2), before the `immich_fork` migrations. The return (`fork-handoff prepare-fork`) applies
  them after the post-certified residue and before the workflow snapshot and reconciliation. It has
  to: the final activation locks every table `manifests/fork-v2-catalog.json` lists.
- They never run while the library is handed over (`inactive`, schema version 2), so the official
  server starts on exactly the schema the cutover checked. A library that was never cut over, or was
  cut over without the Frameleaf public schema, is left alone. A recorded name this version does not
  bundle refuses startup, like any downgrade.

The certified official ledger is never read for these names, added to or edited. The objects stay in
the public schema across a later handoff, like every Frameleaf public object that existed at the
cutover, and `manifests/fork-v2-catalog.json` expects them. A Frameleaf public migration must
therefore behave in the `active` phase and in the `inactive` phase of a return, where the official
representation is authoritative, as well as in the phases before the cutover. For example,
2100000000320 applied at a return reads the saved `system-config` before the return reconciles the
configuration; at the first start after activation, `ImageEnrichmentService.onConfigInit` locks
the detections it missed when hiding is on and was not recorded as on.

The return boot runs the `immich_fork` migrations of the new version before `prepare-fork` applies
the post-certified residue (for example `asset_face.personGroupId` from
1787148183729-ClusterGroups) and the newer Frameleaf public migrations. An `immich_fork` migration
may therefore touch a public table or column that either of them creates only after checking that
exactly that object exists, and must repeat the step after them: structural steps in
`applyFrameleafSchemaForkFollowUps`, data carry-overs in a guarded, idempotent step that the return
runs (`carryOverEarlierFaceDecisions` does this for 0000000000175).
