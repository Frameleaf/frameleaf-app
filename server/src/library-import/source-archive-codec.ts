import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LibraryImportRefused } from 'src/library-import/state.js';

const checksum = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const EMPTY_SOURCE_ARCHIVE_HASH = checksum('frameleaf-source-archive-v1');
const id = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.includes('\0') && Buffer.from(value).toString() === value);
const base64 = z.string().refine((value) => Buffer.from(value, 'base64').toString('base64') === value);
const numberText = (value: number) => (Object.is(value, -0) ? '-0' : String(value));
const cell = z.union([
  z.null(),
  z.tuple([z.literal('text'), base64.refine((value) => Buffer.from(value, 'base64').length % 2 === 0)]),
  z.tuple([z.literal('integer'), z.string().regex(/^(?:0|-?[1-9]\d*)$/)]),
  z.tuple([
    z.literal('real'),
    z.string().refine((value) => Number.isFinite(Number(value)) && numberText(Number(value)) === value),
  ]),
  z.tuple([z.literal('blob'), base64]),
  z.tuple([z.literal('boolean'), z.boolean()]),
]);
const encodedSchema = z.strictObject({ table: id, fields: z.array(z.tuple([id, cell])) });
export type EncodedSourceArchiveRecord = z.infer<typeof encodedSchema>;
export type SourceArchiveScalar = string | bigint | number | boolean | Uint8Array | null;
export type SourceArchiveRecord = { table: string; value: Record<string, SourceArchiveScalar> };
const credentialColumns = new Set([
  'password',
  'passwd',
  'passwordhash',
  'passworddigest',
  'passwordsalt',
  'passhash',
  'pwhash',
  'salt',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'sessionid',
  'sessiontoken',
  'sessionkey',
  'secret',
  'pincode',
  'passwordlinkhash',
  'logintoken',
  'sharetoken',
  'sharekey',
  'linkpassword',
]);
const refuse = (code = 'SOURCE_ARCHIVE_RECORD_INVALID'): never => {
  throw new LibraryImportRefused(code);
};
const checkColumn = (column: string) => {
  if (credentialColumns.has(column.toLowerCase().replaceAll(/[_-]/g, '')))
    return refuse('SOURCE_ARCHIVE_CREDENTIAL_COLUMN');
};
const parse = (input: unknown): EncodedSourceArchiveRecord => {
  const result = encodedSchema.safeParse(input);
  if (!result.success) return refuse();
  let previous: string | undefined;
  for (const [column] of result.data.fields) {
    if (previous !== undefined && column <= previous) return refuse();
    checkColumn(column);
    previous = column;
  }
  return result.data;
};

/** Archive only qualified credential-free content projections; this is not source schema admission. */
export function encodeSourceArchiveRecord(input: unknown): EncodedSourceArchiveRecord {
  // z.record strips an own __proto__ key; validate the row without rewriting its columns.
  const row = z.custom<Record<string, unknown>>((value) => {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  });
  const result = z.strictObject({ table: id, value: row }).safeParse(input);
  if (!result.success) return refuse();
  const fields: EncodedSourceArchiveRecord['fields'] = Object.entries(result.data.value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([column, value]) => {
      if (!id.safeParse(column).success) return refuse();
      checkColumn(column);
      let encoded: z.infer<typeof cell>;
      if (value === null) encoded = null;
      else if (typeof value === 'string') {
        // UTF-16LE preserves embedded NUL and lone surrogates that PostgreSQL JSONB refuses.
        encoded = ['text', Buffer.from(value, 'utf16le').toString('base64')];
      } else if (typeof value === 'bigint') encoded = ['integer', String(value)];
      else if (typeof value === 'number' && Number.isFinite(value)) encoded = ['real', numberText(value)];
      else if (typeof value === 'boolean') encoded = ['boolean', value];
      else if (value instanceof Uint8Array) encoded = ['blob', Buffer.from(value).toString('base64')];
      else return refuse();
      return [column, encoded];
    });
  return { table: result.data.table, fields };
}

export function decodeSourceArchiveRecord(input: unknown): SourceArchiveRecord {
  const record = parse(input);
  return {
    table: record.table,
    value: Object.fromEntries(
      record.fields.map(([column, value]) => {
        if (value === null) return [column, null];
        switch (value[0]) {
          case 'text': {
            return [column, Buffer.from(value[1], 'base64').toString('utf16le')];
          }
          case 'integer': {
            return [column, BigInt(value[1])];
          }
          case 'real': {
            return [column, Number(value[1])];
          }
          case 'blob': {
            return [column, new Uint8Array(Buffer.from(value[1], 'base64'))];
          }
          case 'boolean': {
            return [column, value[1]];
          }
        }
      }),
    ),
  };
}

export const sourceArchiveRecordFingerprint = (input: unknown): string => checksum(JSON.stringify(parse(input)));

/** Ordered, fixed-width hash chaining permits independent streaming inventory verification. */
export function advanceSourceArchiveHash(previous: string, record: unknown): string {
  if (!/^[a-f0-9]{64}$/.test(previous)) return refuse('SOURCE_ARCHIVE_HASH_INVALID');
  return checksum(
    Buffer.concat([Buffer.from(previous, 'hex'), Buffer.from(sourceArchiveRecordFingerprint(record), 'hex')]),
  );
}
