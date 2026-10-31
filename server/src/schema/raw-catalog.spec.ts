import type { DatabaseSchema } from '@frameleaf/sql-tools';
import { verifyRawCatalog } from 'src/schema/raw-catalog.js';

// Deliberately minimal reader/metadata fixtures, never installed as the production authority.
const catalog = {
  tables: [
    {
      name: 'sample',
      columns: [{ name: 'id', nullable: false }],
      constraints: [{ name: 'sample_pk', definition: 'PRIMARY KEY (id)' }],
      triggers: [],
    },
  ],
} as unknown as DatabaseSchema;
const raw = {
  constraints: [
    { schema: 'public', table: 'sample', name: 'sample_pk', definition: 'PRIMARY KEY (id)' },
    { schema: 'public', table: 'sample', name: 'sample_nn', definition: 'NOT NULL id' },
  ],
  triggers: [],
};

it('checks exact raw constraint definitions and PG19 column nullability', () => {
  expect(() => verifyRawCatalog(catalog, raw)).not.toThrow();
  const changed = structuredClone(catalog);
  changed.tables[0].columns[0].nullable = true;
  expect(() => verifyRawCatalog(changed, raw)).toThrow('NOT NULL');
  expect(() => verifyRawCatalog(catalog, { ...raw, constraints: [] })).toThrow('incomplete');
  const unknown = structuredClone(raw);
  unknown.constraints[0].definition = 'PRIMARY KEY (other)';
  expect(() => verifyRawCatalog(catalog, unknown)).toThrow('differs');
  const incomplete = structuredClone(catalog);
  delete incomplete.tables[0].constraints[0].definition;
  expect(() => verifyRawCatalog(incomplete, raw)).toThrow('Catalog lacks exact definition for sample.sample_pk');
});
