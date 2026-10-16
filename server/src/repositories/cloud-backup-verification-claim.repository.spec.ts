import { readFileSync } from 'node:fs';
import { format } from 'sql-formatter';
import { MediaOperationStatus } from 'src/enum.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

const proof = {
  bucket: 'bucket',
  sha256: 'hash',
  operationId: 'operation',
  claimToken: 'claim',
  method: 'sha256-get' as const,
  result: 'passed' as const,
};

it.each([false, true])(
  'checks live claim authority after row locking in one transaction (nested: %s)',
  async (nested) => {
    const { db, queries } = scriptedKysely();
    try {
      if (nested) {
        await db.transaction().execute((tx) => new CloudBackupIndexRepository(tx).recordObjectVerification(proof));
      } else {
        await new CloudBackupIndexRepository(db).recordObjectVerification(proof);
      }
      expect(queries.map(({ sql }) => sql.split(' ', 1)[0])).toEqual(['begin', 'select', 'insert', 'commit']);
      expect(queries[1].sql).toMatch(/for share$/);
      expect(queries[1].parameters).toEqual([proof.operationId, proof.claimToken]);
      const insert = queries[2];
      expect(insert.sql).toContain('"claimExpiresAt" > clock_timestamp()');
      expect(insert.sql).toContain('"cancelRequestedAt" is null');
      expect(insert.sql).toContain('"pauseRequestedAt" is null');
      expect(insert.parameters).toEqual(
        expect.arrayContaining([
          MediaOperationStatus.Preparing,
          MediaOperationStatus.Rendering,
          MediaOperationStatus.Validating,
        ]),
      );
    } finally {
      await db.destroy();
    }
  },
);

it('keeps the generated verification SQL snapshot aligned with the guarded statements', async () => {
  const { db, queries } = scriptedKysely();
  try {
    await new CloudBackupIndexRepository(db).recordObjectVerification(proof);
    const snapshot = readFileSync(new URL('../queries/cloud.backup.index.repository.sql', import.meta.url), 'utf8')
      .split('-- CloudBackupIndexRepository.recordObjectVerification\n', 2)[1]
      .split('\n\n--', 1)[0];
    expect(
      queries
        .map(({ sql }) => format(sql, { language: 'postgresql' }))
        .join('\n')
        .trim(),
    ).toBe(snapshot.trim());
  } finally {
    await db.destroy();
  }
});
