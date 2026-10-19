import { schemaFromDatabase } from '@frameleaf/sql-tools';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { getFrameleafSchema } from 'src/schema/frameleaf-schema.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

vi.mock('@frameleaf/sql-tools', async (original) => ({
  ...(await original<typeof import('@frameleaf/sql-tools')>()),
  schemaFromDatabase: vi.fn(),
}));

const stores = new Set([
  'smart_search',
  'smart_search_description',
  'asset_video_duplicate_frame',
  'video_moment_frame_embedding',
]);

const inspect = async (target: ReturnType<typeof getFrameleafSchema>) => {
  const { db } = scriptedKysely();
  const repository = new DatabaseRepository(
    db,
    { setContext: vi.fn() } as never,
    { getEnv: () => ({ database: { config: {} } }) } as never,
  );
  vi.mocked(schemaFromDatabase).mockResolvedValue(target);
  try {
    return await repository.getSchemaDrift();
  } finally {
    await db.destroy();
  }
};

const resized = (size: number) => {
  const target = getFrameleafSchema();
  for (const table of target.tables) {
    if (stores.has(table.name)) table.columns.find(({ name }) => name === 'embedding')!.length = size;
  }
  return target;
};

it('accepts the captured bootstrap catalog without modifying its authority', async () => {
  const baseline = getFrameleafSchema();
  expect((await inspect(structuredClone(baseline))).items).toEqual([]);
  expect(getFrameleafSchema()).toEqual(baseline);
});

it.each([512, 768, 1024])('accepts all four CLIP stores resized together to supported width %s', async (size) => {
  expect((await inspect(resized(size))).items).toEqual([]);
});

it.each(['mixed-widths', 'unknown-width', 'missing-column', 'nullable', 'wrong-type', 'foreign-column'])(
  'continues to report %s as schema drift',
  async (change) => {
    const target = resized(change === 'unknown-width' ? 333 : 768);
    const table = target.tables.find(({ name }) => name === 'asset_video_duplicate_frame')!;
    const column = table.columns.find(({ name }) => name === 'embedding')!;
    switch (change) {
      case 'mixed-widths': {
        column.length = 1024;
        break;
      }
      case 'missing-column': {
        table.columns = table.columns.filter(({ name }) => name !== 'embedding');
        break;
      }
      case 'nullable': {
        column.nullable = true;
        break;
      }
      case 'wrong-type': {
        column.type = 'text';
        break;
      }
      case 'foreign-column': {
        table.columns.push({ ...column, name: 'foreignEmbedding' });
        break;
      }
      // No default
    }
    expect((await inspect(target)).items.length).toBeGreaterThan(0);
  },
);
