import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopTranscodeRepository } from 'src/repositories/desktop-transcode.repository.js';
import { lockDesktopWorker, readDesktopAssistancePolicy } from 'src/repositories/desktop-worker.repository.js';

vi.mock('src/repositories/desktop-worker.repository.js', () => ({
  lockDesktopWorker: vi.fn(),
  readDesktopAssistancePolicy: vi.fn(),
}));

const deviceId = '44444444-4444-4444-8444-444444444444';
const ownerId = '33333333-3333-4333-8333-333333333333';
const otherId = '55555555-5555-4555-8555-555555555555';
const id = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';
const grant = { deviceId, sessionId: id, authorizationEpoch: 1, credentialHash: Buffer.alloc(32) };
const on = { version: 1, accounts: {}, transcodeEnabledDevices: [deviceId] };
const off = { version: 1, accounts: {} };

/** A query that answers with the next queued row, whatever was asked. */
const database = (answers: unknown[]) => {
  const set = vi.fn();
  const query: Record<string, unknown> = {};
  for (const name of ['selectFrom', 'updateTable', 'select', 'selectAll', 'where', 'orderBy', 'limit', 'forUpdate']) {
    query[name] = () => query;
  }
  query.$if = () => query;
  query.skipLocked = () => query;
  query.returningAll = () => query;
  query.set = (values: unknown) => {
    set(values);
    return query;
  };
  const next = () => Promise.resolve(answers.shift());
  query.executeTakeFirst = next;
  query.executeTakeFirstOrThrow = next;
  query.transaction = () => ({ execute: (run: (tx: unknown) => unknown) => run(query) });
  return { db: query, set };
};

describe(DesktopTranscodeRepository.name, () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(lockDesktopWorker).mockResolvedValue({ ownerId } as never);
  });

  describe('claim (FL-1761)', () => {
    it('gives a computer that is off no work, not even a lease it holds', async () => {
      vi.mocked(readDesktopAssistancePolicy).mockResolvedValue(off as never);
      const { db, set } = database([{ id, ownerId }]);
      await expect(new DesktopTranscodeRepository(db as never).claim(grant, 1000)).resolves.toBeUndefined();
      expect(set).not.toHaveBeenCalled();
    });

    it('does not return a held lease on someone else’s video after the everyone permission went', async () => {
      vi.mocked(readDesktopAssistancePolicy).mockResolvedValue(on as never);
      const { db } = database([{ id, ownerId: otherId }]);
      await expect(new DesktopTranscodeRepository(db as never).claim(grant, 1000)).resolves.toBeUndefined();
    });

    it('starts a new claim at zero progress', async () => {
      vi.mocked(readDesktopAssistancePolicy).mockResolvedValue(on as never);
      const { db, set } = database([undefined, { id }, { id, ownerId }]);
      await expect(new DesktopTranscodeRepository(db as never).claim(grant, 1000)).resolves.toMatchObject({ id });
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ progress: 0, processedUnits: '0' }));
    });
  });

  describe('getClaimed (FL-1761)', () => {
    it('refuses a computer that was turned off', async () => {
      vi.mocked(readDesktopAssistancePolicy).mockResolvedValue(off as never);
      const { db } = database([{ id, ownerId }]);
      await expect(
        new DesktopTranscodeRepository(db as never).getClaimed(grant, id, claimToken),
      ).resolves.toBeUndefined();
    });

    it('keeps a computer that is on', async () => {
      vi.mocked(readDesktopAssistancePolicy).mockResolvedValue(on as never);
      const { db } = database([{ id, ownerId }]);
      await expect(
        new DesktopTranscodeRepository(db as never).getClaimed(grant, id, claimToken),
      ).resolves.toMatchObject({ id });
    });
  });

  describe('getByUploadToken (FL-1761)', () => {
    const operation = { id, ownerId, claimedBy: `desktop:${deviceId}:1` };

    it('stops the upload of a computer that was turned off', async () => {
      vi.mocked(readDesktopAssistancePolicy).mockResolvedValue(off as never);
      const { db } = database([operation, { userId: ownerId }]);
      await expect(new DesktopTranscodeRepository(db as never).getByUploadToken(id, 'hash')).resolves.toBeUndefined();
    });

    it('stops the upload of a revoked computer', async () => {
      vi.mocked(readDesktopAssistancePolicy).mockResolvedValue(on as never);
      const { db } = database([operation, undefined]);
      await expect(new DesktopTranscodeRepository(db as never).getByUploadToken(id, 'hash')).resolves.toBeUndefined();
    });

    it('lets a computer that is on carry on', async () => {
      vi.mocked(readDesktopAssistancePolicy).mockResolvedValue(on as never);
      const { db } = database([operation, { userId: ownerId }]);
      await expect(new DesktopTranscodeRepository(db as never).getByUploadToken(id, 'hash')).resolves.toEqual(
        operation,
      );
    });
  });
});
