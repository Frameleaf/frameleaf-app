import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { connectImportDatabase } from 'src/immich-import/database.js';
import { ImmichImportService } from 'src/immich-import/importer.js';
import { IMMICH_IMPORT_SCHEMA_SQL, assertImmichImportActivated } from 'src/immich-import/state.js';
import { ImportRow } from 'src/immich-import/types.js';

// Hosted PostgreSQL test: real transactions/constraints, deterministic source transport fixture.
// This does not claim full upstream-container qualification.
describe('Immich import PostgreSQL restart boundaries', () => {
  const name = `import_${randomUUID().replaceAll('-', '')}`;
  let admin: ReturnType<typeof postgres>;
  let connection: ReturnType<typeof connectImportDatabase>;
  let importer: ImmichImportService;
  let rows: ImportRow[];
  let interruptAfterCopy = true;
  const owner1 = 'bcab63f5-8747-4227-a821-d013a353e704';
  const owner2 = 'caf67e17-b7df-4f5c-b645-c538285b2e05';

  beforeAll(async () => {
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    url.pathname = '/postgres';
    admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    connection = connectImportDatabase(url.toString(), false);
    await connection.db.query(IMMICH_IMPORT_SCHEMA_SQL);
    await connection.db.query(`CREATE TABLE public.cluster_group(id uuid PRIMARY KEY);
      CREATE TABLE public."user"(id uuid PRIMARY KEY,email text UNIQUE NOT NULL,password text,
      "profileImagePath" text,"clusterGroupId" uuid REFERENCES public.cluster_group(id))`);
    importer = new ImmichImportService(connection.db, connection.db, {
      version: '3.0.0',
      sourceId: 'hosted-fixture',
      writersStopped: true,
      mediaRoots: [{ source: '/source', target: '/target' }],
    });
    Object.defineProperty(importer.source, 'fixture', {
      value: {
        ...importer.source.fixture,
        tables: { user: importer.source.fixture.tables.user },
      },
    });
    vi.spyOn(importer, 'preflight').mockImplementation(async () => {
      const [state] = await connection.db.query('SELECT status FROM public.frameleaf_immich_import');
      return {
        sourceVersion: '3.0.0',
        sourceCommit: 'fixture',
        fingerprint: 'same-source',
        status: state?.status ?? 'fresh',
      };
    });
    vi.spyOn(importer.source, 'batches').mockImplementation(async function* (table, after) {
      if (table !== 'user') {
        return;
      }
      if (after) {
        if (interruptAfterCopy) {
          throw new Error('simulated restart after durable checkpoint');
        }
        return;
      }
      yield rows.map((row) => ({ row, cursor: [String(row.id)] }));
      if (interruptAfterCopy) {
        throw new Error('simulated restart after durable checkpoint');
      }
    });
  });
  afterAll(async () => {
    await connection?.close();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    }
  });

  it('rolls back failed batches and checkpoints, resumes a committed checkpoint without duplicate users, and stays inactive', async () => {
    rows = [
      { id: owner1, email: 'same@example.test', password: 'hash-one', profileImagePath: '' },
      { id: owner2, email: 'same@example.test', password: 'hash-two', profileImagePath: '' },
    ];
    await expect(importer.run()).rejects.toThrow();
    expect(await connection.db.query('SELECT id FROM public."user"')).toHaveLength(0);
    expect(await connection.db.query('SELECT id FROM public.cluster_group')).toHaveLength(0);
    expect(await connection.db.query('SELECT table_name FROM public.frameleaf_immich_import_checkpoint')).toHaveLength(
      0,
    );
    await expect(assertImmichImportActivated(connection.db)).rejects.toThrow('NOT_ACTIVATED');

    rows[1].email = 'different@example.test';
    await expect(importer.run(true)).rejects.toThrow('simulated restart');
    expect(await connection.db.query('SELECT id FROM public."user"')).toHaveLength(2);
    const [checkpoint] = await connection.db.query(
      'SELECT row_count::text AS count,cursor,complete FROM public.frameleaf_immich_import_checkpoint',
    );
    expect(checkpoint).toMatchObject({ count: '2', cursor: [owner2], complete: false });

    interruptAfterCopy = false;
    await importer.run(true);
    expect(await connection.db.query('SELECT password FROM public."user" ORDER BY id')).toEqual([
      { password: 'hash-one' },
      { password: 'hash-two' },
    ]);
    expect((await importer.status()).status).toBe('verifying');
    await expect(assertImmichImportActivated(connection.db)).rejects.toThrow('NOT_ACTIVATED');
    await importer.abandon();
    expect((await importer.status()).status).toBe('abandoned');
    await expect(assertImmichImportActivated(connection.db)).rejects.toThrow('NOT_ACTIVATED');
  });
});
