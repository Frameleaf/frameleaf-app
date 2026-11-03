import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportDatabase } from 'src/immich-import/types.js';
import { EMPTY_SOURCE_ARCHIVE_HASH } from 'src/library-import/source-archive-codec.js';
import { LibrarySourceArchive } from 'src/library-import/source-archive.js';

const db: ImportDatabase = { query: vi.fn(), transaction: vi.fn() };
const context = {
  binding: {
    operationId: '11111111-1111-4111-8111-111111111111',
    manifestSha256: 'a'.repeat(64),
    planSha256: 'b'.repeat(64),
    source: {
      kind: 'ente' as const,
      version: 'synthetic',
      identity: 'synthetic-account',
      revision: 'snapshot',
      schemaSha256: 'c'.repeat(64),
    },
  },
  destinationId: '22222222-2222-4222-8222-222222222222',
};
beforeEach(() => vi.clearAllMocks());
describe.each(['abc', '1.5', '-1', '01', '9223372036854775808'])('invalid source archive ordinal %s', (value) => {
  it('refuses a descriptor without touching the database', async () => {
    const store = new LibrarySourceArchive(db, context);
    await expect(
      store.begin({ format: 'frameleaf-source-archive', version: 1, rows: value, sha256: EMPTY_SOURCE_ARCHIVE_HASH }),
    ).rejects.toMatchObject({ code: 'SOURCE_ARCHIVE_DESCRIPTOR_INVALID' });
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('refuses an append offset without touching the database', async () => {
    const store = new LibrarySourceArchive(db, context);
    await expect(store.append(value, [{ table: 'photos', value: { id: 1n } }])).rejects.toMatchObject({
      code: 'SOURCE_ARCHIVE_PAGE_INVALID',
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('returns a rejected page promise instead of throwing synchronously', async () => {
    const store = new LibrarySourceArchive(db, context);
    await expect(store.page(value)).rejects.toMatchObject({ code: 'SOURCE_ARCHIVE_PAGE_INVALID' });
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
