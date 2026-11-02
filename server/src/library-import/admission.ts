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

/** The same canonical empty-destination admission for every importer family. */
export async function assertFreshImportDestination(destination: ImportDatabase): Promise<void> {
  const tables = await destination.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
  );
  for (const row of tables) {
    const table = String(row.tablename);
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
