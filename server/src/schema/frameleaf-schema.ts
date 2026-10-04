import { schemaFromCode } from '@frameleaf/sql-tools';
import type { DatabaseSchema } from '@frameleaf/sql-tools';
import 'src/schema/index.js';
import { immich_uuid_v7 } from 'src/schema/functions.js';

/** Frameleaf owns this model and its migrations independently of import source versions. */
export const getFrameleafSchema = (): DatabaseSchema =>
  schemaFromCode({
    databaseName: 'frameleaf',
    schemaName: 'public',
    namingStrategy: 'default',
    overrides: false,
    uuidFunction: (version) => (version === 7 ? `${immich_uuid_v7.name}()` : 'uuid_generate_v4()'),
  });

export const getFrameleafBaselineSchema = (): DatabaseSchema => {
  const schema = getFrameleafSchema();
  // Runtime model changes can resize embeddings. Fresh installation still needs the columns and indexes.
  for (const table of schema.tables) {
    for (const column of table.columns) column.synchronize = true;
    for (const index of table.indexes) index.synchronize = true;
  }
  return schema;
};
