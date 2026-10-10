import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { BuddyBackupRepository } from 'src/repositories/buddy-backup.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

it('holds the requeued operation row through Buddy waiting-state publication', async () => {
  const db = await getKyselyDB('fl310_buddy_outage_settlement');
  const directory = await mkdtemp(join(tmpdir(), 'buddy-outage-settlement-'));
  const operations = new MediaOperationRepository(db);
  const buddy = new BuddyBackupRepository(db, undefined as never);
  vi.spyOn(buddy, 'root').mockReturnValue(directory);
  const { promise: barrier, resolve: releasePublication } = Promise.withResolvers<void>();
  const { promise: entered, resolve: enteredPublication } = Promise.withResolvers<void>();
  let settlement: Promise<boolean> | undefined;
  try {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const operation = await operations.create({
      ownerId: user.id,
      kind: MediaOperationKind.BuddyBackup,
      destination: MediaOperationDestination.Local,
      label: 'Buddy outage settlement',
      snapshot: { task: 'verify' },
      settings: {},
    });
    await buddy.update((state) => ({
      ...state,
      run: {
        id: operation.id,
        state: 'capturing',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        uploadedBytes: 0,
        totalBytes: 0,
        objects: 0,
        uploadedObjects: 0,
        error: null,
      },
    }));
    const claim = () =>
      operations.claimNext({ kinds: [MediaOperationKind.BuddyBackup], workerId: 'replacement', leaseMs: 300_000 });
    const first = await claim();
    expect(first!.operation.id).toBe(operation.id);
    settlement = operations.requeue(
      operation.id,
      first!.claimToken,
      { delayMs: 0, returnAttempt: true },
      async (trx) => {
        // The UPDATE succeeded in this transaction, but must not be claimable yet.
        const row = await trx
          .selectFrom('media_operation')
          .select(['status', 'claimToken'])
          .where('id', '=', operation.id)
          .executeTakeFirstOrThrow();
        expect(row).toMatchObject({ status: MediaOperationStatus.Queued, claimToken: null });
        enteredPublication();
        await barrier;
        await buddy.update((state) => ({ ...state, run: { ...state.run!, state: 'waiting-peer' } }), trx);
      },
    );
    await Promise.race([
      entered,
      settlement.then(() => {
        throw new Error('Requeue returned before waiting-state publication');
      }),
    ]);
    // No time delay can bypass the held row: this uses zero retry delay on purpose.
    expect(await claim()).toBeUndefined();
    releasePublication();
    expect(await settlement).toBe(true);
    const replacement = await claim();
    expect(replacement!.operation.id).toBe(operation.id);
    expect(replacement!.operation.attempt).toBe(1);
    expect(
      await operations.reportProgress(operation.id, replacement!.claimToken, {
        status: MediaOperationStatus.Rendering,
        progress: 50,
        processedUnits: 1,
        totalUnits: 2,
      }),
    ).toBe(true);
    await buddy.update((state) => ({ ...state, run: { ...state.run!, state: 'sending' } }));
    expect(
      await operations.requeue(operation.id, first!.claimToken, { delayMs: 0 }, async (trx) => {
        await buddy.update((state) => ({ ...state, run: { ...state.run!, state: 'waiting-peer' } }), trx);
      }),
    ).toBe(false);
    expect((await buddy.state()).run?.state).toBe('sending');
    expect((await buddy.state()).lastVerifiedAt).toBeNull();
  } finally {
    releasePublication();
    try {
      await settlement;
    } finally {
      vi.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
      await db.destroy();
    }
  }
});
