import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import z from 'zod';
import { canonicalJson } from 'src/utils/object.js';

const queryHash = z.string().regex(/^[a-f0-9]{64}$/);
const cursorSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('text'),
    queryHash,
    id: z.uuid(),
    kind: z.enum(['asset', 'bookmark']),
    after: z.discriminatedUnion('sort', [
      z.strictObject({ sort: z.literal('added'), value: z.iso.datetime() }),
      z.strictObject({ sort: z.literal('color'), value: z.number().min(0).max(3) }),
    ]),
  }),
  z.strictObject({ mode: z.literal('smart'), queryHash, universeHash: queryHash, offset: z.int().min(0).max(1000) }),
]);
export type LibraryCursor = z.infer<typeof cursorSchema>;
export const libraryQueryHash = (query: unknown): string =>
  createHash('sha256')
    .update(canonicalJson(JSON.parse(JSON.stringify(query) ?? 'null')))
    .digest('hex');
export const encodeLibraryCursor = (cursor: LibraryCursor): string =>
  Buffer.from(JSON.stringify(cursorSchema.parse(cursor))).toString('base64url');
export function decodeLibraryCursor(cursor: string | undefined, expectedHash: string): LibraryCursor | undefined {
  if (!cursor) return;
  let parsed: LibraryCursor;
  try {
    if (cursor.length > 1024) throw new Error('Cursor too long');
    parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
  if (parsed.queryHash !== expectedHash) throw new BadRequestException('Search changed; restart pagination');
  return parsed;
}
