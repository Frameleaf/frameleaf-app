import { randomUUID } from 'node:crypto';
import { DatabaseLock, MediaOperationDestination, MediaOperationKind } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { QueueExecution } from 'src/queue/types.js';
import { MediaOperationCreate, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('media operation transaction notifications', () => {
  const fixture = (active = false) => {
    const id = randomUUID();
    const operation: MediaOperationCreate = {
      ownerId: randomUUID(),
      kind: MediaOperationKind.LibraryScan,
      destination: MediaOperationDestination.Local,
      destinationDetail: null,
      label: 'Library scan',
      snapshot: { libraryId: randomUUID() },
      settings: {},
      estimate: null,
      result: null,
    };
    const row = { id, ...operation };
    const { db, queries } = scriptedKysely(({ sql }) => ({
      rows:
        sql.startsWith('insert into') || sql.startsWith('update') || (active && sql.includes('from "media_operation"'))
          ? [row]
          : [],
    }));
    const sut = new MediaOperationRepository(db);
    const notifications: { changes: unknown; lastStatement: string | undefined }[] = [];
    sut.onChange((changes) => {
      notifications.push({ changes, lastStatement: queries.at(-1)?.sql });
    });
    const subject = { key: 'libraryId', value: String(operation.snapshot.libraryId), lock: DatabaseLock.Library };
    return { db, sut, queries, notifications, operation, subject, row };
  };

  it.each(['exclusive', 'subject'] as const)('notifies after its own %s creation commits', async (kind) => {
    const f = fixture();
    const result = await (kind === 'exclusive'
      ? f.sut.createExclusive(f.operation, DatabaseLock.Library)
      : f.sut.createUnlessActive(f.operation, f.subject));
    expect(result).toEqual({ created: f.row });
    expect(f.notifications).toEqual([
      { changes: [{ id: f.row.id, ownerId: f.operation.ownerId }], lastStatement: 'commit' },
    ]);
  });

  it('does not announce creation in an external transaction that rolls back', async () => {
    const f = fixture();
    await expect(
      f.db.transaction().execute(async (tx) => {
        await f.sut.createUnlessActive(f.operation, f.subject, tx);
        throw new Error('caller refused');
      }),
    ).rejects.toThrow('caller refused');
    expect(f.queries.at(-1)?.sql).toBe('rollback');
    expect(f.notifications).toEqual([]);
  });

  it('does not announce completion in an external transaction that rolls back', async () => {
    const f = fixture();
    await expect(
      f.db.transaction().execute(async (tx) => {
        expect(await f.sut.complete(f.row.id, 'claim', { resultAssetId: null }, tx)).toBe(true);
        throw new Error('caller refused');
      }),
    ).rejects.toThrow('caller refused');
    expect(f.queries.at(-1)?.sql).toBe('rollback');
    expect(f.notifications).toEqual([]);
  });

  it('announces validated publication only after commit', async () => {
    const f = fixture(true);
    await expect(f.sut.publishValidated(f.row.id, 'claim', () => Promise.resolve(true))).resolves.toBe('completed');
    expect(f.notifications).toEqual([
      { changes: [{ id: f.row.id, ownerId: f.operation.ownerId }], lastStatement: 'commit' },
    ]);
  });

  it('announces an owned completion after commit', async () => {
    const f = fixture();
    await expect(f.sut.complete(f.row.id, 'claim', { resultAssetId: null })).resolves.toBe(true);
    expect(f.notifications).toEqual([
      { changes: [{ id: f.row.id, ownerId: f.operation.ownerId }], lastStatement: 'commit' },
    ]);
  });

  it('does not announce a rejected validated publication', async () => {
    const f = fixture(true);
    await expect(f.sut.publishValidated(f.row.id, 'claim', () => Promise.resolve(false))).resolves.toBe('rejected');
    expect(f.notifications).toEqual([]);
  });

  it.each(['creation', 'completion'] as const)(
    'defers queue %s notification until its commit observer runs',
    async (kind) => {
      const f = fixture();
      const execution: QueueExecution = {
        claim: {
          id: randomUUID(),
          queue: 'library',
          name: 'scan',
          data: {},
          token: randomUUID(),
          workerId: 'worker',
          attempt: 1,
          runId: null,
          itemKey: null,
          deadlineMs: 60_000,
          startedAt: new Date(),
        },
        signal: new AbortController().signal,
        progress: () => {},
        progressUnits: 0,
        followups: [],
        adoptions: [],
        buffering: false,
      };
      await queueExecution.run(execution, () =>
        f.db.transaction().execute((tx) =>
          publicationTransaction.run(tx, async () => {
            if (kind === 'creation') await f.sut.createUnlessActive(f.operation, f.subject, tx);
            else await f.sut.complete(f.row.id, 'claim', { resultAssetId: null }, tx);
            expect(f.notifications).toEqual([]);
          }),
        ),
      );
      expect(f.notifications).toEqual([]);
      expect(execution.afterCommit).toHaveLength(1);
      for (const notify of execution.afterCommit ?? []) await notify();
      expect(f.notifications).toEqual([
        { changes: [{ id: f.row.id, ownerId: f.operation.ownerId }], lastStatement: 'commit' },
      ]);
    },
  );

  it.each(['exclusive', 'subject'] as const)('does not announce an already-active %s operation', async (kind) => {
    const f = fixture(true);
    const result = await (kind === 'exclusive'
      ? f.sut.createExclusive(f.operation, DatabaseLock.Library)
      : f.sut.createUnlessActive(f.operation, f.subject));
    expect(result).toEqual({ active: f.row });
    expect(f.queries.some(({ sql }) => sql.startsWith('insert into'))).toBe(false);
    expect(f.notifications).toEqual([]);
  });
});
