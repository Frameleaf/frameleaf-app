import { schemaFromCode } from '@frameleaf/sql-tools';
import 'src/schema/index.js';

it('references text primary keys for native index marker foreign keys', () => {
  const schema = schemaFromCode();
  const producer = schema.tables.find((table) => table.name === 'desktop_clip_producer')!;
  expect(producer.constraints).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'foreign-key',
        columnNames: ['scope'],
        referenceTableName: 'desktop_clip_index',
        referenceColumnNames: ['scope'],
      }),
    ]),
  );
  for (const name of [
    'smart_search',
    'smart_search_description',
    'asset_video_duplicate_frame',
    'video_moment_frame_embedding',
  ]) {
    const table = schema.tables.find((table) => table.name === name)!;
    expect(table.constraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'foreign-key',
          columnNames: ['producerAdmissionKey'],
          referenceTableName: 'desktop_clip_producer',
          referenceColumnNames: ['key'],
        }),
      ]),
    );
  }
});
