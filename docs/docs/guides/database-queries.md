# Database inspection

Use the application, [Library Care](/features/library-care) and [server commands](/administration/server-commands) for routine administration. Direct SQL bypasses application privacy rules and can expose every account's data. Use it only as a server administrator, keep results private and avoid modifying application tables.

For a manual installation using release container names and defaults:

```sh
docker exec -it frameleaf_postgres psql --username=postgres --dbname=frameleaf
```

Use your actual database name and user if different. Manager installations generate their own credentials and container names; use their private recovery configuration to identify the correct installation.

Start a read-only transaction before inspection:

```sql
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT current_database(), version();
SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
ROLLBACK;
```

For a table's current columns, use `\d public.asset` in `psql`. Frameleaf's canonical schema is release-specific; historical examples from other applications may use different column names or privacy rules.

Do not delete migration ledger rows, edit ownership or sharing records, or remove assets using SQL to resolve a user-interface problem. Preserve a backup and diagnose the application error. See [Backup and restore](/administration/backup-and-restore) for recovery.
