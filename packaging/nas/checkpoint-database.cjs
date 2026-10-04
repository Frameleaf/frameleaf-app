const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const ordered = (left, right) => left < right ? -1 : left > right ? 1 : 0;

// Exact original checkpoint verifier, shared by backup/restore and pre-start rollback.
function verifyDatabaseCheckpoint(plan, name, docker) {
  const sql = (query) => docker(['exec', name, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'qualification', '-c', query]).trim();
  const extensions = JSON.parse(sql(`SELECT json_agg(x ORDER BY x.name COLLATE "C") FROM (SELECT extname AS name, extversion AS version FROM pg_extension) x`));
  assert.deepEqual(extensions, [...plan.extensions].sort((a, b) => ordered(a.name, b.name)), 'Restored extension inventory differs');
  const schema = docker(['exec', name, 'pg_dump', '-U', 'postgres', '-d', 'qualification', '--schema-only', '--no-owner', '--no-privileges']);
  assert.equal(hash(schema.replace(/^\\(?:un)?restrict .*\n/gm, '')), plan.checkpoint.databaseSchemaDigest, 'Restored database schema differs');
  const inventory = JSON.parse(sql(`SELECT coalesce(json_agg(x ORDER BY x.schema COLLATE "C", x."table" COLLATE "C"), '[]'::json) FROM (SELECT schemaname AS schema, tablename AS "table" FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')) x`));
  const tables = plan.checkpoint.tableCounts.map(({ schema, table }) => ({ schema, table })).sort((a, b) => ordered(a.schema, b.schema) || ordered(a.table, b.table));
  assert.deepEqual(inventory, tables, 'Database table inventory differs');
  for (const row of plan.checkpoint.tableCounts) {
    assert.equal(Number(sql(`SELECT count(*) FROM "${row.schema}"."${row.table}"`)), row.count, 'Restored database row count differs');
    const rows = docker(['exec', name, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'qualification', '-c', `COPY (SELECT row_to_json(t)::text FROM "${row.schema}"."${row.table}" t ORDER BY row_to_json(t)::text COLLATE "C") TO STDOUT`]);
    assert.equal(hash(rows), row.dataDigest, 'Restored database table content differs');
  }
  const sequenceInventory = JSON.parse(sql(`SELECT coalesce(json_agg(x ORDER BY x.schema COLLATE "C", x.name COLLATE "C"), '[]'::json) FROM (SELECT schemaname AS schema, sequencename AS name FROM pg_sequences WHERE schemaname NOT IN ('pg_catalog', 'information_schema')) x`));
  const expectedSequences = plan.checkpoint.sequences.map(({ schema, name }) => ({ schema, name })).sort((a, b) => ordered(a.schema, b.schema) || ordered(a.name, b.name));
  assert.deepEqual(sequenceInventory, expectedSequences, 'Restored sequence inventory differs');
  for (const row of plan.checkpoint.sequences) {
    const state = JSON.parse(sql(`SELECT row_to_json(x) FROM (SELECT last_value::text AS "lastValue", is_called AS "isCalled" FROM "${row.schema}"."${row.name}") x`));
    assert.deepEqual(state, { lastValue: row.lastValue, isCalled: row.isCalled }, 'Restored sequence state differs');
  }
}

module.exports = { verifyDatabaseCheckpoint };
