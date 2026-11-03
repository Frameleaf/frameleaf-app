import { decodeLibraryCursor, encodeLibraryCursor, libraryQueryHash } from 'src/utils/library-search-cursor.js';

it('binds a complete cursor to its query and retains sub-millisecond timestamp precision', () => {
  const hash = libraryQueryHash({ filter: { libraryScope: 'design' }, userId: 'owner', query: 'green' });
  const cursor = {
    mode: 'text' as const,
    queryHash: hash,
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'asset' as const,
    after: { sort: 'added' as const, value: '2026-10-28T12:00:00.123456Z' },
  };
  expect(decodeLibraryCursor(encodeLibraryCursor(cursor), hash)).toEqual(cursor);
  expect(() => decodeLibraryCursor(encodeLibraryCursor(cursor), libraryQueryHash({ query: 'changed' }))).toThrow(
    'Search changed',
  );
  for (const input of ['garbage', Buffer.from('{"mode":"text"}').toString('base64url')])
    expect(() => decodeLibraryCursor(input, hash)).toThrow('Invalid cursor');
});
it('binds semantic offsets to the ranked candidate universe and rejects out-of-range offsets', () => {
  const hash = libraryQueryHash({ query: 'green', mode: 'smart' });
  const cursor = {
    mode: 'smart' as const,
    queryHash: hash,
    universeHash: libraryQueryHash(['first', 'second']),
    offset: 1,
  };
  expect(decodeLibraryCursor(encodeLibraryCursor(cursor), hash)).toEqual(cursor);
  expect(() => encodeLibraryCursor({ ...cursor, offset: 1001 })).toThrow();
});
it('binds date filters by their actual instant rather than an empty object', () => {
  expect(libraryQueryHash({ createdAt: { gte: new Date('2026-01-01T00:00:00Z') } })).not.toBe(
    libraryQueryHash({ createdAt: { gte: new Date('2026-02-01T00:00:00Z') } }),
  );
});
