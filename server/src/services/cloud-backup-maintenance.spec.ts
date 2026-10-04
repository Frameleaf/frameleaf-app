import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Mocked } from 'vitest';
import { CloudBackupStoreError, CloudBackupStoreRepository } from 'src/repositories/cloud-backup-store.repository.js';
import { CloudBackupBucket, CloudBackupMaintenance, emptyVerifyResult } from 'src/services/cloud-backup-maintenance.js';
import { inVerifySlice } from 'src/utils/cloud-backup-retention.js';
import { executionDelay } from 'src/utils/execution-signal.js';
import { OperationDeadlineError, withOperationExecution } from 'src/utils/operation-execution.js';

const hex = (text: string) => createHash('sha256').update(text).digest('hex');

const bucket: CloudBackupBucket = {
  bucketRef: 'https://s3.test/family-backup',
  connection: {
    endpoint: 'https://s3.test',
    region: 'us-east-1',
    bucket: 'family-backup',
    accessKeyId: 'a',
    secretAccessKey: 'b',
  },
  bucketKey: Buffer.alloc(32, 7),
};

/** A manifest naming these hashes (and a dump), made at `iso` (`20260926T030000Z`). */
const manifest = (hashes: string[], dump: string | null = null) =>
  gzipSync(
    JSON.stringify({
      format: 'frameleaf-backup-manifest',
      version: 1,
      instanceId: 'instance-1',
      createdAt: '2026-09-26T03:00:00.000Z',
      database: dump ? { key: dump, sha256: hex(dump), size: 1 } : null,
      assets: Object.fromEntries(
        hashes.map((sha256, index) => [
          `asset-${index}`,
          {
            owner: 'owner-1',
            files: [{ role: 'original', path: `/data/${index}.jpg`, sha256, size: 10, mtime: null }],
          },
        ]),
      ),
      profiles: {},
    }),
  );

/** One run a night for `nights` nights before 2026-09-26, each naming its own object and the shared one. */
const nightlyBucket = (nights: number) => {
  const objects = new Map<string, Buffer>();
  const shared = hex('shared');
  objects.set(`o/${shared}`, Buffer.from('shared'));
  for (let night = 0; night < nights; night++) {
    const day = String(26 - night).padStart(2, '0');
    const own = hex(`night-${night}`);
    objects.set(`o/${own}`, Buffer.from(`night-${night}`));
    objects.set(`m/202609${day}T030000Z.json.gz`, manifest([own, shared], `db/dump-202609${day}.sql.gz`));
    objects.set(`db/dump-202609${day}.sql.gz`, Buffer.from('dump'));
  }
  return objects;
};

