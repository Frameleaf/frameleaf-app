import { IntegrityReport } from 'src/enum.js';
import { IntegrityRepository } from 'src/repositories/integrity.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

it('includes every integrity category, defaults missing groups to zero and ignores unknown groups', async () => {
  const { db, queries } = scriptedKysely(() => ({
    rows: [
      { type: IntegrityReport.MissingFile, count: 12 },
      { type: IntegrityReport.UntrackedFile, count: 3 },
      { type: 'unknown', count: 99 },
    ],
  }));
  try {
    expect(await new IntegrityRepository(db).getIntegrityReportSummary()).toEqual({
      [IntegrityReport.UntrackedFile]: 3,
      [IntegrityReport.MissingFile]: 12,
      [IntegrityReport.ChecksumFail]: 0,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toBe('select "type", count(*) as "count" from "integrity_report" group by "type"');
  } finally {
    await db.destroy();
  }
});
