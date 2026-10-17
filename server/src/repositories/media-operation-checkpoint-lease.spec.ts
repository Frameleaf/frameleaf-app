import { randomUUID } from 'node:crypto';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

describe('verified checkpoint final lease', () => {
  const fixture = (lossAt: 'operation' | 'checkpoint' | 'none', checkpointExists = true) => {
    const operationId = randomUUID();
    const claimToken = randomUUID();
    const checkpointId = randomUUID();
    let expired = false;
    const { db, queries } = scriptedKysely(({ sql }) => {
      if (sql.includes('from "media_operation"')) {
        const rows = sql.includes('clock_timestamp()') && expired ? [] : [{ id: operationId }];
        // Model expiry while the locking read waits, after its predicate was evaluated.
        if (sql.includes('for share') && lossAt === 'operation') expired = true;
        return { rows };
      }
      if (sql.includes('from "media_operation_checkpoint"')) {
        if (lossAt === 'checkpoint') expired = true;
        return { rows: checkpointExists ? [{ id: checkpointId }] : [] };
      }
      return { numAffectedRows: checkpointExists ? 1n : 0n };
    });
    const artifact = {
      sequence: 0,
      chunkKey: 'chunk-0',
      outputPath: '/server/staging/checkpoint',
      outputChecksum: Buffer.alloc(32),
      sizeInBytes: 1000,
    };
    return { sut: new MediaOperationRepository(db), queries, operationId, claimToken, artifact };
  };

  it.each(['operation', 'checkpoint'] as const)(
    'refuses a lease that expires during the %s lock wait',
    async (lossAt) => {
      const f = fixture(lossAt);
      await expect(f.sut.completeCheckpoint(f.operationId, f.claimToken, f.artifact, true)).resolves.toBe(false);
      expect(f.queries.some(({ sql }) => sql.startsWith('update'))).toBe(false);
    },
  );

  it('completes a current verified artifact after locking both identities', async () => {
    const f = fixture('none');
    await expect(f.sut.completeCheckpoint(f.operationId, f.claimToken, f.artifact, true)).resolves.toBe(true);
    const writes = f.queries.filter(({ sql }) => sql.startsWith('update'));
    expect(writes).toHaveLength(1);
    expect(writes[0].parameters).toEqual(expect.arrayContaining([f.operationId, f.claimToken, 'chunk-0', 'pending']));
    expect(f.queries.at(-1)?.sql).toBe('commit');
  });

  it('refuses a missing verified checkpoint', async () => {
    const f = fixture('none', false);
    await expect(f.sut.completeCheckpoint(f.operationId, f.claimToken, f.artifact, true)).resolves.toBe(false);
  });

  it('retains legacy completion without an active-lease requirement', async () => {
    const f = fixture('operation');
    await expect(f.sut.completeCheckpoint(f.operationId, f.claimToken, f.artifact)).resolves.toBe(true);
    expect(f.queries.some(({ sql }) => sql.includes('clock_timestamp()'))).toBe(false);
  });
});
