import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `${JSON.stringify(value)}::jsonb` stores a jsonb *string*, not the object: postgres.js types the
 * parameter as jsonb and JSON-encodes the already-serialized text a second time. Cast through text
 * (`::text::jsonb`) or pass the value itself.
 */
const doubleEncoded = /\$\{\s*JSON\.stringify\((?:[^()]|\([^()]*\))*\)\s*\}\s*::\s*jsonb/g;

const findDoubleEncodedJsonb = (source: string): number[] =>
  source
    .matchAll(doubleEncoded)
    .map(({ index }) => source.slice(0, index).split('\n').length)
    .toArray();

describe('raw jsonb parameters', () => {
  it('recognizes the double-encoding form and allows the text cast', () => {
    expect(findDoubleEncodedJsonb('sql`${JSON.stringify(value)}::jsonb`')).toEqual([1]);
    expect(findDoubleEncodedJsonb('sql`\n  ${JSON.stringify(input.recipe)} :: jsonb`')).toEqual([2]);
    expect(findDoubleEncodedJsonb('sql`${JSON.stringify(pick(value))}::jsonb`')).toEqual([1]);
    expect(findDoubleEncodedJsonb('sql`${JSON.stringify(value)}::text::jsonb`')).toEqual([]);
    expect(findDoubleEncodedJsonb('sql`${value}::jsonb`')).toEqual([]);
  });

  it('never casts JSON.stringify output straight to jsonb in server source', () => {
    const offenders = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .flatMap((file) => {
        const path = join(root, file);
        return findDoubleEncodedJsonb(readFileSync(path, 'utf8')).map(
          (line) => `${relative(join(root, '..'), path)}:${line}`,
        );
      });

    expect(offenders).toEqual([]);
  });
});
