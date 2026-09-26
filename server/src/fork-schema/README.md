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
- It sets the phase to `legacy`, the phase a fresh install starts in, so migrations that read the
  phase follow the same rules they follow on a fresh install.
- It applies every missing post-certified upstream migration through its registered apply in
  `post-certified-residue.ts`, and every Frameleaf public migration, in name order. It never runs
  `1779400000000-UpdateWorkflowTables`, whose official original `1778614946174` already ran.
- It repeats the parts of released `immich_fork` migrations that act only when a Frameleaf public
  table exists (0000000000170, 0000000000172, 0000000000176, 0000000000201). Those migrations
  already ran at the first boot, before the tables existed.
- It checks that plugin, method and step rows are unchanged and that the workflow count is the same,
  then records an `official-origin-adoption` audit row.

A failure rolls everything back. The certified official server can still read the library, and the
command can be run again. Once it has succeeded, running it again changes nothing.

After adoption the ledger contains Frameleaf names, so startup classifies the database as `legacy`.
The combined provider leaves out `1779400000000` whenever the ledger holds the official marker, so
the rewrite never runs at a later boot either. From there, the normal backfill (`fork-schema start`)
and the certified handoff and return apply unchanged. The cutover sees a `current-fork`
installation whose workflow marker is already official, so it aliases nothing.

Adoption adds no migration. Adding a fork migration that only acts when a Frameleaf public table
exists requires adding its follow-up step to `applyAdoptionForkFollowUps`, as well.
