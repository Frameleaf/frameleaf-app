import { schemaFromCode } from '@frameleaf/sql-tools';
import { ImmichDatabase } from 'src/schema/index.js';

it('registers durable original bindings and companion read requests independently of owned file paths', () => {
  new ImmichDatabase();
  const names = new Set(schemaFromCode().tables.map(({ name }) => name));
  expect(names.has('source_original')).toBe(true);
  expect(names.has('source_resource_read')).toBe(true);
});

it('registers bounded cache ownership and explicit reader and waiting-consumer lifetimes', () => {
  new ImmichDatabase();
  const tables = schemaFromCode().tables;
  for (const name of ['source_resource_cache', 'source_resource_cache_lease', 'source_resource_read_consumer']) {
    expect(tables.some((table) => table.name === name)).toBe(true);
  }
  const columns = (name: string) =>
    new Set(tables.find((table) => table.name === name)!.columns.map((column) => column.name));
  expect(columns('source_resource_cache').has('restoreHeld')).toBe(true);
  expect(columns('source_resource_cache_lease').has('readerStoppedAt')).toBe(true);
  expect(columns('source_resource_read').has('consumerManaged')).toBe(true);
  expect(columns('source_resource_read_consumer').has('expiresAt')).toBe(true);
});
