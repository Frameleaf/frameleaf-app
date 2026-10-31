import { AssetLockReason } from 'src/enum.js';
import { lockDerivedResults, releaseDerivedResults } from 'src/utils/derivative-locks.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

const SOURCE = '00000000-0000-4000-8000-000000000001';
const RESULT = '00000000-0000-4000-8000-000000000002';
const VERSION = '00000000-0000-4000-8000-000000000003';

describe('derivative locks (FL-106, FL-195 follow-up)', () => {
  it('marks a lock a result takes from its source as inherited', async () => {
    const { db, queries } = scriptedKysely(({ sql }) => {
      if (sql.includes('to_regclass')) {
        return { rows: [{ present: true }] };
      }
      if (sql.includes('SELECT DISTINCT ON')) {
        return { rows: [{ versionId: VERSION, resultAssetId: RESULT, reason: AssetLockReason.Marked }] };
      }
      if (sql.includes('INSERT INTO asset_lock')) {
        return { rows: [] };
      }
      return {};
    });

    await lockDerivedResults(db, [SOURCE]);

    const insert = queries.find(({ sql }) => sql.includes('INSERT INTO asset_lock'))!;
    expect(insert.sql).toContain('"lockedBy", inherited');
    expect(insert.sql).toContain('NULL, true');
  });

  it('releases only inherited result locks of versions with no locked source left', async () => {
    const { db, queries } = scriptedKysely(({ sql, parameters }) => {
      if (sql.includes('to_regclass')) {
        return { rows: [{ present: true }] };
      }
      // only the source was read by a version; nothing was made from the result
      if (sql.includes('SELECT DISTINCT version.id') && JSON.stringify(parameters).includes(SOURCE)) {
        return { rows: [{ versionId: VERSION, resultAssetId: RESULT }] };
      }
      if (sql.includes('DELETE FROM asset_lock')) {
        return { rows: [{ assetId: RESULT }] };
      }
      return {};
    });

    const released = await releaseDerivedResults(db, [SOURCE]);

    expect(released).toEqual([RESULT]);
    const candidates = queries.find(({ sql }) => sql.includes('SELECT DISTINCT version.id'))!;
    // a version with any source still locked keeps its lock
    expect(candidates.sql).toContain('NOT EXISTS');
    expect(candidates.sql).toContain('asset_lock');
    expect(candidates.sql).toContain('livePhotoVideoId');
    const remove = queries.find(({ sql }) => sql.includes('DELETE FROM asset_lock'))!;
    // a lock the owner put on the result directly is never released here
    expect(remove.sql).toContain('inherited = true');
    expect(queries.some(({ sql }) => sql.includes("'null'::jsonb"))).toBe(true);
    // the released result is followed in turn, for exports made from it
    expect(queries.filter(({ sql }) => sql.includes('SELECT DISTINCT version.id'))).toHaveLength(2);
  });

  it('releases nothing while every version made from the source has another locked source', async () => {
    const { db, queries } = scriptedKysely(({ sql }) =>
      sql.includes('to_regclass') ? { rows: [{ present: true }] } : { rows: [] },
    );

    await expect(releaseDerivedResults(db, [SOURCE])).resolves.toEqual([]);
    expect(queries.some(({ sql }) => sql.includes('DELETE FROM asset_lock'))).toBe(false);
  });
});
