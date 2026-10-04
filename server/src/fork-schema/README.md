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
`inactive` with schema version `1`.

FL-289: swapping the image is the upgrade. Right after those migrations, still inside
`DatabaseService.onBootstrap`'s `DatabaseLock.Migrations` block, startup adopts the library
(`adoptOfficialOrigin({ atBoot: true })`). That block is the first `AppBootstrap` handler, so it
finishes before the queue workers start (`QueueService`, `BootstrapEventPriority.JobService`) and
before the API listens (`configureExpress` runs after module init). A refusal is logged as a warning
naming the connected clients and retried at the next start; it never fails startup. Then the API
worker's `ForkSchemaMigrationService.onBootstrap` (`ForkSchemaAutoStart`, after the queues exist)
decides through `ForkSchemaRepository.beginInitialBackfill`, one transaction that locks the state
row. In `legacy`, an operator pause (the latest of the `fork-schema-backfill-pause` /
`fork-schema-backfill-resume` audit rows, written by `pause` and by `resume`/`start`) leaves the
library alone. Otherwise it moves to `dual-write`: `resumed` when progress rows exist (for example
after a failed seed fell back to legacy), `started` when none do. In `dual-write` every boot re-seeds
the kinds (finished kinds skip; BullMQ keeps one job per kind). A kind with `lastError` is not
re-seeded; startup logs it with the `fork-schema resume` hint. Every other phase is left alone. If
queueing fails after a start or resume, the library returns to `legacy` without a pause record, so the
next start tries again.

A restart mid-batch leaves that kind's claim leased for 15 minutes. When `runBatch` finds a live
claim (`getLiveClaimDelay`) while still in `dual-write`, it re-queues the kind with a BullMQ `delay`
until just after the lease ends; the delayed job takes over the claimed ids through
`claimBatchForMode`'s expired-claim branch. The delayed job keeps the per-kind dedup id: added from
an active batch it is kept (`keepLastIfActive`) and later adds merge into it while it waits
(`src/repositories/fork-schema-job-lifecycle.spec.ts`).

Adoption (`official-adoption.ts`, `DatabaseRepository.adoptOfficialOrigin`; `frameleaf-admin
fork-schema adopt` is the manual form) completes the library in one transaction:

- It refuses anything but an `inactive` / `1` state without Frameleaf tables whose ledger is the
  exact certified tag, optionally followed by an ordered prefix of the post-certified migrations.
- It refuses when `pg_stat_activity` shows another client backend that holds a transaction, is
  active, or connects from a different address. Idle connections from the process's own address (the
  same Unix socket, a pooler, `docker exec` into a server container) cannot be told apart from its own
  pool, so the manual command also requires maintenance mode. The boot adoption does not (it runs as a
  boot migration under the migrations lock) and additionally ignores exactly one kind of backend: one
  waiting, ungranted, for the `DatabaseLock.Migrations` advisory lock (a sibling worker blocked behind
  this boot). Any other lock wait, idle-in-transaction session or active query still refuses.
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

A failure rolls everything back. The certified official server can still read the library, and
adoption is tried again at the next start (or by the command). Once it has succeeded, running it
again changes nothing.

After adoption the ledger contains Frameleaf names, so startup classifies the database as `legacy`.
The combined provider leaves out `1779400000000` whenever the ledger holds the official marker, so
the rewrite never runs at a later boot either. From there, the normal backfill (started automatically,
see above) and the certified handoff and return apply unchanged. The cutover sees a `current-fork`
installation whose workflow marker is already official, so it aliases nothing.

Adoption adds no migration. Adding an `immich_fork` migration that only acts when a Frameleaf public
table or column exists requires adding its follow-up step to `applyFrameleafSchemaForkFollowUps`, as well.
Adding a Frameleaf public migration that changes existing official data requires a counter in
`ADOPTION_STEP_COUNTERS` and an entry in the operator documentation.

`2100000000660-HashSharedLinkPasswords` (FL-161) is one: it replaces the official
`shared_link.password` values with bcrypt hashes and its `down` keeps them, because a hash cannot be
turned back into the password. The official server compares that column as plaintext, so after a
handoff every password-protected link stays locked there (it fails closed, never open) until its
password is set again on the official server. `ADOPTION_STEP_COUNTERS` records
`passwordProtectedLinks` and `plaintextPasswordLinks`; `fork-handoff prepare-official` counts the
links holding a hash and those still holding plaintext apart
(`ForkHandoffRepository.countPasswordProtectedSharedLinks`, inside the checkpoint's own
transaction) and refuses to prepare the checkpoint while hashed ones exist until the operator passes
`--acknowledge-shared-link-passwords`; plaintext ones keep working on the official server. A plaintext
password set on the official server keeps working after the return and is hashed on first use.

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

Every return runs `carryOverEarlierFaceDecisions`, whether or not the library has Frameleaf
migrations to apply or a Frameleaf ledger at all. Faces the official server soft-deleted while it held
the library, including any it soft-deleted while detecting faces again, are therefore recorded as
the owner's `remove` decisions, exactly as adoption and 0000000000175 record them.
