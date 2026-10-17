import { readFileSync } from 'node:fs';
import { format } from 'sql-formatter';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

const viewer = '11111111-1111-4111-8111-111111111111';
const pairs = [
  { assetId: '22222222-2222-4222-8222-222222222222', personGroupId: '33333333-3333-4333-8333-333333333333' },
  { assetId: '44444444-4444-4444-8444-444444444444', personGroupId: '55555555-5555-4555-8555-555555555555' },
];

it('selects the requested face pairs without forming a cross product', async () => {
  const { db, queries } = scriptedKysely();
  try {
    await new PersonRepository(db).getFacesByIds(pairs, { viewingUserId: viewer });
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('("asset_face"."assetId", "asset_face"."personGroupId") in (($2, $3), ($4, $5))');
    expect(queries[0].sql).toContain('"asset_face"."deletedAt" is null');
    expect(queries[0].sql).toContain('"person"."ownerId" = $1');
    expect(queries[0].parameters).toEqual([
      viewer,
      pairs[0].assetId,
      pairs[0].personGroupId,
      pairs[1].assetId,
      pairs[1].personGroupId,
    ]);
  } finally {
    await db.destroy();
  }
});

it('does not issue a query for an empty selection', async () => {
  const { db, queries } = scriptedKysely();
  try {
    await expect(new PersonRepository(db).getFacesByIds([], { viewingUserId: viewer })).resolves.toEqual([]);
    expect(queries).toEqual([]);
  } finally {
    await db.destroy();
  }
});

it('retains the single-pair SQL contract used by reassignment', async () => {
  const { db, queries } = scriptedKysely();
  try {
    await new PersonRepository(db).getFacesByIds([pairs[0]], { viewingUserId: viewer });
    const snapshot = readFileSync(new URL('../queries/person.repository.sql', import.meta.url), 'utf8')
      .split('-- PersonRepository.getFacesByIds\n', 2)[1]
      .split('\n\n--', 1)[0];
    expect(format(queries[0].sql, { language: 'postgresql' }).trim()).toBe(snapshot.trim());
    expect(queries[0].parameters).toEqual([viewer, pairs[0].assetId, pairs[0].personGroupId]);
  } finally {
    await db.destroy();
  }
});
