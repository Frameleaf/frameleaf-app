import { readFileSync } from 'node:fs';
import { format } from 'sql-formatter';
import type { AssetFace } from 'src/database.js';
import { DummyValue } from 'src/decorators.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

const face = (id: string) => ({ id }) as AssetFace;
const visibleId = DummyValue.UUID;
const hiddenId = DummyValue.UUID_1;

it('uses one atomic visibility update with hidden precedence and UUID-array parameters', async () => {
  const { db, queries } = scriptedKysely();
  try {
    await new PersonRepository(db).updateVisibility([face(visibleId), face(hiddenId)], [face(hiddenId)]);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toBe(
      'update "asset_face" set "isVisible" = not "asset_face"."id" = any($1::uuid[]) where "asset_face"."id" = any($2::uuid[])',
    );
    expect(queries[0].parameters).toEqual([`{${hiddenId}}`, `{${visibleId},${hiddenId},${hiddenId}}`]);
    const snapshot = readFileSync(new URL('../queries/person.repository.sql', import.meta.url), 'utf8')
      .split('-- PersonRepository.updateVisibility\n', 2)[1]
      .split('\n\n--', 1)[0];
    expect(format(queries[0].sql, { language: 'postgresql' }).trim()).toBe(snapshot.trim());
  } finally {
    await db.destroy();
  }
});

it('uses a fixed parameter count for selections larger than the driver parameter limit', async () => {
  const { db, queries } = scriptedKysely();
  try {
    await new PersonRepository(db).updateVisibility(
      Array.from({ length: 65_536 }, () => face(visibleId)),
      [],
    );
    expect(queries).toHaveLength(1);
    expect(queries[0].parameters).toHaveLength(2);
    expect(queries[0].parameters[0]).toBe('{}');
  } finally {
    await db.destroy();
  }
});

it('does not issue a query for an empty visibility change', async () => {
  const { db, queries } = scriptedKysely();
  try {
    await new PersonRepository(db).updateVisibility([], []);
    expect(queries).toEqual([]);
  } finally {
    await db.destroy();
  }
});
