import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from 'src/utils/object.js';

const rows = z.array(z.record(z.string(), z.union([z.string(), z.number().int().safe(), z.null()])));
const schema = z.strictObject({
  tables: rows,
  columns: rows,
  indexes: rows,
  constraints: rows,
  keys: rows,
  triggers: rows,
  routines: rows,
  events: rows,
});
const tableNames = new Set(['TABLE_NAME', 'REFERENCED_TABLE_NAME', 'EVENT_OBJECT_TABLE']);
const refuse = (): never => {
  throw new Error('MySQL schema refused: MYSQL_SCHEMA_INVALID');
};

/** Hash complete native metadata; only explicit table-namespace identifiers are prefix independent. */
export const mysqlSchemaFingerprint = (input: unknown, prefix: string): string => {
  if (typeof prefix !== 'string' || !/^(?!\d)[a-zA-Z0-9_$]{0,20}$/u.test(prefix)) refuse();
  const parsed = schema.safeParse(input);
  if (!parsed.success) refuse();
  const normalized = Object.entries(parsed.data!)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([section, records]) => [
      section,
      records
        .map((record) =>
          canonicalJson(
            Object.fromEntries(
              Object.entries(record).map(([key, value]) => {
                if (tableNames.has(key) && value !== null) {
                  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length <= prefix.length)
                    return refuse();
                  return [key, value.slice(prefix.length)];
                }
                return [key, value];
              }),
            ),
          ),
        )
        .sort(),
    ]);
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex');
};
