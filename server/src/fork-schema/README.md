# Fork schema

Fork migrations (`migrations/`) run in Kysely's ordered mode: a pending migration whose name sorts
before one a database already ran stops the server with "corrupted migrations".

When you add a fork migration, give it a number above the last entry of
`manifests/fork-migration-order.json` and append its name there (never reorder or insert).
`test/medium/specs/fork-schema/fork-migration-order.spec.ts` fails otherwise. A new fork table also
needs its entries in `manifests/fork-v2-catalog.json` and the ledger spec.
