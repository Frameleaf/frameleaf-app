import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { frozenSource } from 'src/immich-import/adapters.js';
import { connectImportDatabase } from 'src/immich-import/database.js';
import { readSourceStructure, verifySourceStructure } from 'src/immich-import/schema.js';

// Hosted PG19 only: restore immutable upstream structural DDL, then compare PostgreSQL's catalog
// to the static extraction. No upstream container, package, extension indexes or network fetches.
describe('frozen Immich structural catalog on PostgreSQL', () => {
  const name = `source_schema_${randomUUID().replaceAll('-', '')}`;
  let admin: ReturnType<typeof postgres>;
  let connection: ReturnType<typeof connectImportDatabase>;
  beforeAll(async () => {
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    url.pathname = '/postgres';
    admin = postgres(url.href, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    connection = connectImportDatabase(url.href, false);
    const [version] = await connection.db.query("SELECT current_setting('server_version_num')::int AS version");
    expect(Number(version.version)).toBeGreaterThanOrEqual(190_000);
  });
  afterAll(async () => {
    await connection?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    }
  });
  const restore = async (version: string) => {
    await connection.db.query(
      'DROP EXTENSION IF EXISTS vector CASCADE; DROP EXTENSION IF EXISTS "uuid-ossp" CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION "uuid-ossp"; CREATE EXTENSION vector',
    );
    const root = 'src/immich-import/fixtures/structure';
    await connection.db.query(await readFile(`${root}/3.1.0.sql`, 'utf8'));
    if (version !== '3.1.0') {
      await connection.db.query(await readFile(`${root}/${version}-from-3.1.0.sql`, 'utf8'));
    }
  };

  it.each([
    ['3.0.0', ['3.0.0', '3.0.1', '3.0.2', '3.0.3']],
    ['3.1.0', ['3.1.0']],
    ['3.2.0', ['3.2.0', '3.2.1', '3.2.2', '3.2.3', '3.2.4']],
  ] as const)('qualifies the real %s catalog for every stable pin sharing it', async (version, releases) => {
    await restore(version);
    const actual = await readSourceStructure(connection.db);
    for (const release of releases) {
      expect(() => verifySourceStructure(actual, frozenSource(release).structure)).not.toThrow();
    }
  });

  it.each([
    'ALTER TABLE public.asset ALTER COLUMN "ownerId" DROP NOT NULL',
    'ALTER TABLE public.asset ALTER COLUMN "isFavorite" SET DEFAULT true',
    'ALTER TABLE public.asset DROP CONSTRAINT "asset_ownerId_fkey"',
    'ALTER TABLE public.activity DROP CONSTRAINT activity_like_check',
    'DROP INDEX public."UQ_assets_owner_checksum"',
  ])('rejects schema drift before content admission: %s', async (change) => {
    await restore('3.2.0');
    await connection.db.query(change);
    const actual = await readSourceStructure(connection.db);
    expect(() => verifySourceStructure(actual, frozenSource('3.2.4').structure)).toThrow('UNKNOWN_SOURCE_SCHEMA');
  });
});
