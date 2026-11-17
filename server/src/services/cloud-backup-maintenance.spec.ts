import { type Repository, type Source, backup, memoryStore } from '@frameleaf/backup-core';
import { randomBytes } from 'node:crypto';
import type { CloudBackupBucket } from 'src/services/cloud-backup-maintenance.js';
import { CloudBackupMaintenance, emptyVerifyResult } from 'src/services/cloud-backup-maintenance.js';
import { CLOUD_BACKUP_CATALOG_VERSION } from 'src/utils/cloud-backup-catalog.js';
import { openVault, snapshotObjectKey } from 'src/utils/cloud-backup-vault.js';

const VAULT = '0195a1b2-0000-7000-8000-0000000000ff';
const DAY = 86_400_000;

/** A tree with a catalog and one file: enough for the engine, and for adopting a backup from its catalog. */
const source = (body: Buffer): Source => {
  const catalog = Buffer.from(
    JSON.stringify({
      format: 'frameleaf-backup-manifest',
      version: CLOUD_BACKUP_CATALOG_VERSION,
      instanceId: VAULT,
      createdAt: '2026-11-17T03:00:00.000Z',
      database: null,
      assets: {
        'asset-1': {
          owner: 'owner-1',
          files: [
            {
              role: 'original',
              path: '/x',
              objectKey: 'files/x',
              sha256: 'a'.repeat(64),
              size: body.length,
              mtime: null,
            },
          ],
        },
      },
      profiles: {},
      albums: {},
      people: {},
    }),
  );
  const files: Record<string, Buffer> = { 'catalog/catalog.json': catalog, 'files/x': body };
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    list: async (path) => {
      if (path.length === 0) {
        return ['catalog', 'files'].map((name) => ({
          name,
          type: 'dir',
          mode: 0o755,
          uid: 0,
          gid: 0,
          mtime: 0,
          size: 0,
        }));
      }
      return Object.entries(files)
        .filter(([key]) => key.startsWith(`${path[0]}/`))
        .map(([key, value]) => ({
          name: key.split('/', 2)[1],
          type: 'file' as const,
          mode: 0o644,
          uid: 0,
          gid: 0,
          mtime: 0,
          size: value.length,
        }));
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *read(path) {
      yield files[path.join('/')];
    },
  };
};

