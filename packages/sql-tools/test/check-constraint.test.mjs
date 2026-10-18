import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schemaDiff } from '../dist/index.js';

const original = `(("inputKind")::text = ANY ((ARRAY['image'::character varying, 'text'::character varying])::text[]))`;
const restored = `(("inputKind")::text = ANY (ARRAY[('image'::character varying)::text, ('text'::character varying)::text]))`;
const schema = (expression, definition) => ({
  databaseName: 'fixture',
  schemaName: 'public',
  parameters: [],
  extensions: [],
  functions: [],
  enums: [],
  overrides: [],
  sequences: [],
  warnings: [],
  tables: [
    {
      name: 'qualification',
      columns: [],
      indexes: [],
      triggers: [],
      synchronize: true,
      constraints: [
        {
          type: 'check',
          name: 'allowed_kind',
          tableName: 'qualification',
          expression,
          synchronize: true,
          ...(definition ? { definition: `CHECK (${expression})` } : {}),
        },
      ],
    },
  ],
});

for (const definition of [true, false]) {
  test(`CHECK comparison accepts PostgreSQL dump/restore cast forms (definition: ${definition})`, () => {
    for (const [before, after] of [
      [original, restored],
      [restored, original],
    ]) {
      assert.deepEqual(schemaDiff(schema(before, definition), schema(after, definition)).items, []);
    }
  });
  test(`CHECK comparison retains real predicate and cast drift (definition: ${definition})`, () => {
    for (const changed of [
      restored.replace("'text'", "'video'"),
      restored.replace('ANY', 'ALL'),
      restored.replace('character varying', 'character varying(4)'),
      restored.replace("'image'", "'im(age)'"),
      restored.replace('::text,', '::varchar,'),
    ]) {
      assert.deepEqual(
        schemaDiff(schema(original, definition), schema(changed, definition)).items.map(({ type }) => type),
        ['ConstraintDrop', 'ConstraintAdd'],
      );
    }
  });
}

test('CHECK comparison never normalizes SQL-looking contents inside quoted literals', () => {
  for (const quote of ["'", '$quoted$']) {
    const literal = (value) => `note <> ${quote}${quote === "'" ? value.replaceAll("'", "''") : value}${quote}`;
    assert.deepEqual(
      schemaDiff(schema(literal(original), true), schema(literal(restored), true)).items.map(({ type }) => type),
      ['ConstraintDrop', 'ConstraintAdd'],
    );
  }
});
