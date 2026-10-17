import { Kysely, sql } from 'kysely';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { CloudBackupService } from 'src/services/cloud-backup.service.js';
import { FrameleafCloudBackup } from 'src/types.js';
import { getKyselyDB } from 'test/utils.js';

describe('Cloud backup metadata across workers', () => {
  let db: Kysely<DB>;
  let metadata: SystemMetadataRepository;
  const key = SystemMetadataKey.FrameleafCloudBackup;
  const state: FrameleafCloudBackup = {
    target: 'byo-s3',
    bucketRef: 'https://s3.test/bucket',
    endpoint: 'https://s3.test',
    region: 'test',
    bucket: 'bucket',
    instanceId: 'instance',
    claimedAt: '2026-10-16T00:00:00Z',
    keyMode: 'server',
    keyFingerprint: 'a'.repeat(64),
  };
  beforeAll(async () => {
    db = await getKyselyDB();
    metadata = new SystemMetadataRepository(db);
  });
  beforeEach(async () => {
    await metadata.set(key, state);
  });
  afterAll(async () => {
    await metadata?.delete(key);
    await db?.destroy();
  });

  const worker = (repository: SystemMetadataRepository) => {
    const logger = LoggingRepository.create();
    const unused = {} as never;
    const service = new CloudBackupService(
      logger,
      unused,
      repository,
      unused,
      new DatabaseRepository(db, logger, unused),
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
    );
    return service as unknown as {
      updateMetadata: (change: (current: FrameleafCloudBackup) => FrameleafCloudBackup) => Promise<void>;
    };
  };

  it.each(['update', 'setup'] as const)(
    'reads the latest state after waiting for a separate worker %s',
    async (method) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const firstMetadata = new SystemMetadataRepository(db);
      vi.spyOn(firstMetadata, 'set').mockImplementation(async (name, value) => {
        entered.resolve();
        await release.promise;
        await metadata.set(name, value);
      });
      const first =
        method === 'update'
          ? worker(firstMetadata).updateMetadata((current) => ({ ...current, lastCheckAt: 'first' }))
          : new DatabaseRepository(db, LoggingRepository.create(), {} as never).withLock(
              DatabaseLock.FrameleafCloudBackup,
              async () => {
                entered.resolve();
                await release.promise;
                await metadata.set(key, { ...state, bucket: 'replacement' });
              },
            );
      let second: Promise<void> | undefined;
      try {
        await Promise.race([entered.promise, first]);
        second = worker(metadata).updateMetadata((current) => ({ ...current, lastFullVerifyAt: 'second' }));
        await vi.waitFor(
          async () => {
            const { rows } = await sql<{ waiting: number }>`SELECT count(*)::int AS waiting FROM pg_locks
          WHERE locktype='advisory' AND classid=0 AND objid=${DatabaseLock.FrameleafCloudBackup}
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND NOT granted`.execute(db);
            expect(rows[0].waiting).toBeGreaterThan(0);
          },
          { timeout: 5000 },
        );
        release.resolve();
        await first;
        await second;
        expect(await metadata.get(key)).toMatchObject({
          lastFullVerifyAt: 'second',
          ...(method === 'update' ? { lastCheckAt: 'first' } : { bucket: 'replacement' }),
        });
      } finally {
        release.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    },
  );
});
