import { AdminAuditAction, UserMetadataKey } from 'src/enum.js';
import { type ImportDatabase, ImportRefused, quote } from 'src/immich-import/types.js';

const BOOTSTRAP_TABLES = new Set([
  'frameleaf_migrations',
  'frameleaf_migrations_lock',
  'job_queue',
  'frameleaf_immich_import',
  'frameleaf_immich_import_checkpoint',
  'frameleaf_immich_import_work',
  'system_metadata',
  'geodata_places',
  'naturalearth_countries',
]);

/** Fresh-destination admission; generic imports may retain one unused setup administrator. */
export async function assertFreshImportDestination(
  destination: ImportDatabase,
  { allowBootstrapAdmin = false }: { allowBootstrapAdmin?: boolean } = {},
): Promise<void> {
  const users = allowBootstrapAdmin
    ? await destination.query(`SELECT id::text,"clusterGroupId"::text,
      ("isAdmin" AND status='active' AND "deletedAt" IS NULL AND NOT "importClaimPending") AS eligible
      FROM public."user" LIMIT 2`)
    : [];
  const admin = users[0];
  if (
    users.length > 1 ||
    (admin && (admin.eligible !== true || typeof admin.id !== 'string' || typeof admin.clusterGroupId !== 'string'))
  )
    throw new ImportRefused('DESTINATION_NOT_FRESH');
  const tables = await destination.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  );
  for (const row of tables) {
    const table = String(row.tablename);
    if (admin) {
      if (table === 'user') continue;
      let records: Record<string, unknown>[] | undefined;
      switch (table) {
        case 'cluster_group': {
          records = await destination.query(
            'SELECT 1 FROM public.cluster_group WHERE id IS DISTINCT FROM $1::uuid LIMIT 1',
            [admin.clusterGroupId],
          );
          break;
        }
        case 'session':
        case 'user_preference_history': {
          records = await destination.query(
            `SELECT 1 FROM public.${quote(table)} WHERE "userId" IS DISTINCT FROM $1::uuid LIMIT 1`,
            [admin.id],
          );
          break;
        }
        case 'user_metadata': {
          records = await destination.query(
            `SELECT 1 FROM public.user_metadata WHERE "userId" IS DISTINCT FROM $1::uuid
              OR key IS DISTINCT FROM $2::text LIMIT 1`,
            [admin.id, UserMetadataKey.Preferences],
          );
          break;
        }
        case 'admin_audit_event': {
          records = await destination.query(
            `SELECT 1 FROM public.admin_audit_event
          WHERE "userId" IS DISTINCT FROM $1::uuid OR "actorId" IS DISTINCT FROM $1::uuid
          OR "libraryId" IS NOT NULL OR action IS DISTINCT FROM $2::text LIMIT 1`,
            [admin.id, AdminAuditAction.AccountCreated],
          );
          break;
        }
        // No default
      }
      if (records) {
        if (records.length > 0) throw new ImportRefused('DESTINATION_NOT_FRESH');
        continue;
      }
    }
    if (table === 'desktop_clip_index' || table === 'desktop_clip_producer') {
      const seeds = await destination.query(`SELECT * FROM public.${quote(table)} LIMIT 2`);
      const seed = seeds[0];
      const pristine =
        seeds.length === 1 &&
        seed.scope === 'unadmitted' &&
        (table === 'desktop_clip_index' ? seed.space === null : seed.key === 'legacy');
      if (!pristine) throw new ImportRefused('DESTINATION_NOT_FRESH');
      continue;
    }
    if (table === 'ml_processing_order') {
      // The FL-456 migration seeds only the default order on a fresh install.
      const seeds = await destination.query(`SELECT scope FROM public.ml_processing_order LIMIT 2`);
      if (seeds.length > 1 || (seeds.length === 1 && seeds[0].scope !== 'default')) {
        throw new ImportRefused('DESTINATION_NOT_FRESH');
      }
      continue;
    }
    if (!BOOTSTRAP_TABLES.has(table)) {
      const records = await destination.query(`SELECT 1 FROM public.${quote(table)} LIMIT 1`);
      if (records.length > 0) {
        throw new ImportRefused('DESTINATION_NOT_FRESH');
      }
    }
  }
  for (const table of ['frameleaf_immich_import_checkpoint', 'frameleaf_immich_import_work']) {
    if ((await destination.query(`SELECT 1 FROM public.${quote(table)} LIMIT 1`)).length > 0) {
      throw new ImportRefused('ORPHANED_IMPORT_JOURNAL');
    }
  }
}