describe(CloudBackupMaintenance.name, () => {
  let repository: Repository;
  let bucket: CloudBackupBucket;
  let index: {
    getManifestKeys: ReturnType<typeof vi.fn>;
    adoptManifests: ReturnType<typeof vi.fn>;
    markManifests: ReturnType<typeof vi.fn>;
  };
  let sut: CloudBackupMaintenance;

  /** Backups made `ago` days back, oldest first; each holds a different file, so each holds its own data. */
  const backups = async (...ago: number[]) => {
    const keys: string[] = [];
    for (const [at, days] of ago.entries()) {
      const made = await backup(repository, source(randomBytes(4000)), {
        sequence: at + 1,
        time: new Date(Date.now() - days * DAY),
      });
      keys.push(made.key);
    }
    return keys;
  };

  beforeEach(async () => {
    repository = await openVault(
      memoryStore(),
      { current: 1, keys: { 1: randomBytes(32).toString('base64') } },
      {
        create: true,
      },
    );
    bucket = { bucketRef: 'ref', bucketKey: Buffer.alloc(32), connection: { vaultId: VAULT } } as never;
    index = {
      getManifestKeys: vi.fn().mockResolvedValue(new Set()),
      adoptManifests: vi.fn().mockResolvedValue(0),
      markManifests: vi.fn().mockResolvedValue(0),
    };
    sut = new CloudBackupMaintenance(index as never, { log: vi.fn(), warn: vi.fn() } as never);
  });

  describe('prune', () => {
    it('keeps what the retention settings keep and removes the rest, marking them first', async () => {
      const keys = await backups(40, 20, 0);
      const result = await sut.prune(bucket, repository, { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }, false);

      expect(result).toMatchObject({ task: 'prune', done: true, manifestsKept: 1, manifestsRemoved: 2 });
      expect((await repository.listSnapshots()).map(({ key }) => key)).toEqual([keys[2]]);
      const gone = [keys[0], keys[1]].map((key) => snapshotObjectKey(VAULT, key));
      expect(index.markManifests).toHaveBeenCalledWith('ref', gone, 'pruned');
      // marked before anything was deleted
      expect(index.adoptManifests.mock.invocationCallOrder[0]).toBeLessThan(
        index.markManifests.mock.invocationCallOrder[0],
      );
    });

    it('changes nothing in a dry run, and says what it would remove', async () => {
      const keys = await backups(40, 20, 0);
      const result = await sut.prune(bucket, repository, { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }, true);

      expect(result).toMatchObject({ dryRun: true, manifestsRemoved: 2, deleted: 0 });
      expect((await repository.listSnapshots()).map(({ key }) => key)).toEqual(keys);
      expect(index.markManifests).not.toHaveBeenCalled();
    });

    it('keeps the backup the signed history ends in, whatever the settings say', async () => {
      const keys = await backups(40, 20, 0);
      bucket.connection.trustedManifestHead = snapshotObjectKey(VAULT, keys[1]);
      const result = await sut.prune(bucket, repository, { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }, false);

      expect(result.manifestsKept).toBe(2);
      expect((await repository.listSnapshots()).map(({ key }) => key)).toEqual([keys[1], keys[2]]);
    });

    it('refuses to clean up when the backup the signed history ends in is not in storage', async () => {
      await backups(1);
      bucket.connection.trustedManifestHead = snapshotObjectKey(VAULT, `s/000000000009-${'0'.repeat(16)}`);
      await expect(
        sut.prune(bucket, repository, { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }, false),
      ).rejects.toThrow('clean-up is refused');
    });
  });

  describe('verify', () => {
    it('passes a whole repository, sampling this week’s share of its packs', async () => {
      await backups(1, 0);
      const full = await sut.verify(bucket, repository, emptyVerifyResult('full', new Date()));
      expect(full).toMatchObject({ done: true, missing: 0, mismatched: 0, degradedManifests: 0 });
      expect(full.checked).toBe(full.total);
      expect(full.total).toBeGreaterThan(0);

      const sample = await sut.verify(bucket, repository, emptyVerifyResult('sample', new Date()));
      expect(sample).toMatchObject({ missing: 0, mismatched: 0 });
      expect(index.markManifests).toHaveBeenCalledWith('ref', [], 'degraded');
    });

    it('names a missing piece and marks the kept backups degraded', async () => {
      const keys = await backups(0);
      const [pack] = await repository.store.list('p/');
      await repository.store.delete(pack.key);
      index.markManifests.mockResolvedValue(1);

      const result = await sut.verify(bucket, repository, emptyVerifyResult('full', new Date()));
      expect(result.missing).toBeGreaterThan(0);
      expect(result.degradedManifests).toBe(1);
      expect(index.markManifests).toHaveBeenCalledWith('ref', [snapshotObjectKey(VAULT, keys[0])], 'degraded');
    });
  });

  describe('adopt', () => {
    it('records a stored backup this server has no record of, from its own catalog', async () => {
      const [key] = await backups(0);
      index.adoptManifests.mockResolvedValue(1);
      await expect(sut.adopt(bucket, repository)).resolves.toBe(1);
      expect(index.adoptManifests).toHaveBeenCalledWith('ref', [
        expect.objectContaining({ key: snapshotObjectKey(VAULT, key), assetCount: 1, fileCount: 1, databaseKey: null }),
      ]);
    });

    it('leaves a backup it already knows alone', async () => {
      const [key] = await backups(0);
      index.getManifestKeys.mockResolvedValue(new Set([snapshotObjectKey(VAULT, key)]));
      await sut.adopt(bucket, repository);
      expect(index.adoptManifests).toHaveBeenCalledWith('ref', []);
    });
  });
});