describe(CloudBackupMaintenance.name, () => {
  let objects: Map<string, Buffer>;
  let store: Mocked<Pick<CloudBackupStoreRepository, 'listAll' | 'get' | 'delete' | 'head' | 'hashObject'>>;
  let index: Record<string, ReturnType<typeof vi.fn>>;
  let sut: CloudBackupMaintenance;
  const carryOn = () => Promise.resolve(true);

  beforeEach(() => {
    objects = new Map();
    store = {
      listAll: vi.fn<CloudBackupStoreRepository['listAll']>().mockImplementation((_connection, prefix, onPage) => {
        const page = objects
          .entries()
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, body]) => ({ key, size: body.length, etag: null }))
          .toArray();
        return (page.length > 0 ? onPage(page) : Promise.resolve()).then(() => page.length);
      }),
      get: vi.fn().mockImplementation((_connection, key: string) => {
        const body = objects.get(key);
        return body
          ? Promise.resolve(body)
          : Promise.reject(new CloudBackupStoreError('The storage provider refused GET', 404, 'NoSuchKey'));
      }),
      delete: vi.fn().mockImplementation((_connection, key: string) => {
        objects.delete(key);
        return Promise.resolve();
      }),
      head: vi.fn().mockImplementation((_connection, key: string) => {
        const body = objects.get(key);
        return Promise.resolve(body ? { key, size: body.length, etag: '"e"' } : null);
      }),
      hashObject: vi.fn().mockImplementation((_connection, key: string) => {
        const body = objects.get(key);
        return body
          ? Promise.resolve({ size: body.length, sha256: createHash('sha256').update(body).digest('hex') })
          : Promise.reject(new CloudBackupStoreError('missing', 404, 'NoSuchKey'));
      }),
    };
    index = {
      recordObjectVerification: vi.fn().mockResolvedValue(undefined),
      forget: vi.fn().mockResolvedValue(undefined),
      markManifests: vi.fn().mockResolvedValue(0),
    };
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    sut = new CloudBackupMaintenance(store as never, index as never, logger as never);
  });

  describe('operation progress without response bodies', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('keeps full HEAD verification alive between batch checkpoints', async () => {
      objects = nightlyBucket(2);
      for (const key of objects.keys()) {
        if (key.startsWith('o/')) objects.set(key, Buffer.alloc(10));
      }
      // Model completed storage requests on the fake clock; node:timers/promises uses real timers.
      store.head.mockImplementation((_connection, key: string) =>
        new Promise<void>((resolve) => setTimeout(resolve, 60)).then(() => ({
          key,
          size: objects.get(key)!.length,
          etag: null,
        })),
      );
      const checkpoint = vi.fn().mockResolvedValue(true);
      const renew = vi.fn().mockResolvedValue(true);
      const task = withOperationExecution({ renew, pollMs: 10, deadlineMs: 100, idleMs: 100 }, () =>
        sut.verify(bucket, emptyVerifyResult('full', new Date()), checkpoint, {
          operationId: 'verify-1',
          claimToken: 'claim-1',
        }),
      );
      const completion = expect(task).resolves.toMatchObject({ done: true, checked: 5, missing: 0, mismatched: 0 });
      await vi.advanceTimersByTimeAsync(301);
      await completion;
      expect(store.head).toHaveBeenCalledTimes(5);
      expect(store.hashObject).not.toHaveBeenCalled();
      expect(checkpoint).toHaveBeenCalledTimes(1);
      expect(renew).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps bodyless manifest, object and dump deletions alive before their checkpoint', async () => {
      objects = nightlyBucket(5);
      for (let day = 10; day <= 13; day++) {
        objects.set(`db/dump-202609${day}.sql.gz`, Buffer.from('old unreferenced dump'));
      }
      store.delete.mockImplementation((_connection, key: string) =>
        new Promise<void>((resolve) => setTimeout(resolve, 60)).then(() => {
          objects.delete(key);
        }),
      );
      const checkpoint = vi.fn().mockResolvedValue(true);
      const task = withOperationExecution(
        { renew: () => Promise.resolve(true), pollMs: 10, deadlineMs: 100, idleMs: 100 },
        () => sut.prune(bucket, { keepDaily: 3, keepWeekly: 0, keepMonthly: 0 }, false, checkpoint),
      );
      const completion = expect(task).resolves.toMatchObject({ done: true, deleted: 2, dumpsRemoved: 2 });
      await vi.advanceTimersByTimeAsync(361);
      await completion;
      expect(store.delete).toHaveBeenCalledTimes(6);
      expect(checkpoint).toHaveBeenCalledTimes(1);
      expect(objects.has(`o/${hex('shared')}`)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('times out a HEAD that completes no item despite successful heartbeats', async () => {
      objects = nightlyBucket(1);
      let stopped = false;
      store.head.mockImplementation(() =>
        executionDelay(1000)
          .then(() => null)
          .finally(() => {
            stopped = true;
          }),
      );
      const renew = vi.fn().mockResolvedValue(true);
      const task = withOperationExecution({ renew, pollMs: 10, deadlineMs: 100, idleMs: 100 }, () =>
        sut.verify(bucket, emptyVerifyResult('full', new Date()), carryOn, {
          operationId: 'verify-1',
          claimToken: 'claim-1',
        }),
      );
      const rejection = expect(task).rejects.toMatchObject({
        name: 'AbortError',
        cause: expect.any(OperationDeadlineError),
      });
      await vi.advanceTimersByTimeAsync(101);
      await rejection;
      expect(stopped).toBe(true);
      expect(index.recordObjectVerification).not.toHaveBeenCalled();
      expect(renew).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('prune', () => {
    const retention = { keepDaily: 3, keepWeekly: 0, keepMonthly: 0 };

    it('keeps the runs retention keeps and removes only what none of them names', async () => {
      objects = nightlyBucket(5);
      objects.set('frameleaf-backup.json', Buffer.from('{}'));

      const result = await sut.prune(bucket, retention, false, carryOn);

      expect(result).toMatchObject({ done: true, manifestsKept: 3, manifestsRemoved: 2, objectsRemoved: 2 });
      // the kept nights, their objects and the shared object stay; the claim is never touched
      expect(objects.has('m/20260926T030000Z.json.gz')).toBe(true);
      expect(objects.has('m/20260923T030000Z.json.gz')).toBe(false);
      expect(objects.has(`o/${hex('shared')}`)).toBe(true);
      expect(objects.has(`o/${hex('night-2')}`)).toBe(true);
      expect(objects.has(`o/${hex('night-3')}`)).toBe(false);
      expect(objects.has('frameleaf-backup.json')).toBe(true);
      expect(index.markManifests).toHaveBeenCalledWith(
        bucket.bucketRef,
        ['m/20260923T030000Z.json.gz', 'm/20260922T030000Z.json.gz'],
        'pruned',
      );
    });

    it('forgets each object in the index before it deletes it', async () => {
      objects = nightlyBucket(4);

      await sut.prune(bucket, retention, false, carryOn);

      const forgotten = index.forget.mock.invocationCallOrder[0];
      const deletedObject = store.delete.mock.calls.findIndex(([, key]) => key.startsWith('o/'));
      expect(index.forget).toHaveBeenCalledWith(bucket.bucketRef, [hex('night-3')]);
      expect(forgotten).toBeLessThan(store.delete.mock.invocationCallOrder[deletedObject]);
    });

    it('removes nothing in a dry run, and says what it would remove', async () => {
      objects = nightlyBucket(5);
      const before = objects.keys().toArray();

      const result = await sut.prune(bucket, retention, true, carryOn);

      expect(result).toMatchObject({ dryRun: true, done: true, manifestsRemoved: 2, objectsRemoved: 2 });
      expect(objects.keys().toArray()).toEqual(before);
      expect(store.delete).not.toHaveBeenCalled();
      expect(index.forget).not.toHaveBeenCalled();
    });

    it('removes nothing when a kept manifest cannot be read', async () => {
      objects = nightlyBucket(5);
      objects.set('m/20260925T030000Z.json.gz', Buffer.from('damaged'));

      await expect(sut.prune(bucket, retention, false, carryOn)).rejects.toThrow('could not be read');
      expect(store.delete).not.toHaveBeenCalled();
    });

    it('never removes a file whose name is not a manifest’s, an object’s or a dump’s', async () => {
      objects = nightlyBucket(5);
      objects.set('m/notes.txt', Buffer.from('x'));
      objects.set('o/readme', Buffer.from('x'));

      await sut.prune(bucket, retention, false, carryOn);

      expect(objects.has('m/notes.txt')).toBe(true);
      expect(objects.has('o/readme')).toBe(true);
    });

    it('stops at a checkpoint that says so', async () => {
      objects = nightlyBucket(5);

      await expect(sut.prune(bucket, retention, false, () => Promise.resolve(false))).resolves.toBeNull();
    });
  });

  describe('verify', () => {
    it('fetches and checks only this week’s 1/52 of the objects', async () => {
      // ten bytes each, as the manifest records every file
      const bodies = Array.from({ length: 200 }, (_, index) => `file-${String(index).padStart(5, '0')}`);
      const hashes = bodies.map((body) => hex(body));
      for (const [index, sha256] of hashes.entries()) {
        objects.set(`o/${sha256}`, Buffer.from(bodies[index]));
      }
      objects.set('m/20260926T030000Z.json.gz', manifest(hashes));
      const start = emptyVerifyResult('sample', new Date('2026-09-26T04:00:00.000Z'));
      const expected = hashes.filter((sha256) => inVerifySlice(sha256, start.slice));

      const result = await sut.verify(bucket, start, carryOn, { operationId: 'verify-1', claimToken: 'claim-1' });

      expect(store.hashObject).toHaveBeenCalledTimes(expected.length);
      expect(store.head).not.toHaveBeenCalled();
      expect(index.recordObjectVerification).toHaveBeenCalledTimes(expected.length);
      for (const sha256 of expected) {
        expect(index.recordObjectVerification).toHaveBeenCalledWith({
          bucket: bucket.bucketRef,
          sha256,
          operationId: 'verify-1',
          claimToken: 'claim-1',
          method: 'sha256-get',
          result: 'passed',
        });
      }
      expect(result).toMatchObject({
        done: true,
        total: expected.length,
        checked: expected.length,
        missing: 0,
        mismatched: 0,
      });
    });

    it('HEADs every referenced object and dump in the monthly pass', async () => {
      objects = nightlyBucket(2);
      // make every object the size the manifest records
      for (const key of objects.keys()) {
        if (key.startsWith('o/')) {
          objects.set(key, Buffer.alloc(10));
        }
      }

      const result = await sut.verify(bucket, emptyVerifyResult('full', new Date()), carryOn, {
        operationId: 'verify-1',
        claimToken: 'claim-1',
      });

      // the shared object, one per night, and one dump per night
      expect(store.head).toHaveBeenCalledTimes(3 + 2);
      expect(index.recordObjectVerification).toHaveBeenCalledTimes(3);
      expect(index.recordObjectVerification).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'size-head', result: 'passed' }),
      );
      expect(result).toMatchObject({ done: true, checked: 5, missing: 0, mismatched: 0, degradedManifests: 0 });
    });

    it('marks every manifest naming a missing or damaged object degraded, and forgets the object', async () => {
      objects = nightlyBucket(2);
      for (const key of objects.keys()) {
        if (key.startsWith('o/')) {
          objects.set(key, Buffer.alloc(10));
        }
      }
      objects.delete(`o/${hex('shared')}`);
      objects.set(`o/${hex('night-0')}`, Buffer.alloc(3));

      const result = await sut.verify(bucket, emptyVerifyResult('full', new Date()), carryOn, {
        operationId: 'verify-1',
        claimToken: 'claim-1',
      });

      expect(result).toMatchObject({ missing: 1, mismatched: 1, degradedManifests: 2 });
      expect(index.recordObjectVerification).toHaveBeenCalledWith(
        expect.objectContaining({ sha256: hex('shared'), result: 'missing' }),
      );
      expect(index.recordObjectVerification).toHaveBeenCalledWith(
        expect.objectContaining({ sha256: hex('night-0'), result: 'mismatched' }),
      );
      expect(index.forget).toHaveBeenCalledWith(bucket.bucketRef, expect.arrayContaining([hex('shared')]));
      expect(index.markManifests).toHaveBeenCalledWith(
        bucket.bucketRef,
        expect.arrayContaining(['m/20260926T030000Z.json.gz', 'm/20260925T030000Z.json.gz']),
        'degraded',
      );
    });

    it('carries on after its cursor when it resumes', async () => {
      objects = nightlyBucket(2);
      const start = { ...emptyVerifyResult('full', new Date()), cursor: 'f'.repeat(64) };

      const result = await sut.verify(bucket, start, carryOn, { operationId: 'verify-1', claimToken: 'claim-1' });

      // every object hash sorts before the cursor, so only the dumps are left
      expect(store.head).toHaveBeenCalledTimes(2);
      expect(result?.done).toBe(true);
    });
  });
});
