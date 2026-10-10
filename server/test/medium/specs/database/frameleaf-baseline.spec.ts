import { readOrder } from '@frameleaf/sql-tools';
import { sql } from 'kysely';
import { fileURLToPath } from 'node:url';
import { getKyselyDB } from 'test/utils.js';

it('boots one canonical PG19 database with one Frameleaf ledger and HNSW', async () => {
  const db = await getKyselyDB();
  try {
    const version = await sql<{
      version: number;
    }>`SELECT current_setting('server_version_num')::integer AS version`.execute(db);
    expect(version.rows[0].version).toBeGreaterThanOrEqual(190_000);
    expect(version.rows[0].version).toBeLessThan(200_000);
    const schemas = await sql<{
      name: string;
    }>`SELECT nspname AS name FROM pg_namespace WHERE nspname = 'immich_fork'`.execute(db);
    expect(schemas.rows).toEqual([]);
    const ledgers = await sql<{ name: string }>`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'
      AND tablename IN ('frameleaf_migrations', 'kysely_migrations', 'migrations')`.execute(db);
    expect(ledgers.rows.map(({ name }) => name)).toEqual(['frameleaf_migrations']);
    const expectedOrder = readOrder(fileURLToPath(new URL('../../../../src/schema/migrations/', import.meta.url)));
    expect(expectedOrder?.[0]).toBe('0000000000000-FrameleafBaseline');
    const migrations = await sql<{ name: string }>`SELECT name FROM public.frameleaf_migrations ORDER BY name`.execute(
      db,
    );
    expect(migrations.rows.map(({ name }) => name)).toEqual(expectedOrder);
    for (const table of [
      'asset',
      'album',
      'smart_album',
      'physical_file',
      'asset_health',
      'studio_project',
      'icloud_connection',
      'asset_checksum',
      'job',
      'job_run_item',
      'frameleaf_immich_import',
      'frameleaf_upload_lease',
    ]) {
      const present = await sql<{
        present: boolean;
      }>`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`.execute(db);
      expect(present.rows[0].present, table).toBe(true);
    }
    const extensions = await sql<{ name: string }>`SELECT extname AS name FROM pg_extension
      WHERE extname IN ('vector', 'vchord', 'vectors')`.execute(db);
    expect(extensions.rows.map(({ name }) => name)).toEqual(['vector']);
    const indexes = await sql<{ name: string; method: string }>`SELECT c.relname AS name, a.amname AS method
      FROM pg_class c JOIN pg_am a ON a.oid = c.relam WHERE c.relname IN ('clip_index', 'face_index')`.execute(db);
    expect(indexes.rows).toHaveLength(2);
    expect(indexes.rows.every(({ method }) => method === 'hnsw')).toBe(true);
  } finally {
    await db.destroy();
  }
});
