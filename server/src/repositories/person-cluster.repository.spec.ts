import { readFileSync } from 'node:fs';
import { format } from 'sql-formatter';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

it('keeps cluster mapping and both owner-scoped updates in PostgreSQL', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const newClusterId = '22222222-2222-4222-8222-222222222222';
  const { db, queries } = scriptedKysely(() => ({
    rows: [{ oldId: '33333333-3333-4333-8333-333333333333', newId: '44444444-4444-4444-8444-444444444444' }],
  }));
  try {
    await new PersonRepository(db).reassignCluster({ userId, newClusterId });
    expect(queries.map(({ sql }) => (sql === 'begin' || sql === 'commit' ? sql : 'query'))).toEqual([
      'begin',
      'query',
      'query',
      'commit',
    ]);
    expect(queries[2].sql).toContain('"mapping" as materialized');
    expect(queries[2].sql).toContain('"moved_people" as (update "person"');
    expect(queries[2].sql).toContain('"person"."ownerId" = $4');
    expect(queries[2].sql).toContain('"asset"."ownerId" = $5');
    expect(queries[2].parameters).toEqual([userId, userId, newClusterId, userId, userId]);
    const snapshot = readFileSync(new URL('../queries/person.repository.sql', import.meta.url), 'utf8')
      .split('-- PersonRepository.reassignCluster\n', 2)[1]
      .split('\n\n--', 1)[0];
    expect(snapshot.trim()).toBe(
      queries
        .map(({ sql }) => format(sql, { language: 'postgresql' }))
        .join('\n')
        .trim(),
    );
  } finally {
    await db.destroy();
  }
});
