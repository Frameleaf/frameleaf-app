import { Kysely, sql } from 'kysely';

/**
 * FL-1632 (TM-8): new apps no longer register themselves unless the administrator allows it. A server
 * where an app already registered itself, and whose administrator never chose, keeps registration on,
 * so the apps people use there can sign in again after the upgrade.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`INSERT INTO system_metadata (key, value)
    SELECT 'system-config', '{"connectedApps":{"allowRegistration":true}}'::jsonb
    WHERE EXISTS (SELECT 1 FROM oauth_client WHERE dynamic)
    ON CONFLICT (key) DO UPDATE
      SET value = jsonb_set(
        jsonb_set(system_metadata.value, '{connectedApps}', COALESCE(system_metadata.value -> 'connectedApps', '{}'::jsonb)),
        '{connectedApps,allowRegistration}', 'true'::jsonb)
      WHERE system_metadata.value #> '{connectedApps,allowRegistration}' IS NULL`.execute(db);
}

export async function down(): Promise<void> {
  // the saved choice stays: it is what the server did before
}
