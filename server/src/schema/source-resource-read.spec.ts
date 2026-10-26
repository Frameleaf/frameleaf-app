import { schemaFromCode } from '@frameleaf/sql-tools';
import { ImmichDatabase } from 'src/schema/index.js';

it('registers durable original bindings and companion read requests independently of owned file paths', () => {
  new ImmichDatabase();
  const names = new Set(schemaFromCode().tables.map(({ name }) => name));
  expect(names.has('source_original')).toBe(true);
  expect(names.has('source_resource_read')).toBe(true);
});
