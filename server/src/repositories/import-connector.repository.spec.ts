import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely';
import { ImportConnectorRepository } from 'src/repositories/import-connector.repository.js';
import { DB } from 'src/schema/index.js';

const connectionId = '0195e2a0-0000-7000-8000-0000000000c0';
const ownerId = '0195e2a0-0000-7000-8000-00000000000a';
const row = {
  id: connectionId,
  ownerId,
  provider: 'webdav',
  displayName: 'NAS',
  sealedCredentials: Buffer.from('sealed'),
  roots: [],
  dailyCheck: true,
  cursor: { position: 1 },
  lastScanAt: null,
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
  busy: false,
};

/** Records each statement and answers the few a scan's start reads from. */
const recordingDb = (released: number) => {
  const statements: string[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>({ sql }: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(sql);
      if (sql.includes('for update')) {
        return Promise.resolve({ rows: [row as R] });
      }
      if (sql.includes('insert into takeout_import')) {
        return Promise.resolve({ rows: [{ id: 'run-2' } as R] });
      }
      if (sql.includes('update import_connection_item')) {
        return Promise.resolve({ rows: [], numAffectedRows: BigInt(released) });
      }
      return Promise.resolve({ rows: [] });
    },
    streamQuery: () => {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => Promise.resolve(),
    commitTransaction: () => Promise.resolve(),
    rollbackTransaction: () => Promise.resolve(),
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements };
};

const operation = () => ({ ownerId }) as never;

describe(ImportConnectorRepository.name, () => {
  describe('startScan', () => {
    it('gives the undownloaded files of a stopped scan back, and lists the source in full', async () => {
      const { db, statements } = recordingDb(9000);
      const started = await new ImportConnectorRepository(db).startScan(connectionId, {} as never, operation);

      expect(started).toEqual({ importId: 'run-2' });
      const release = statements.findIndex((sql) => sql.includes('update import_connection_item'));
      expect(statements[release]).toContain('"fileId" is null');
      expect(statements[release]).toContain("phase = 'scanning'");
      expect(statements[release + 1]).toContain('set cursor = null');
      expect(release).toBeLessThan(statements.findIndex((sql) => sql.includes('insert into takeout_import')));
    });

    it('keeps the stored position when no scan had stopped', async () => {
      const { db, statements } = recordingDb(0);
      await new ImportConnectorRepository(db).startScan(connectionId, {} as never, operation);
      expect(statements.some((sql) => sql.includes('set cursor = null'))).toBe(false);
    });

    it('releases nothing while a job is at work on the connection', async () => {
      const { db, statements } = recordingDb(1);
      row.busy = true;
      try {
        await expect(new ImportConnectorRepository(db).startScan(connectionId, {} as never, operation)).resolves.toBe(
          'busy',
        );
      } finally {
        row.busy = false;
      }
      expect(statements.some((sql) => sql.includes('update import_connection_item'))).toBe(false);
    });
  });
});
