import {
  askSearch,
  AssetOrder,
  searchAssets,
  searchSmart,
  type SearchResponseDto,
  type AskSearchResponseDto,
} from '@immich/sdk';
import { LibrarySearchSession } from './library-search-session.svelte';
import type { LibrarySearchTerms, LibrarySearchQuery } from './library-search-session.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  askSearch: vi.fn(),
  searchAssets: vi.fn(),
  searchSmart: vi.fn(),
}));

const result = (id: string, nextPage: string | null = null, nextCursor: string | null = null) =>
  ({
    albums: { items: [] },
    assets: { items: [{ id }], nextPage, nextCursor },
  }) as unknown as SearchResponseDto;
const options = { language: 'en' };
const structured = (terms: LibrarySearchTerms): LibrarySearchQuery => ({
  kind: 'query' in terms ? 'smart' : 'metadata',
  terms,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const sessions: LibrarySearchSession[] = [];
const createSession = () => {
  const session = new LibrarySearchSession();
  sessions.push(session);
  return session;
};
beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  for (const session of sessions) {
    session.destroy();
  }
  sessions.length = 0;
});

it('preserves scoped filters and personal sort while owning the paging cursor', async () => {
  const session = createSession();
  const terms = { albumIds: ['album'], city: null, personIds: ['person'], order: AssetOrder.Asc, page: 99 };
  session.reset(structured(terms));
  vi.mocked(searchAssets).mockResolvedValueOnce(result('first', '2')).mockResolvedValueOnce(result('second'));
  await session.loadNextPage(options);
  await session.loadNextPage(options);
  expect(searchAssets).toHaveBeenNthCalledWith(
    1,
    {
      metadataSearchDto: { ...terms, page: 1, withExif: true, visibility: 'timeline' },
    },
    { signal: expect.any(AbortSignal) },
  );
  expect(vi.mocked(searchAssets).mock.calls[1][0].metadataSearchDto.page).toBe(2);
  expect(session.assets.map(({ id }) => id)).toEqual(['first', 'second']);
  expect(terms.page).toBe(99);
  await session.loadNextPage(options);
  expect(searchAssets).toHaveBeenCalledTimes(2);
});

it('aborts the old scope and ignores its late success, pagination and loading completion', async () => {
  const session = createSession();
  const old = deferred<SearchResponseDto>();
  const current = deferred<SearchResponseDto>();
  vi.mocked(searchAssets).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  session.reset(structured({ albumIds: ['old'] }));
  const oldLoad = session.loadNextPage(options);
  const signal = vi.mocked(searchAssets).mock.calls[0][1]?.signal;
  session.reset(structured({ albumIds: ['new'] }));
  const newLoad = session.loadNextPage(options);
  old.resolve(result('private-old', '9', 'obsolete-cursor'));
  await oldLoad;
  expect(signal?.aborted).toBe(true);
  expect(session.assets).toEqual([]);
  expect(session.nextPage).toBe(1);
  expect(session.nextCursor).toBeNull();
  expect(session.loading).toBe(true);
  current.resolve(result('new'));
  await newLoad;
  expect(session.assets.map(({ id }) => id)).toEqual(['new']);
});

it('shares request ownership between metadata, smart and Ask searches', async () => {
  const session = createSession();
  const old = deferred<SearchResponseDto>();
  vi.mocked(searchSmart).mockReturnValueOnce(old.promise);
  session.reset(structured({ query: 'old' }));
  const oldLoad = session.loadNextPage(options);
  const response = {
    query: 'new',
    results: result('ask'),
    warnings: [],
    explanation: 'new',
  } as unknown as AskSearchResponseDto;
  vi.mocked(askSearch).mockResolvedValueOnce(response);
  session.reset({ kind: 'ask', query: 'new' });
  await session.loadNextPage(options);
  old.reject(new Error('obsolete failure'));
  await expect(oldLoad).resolves.toBeUndefined();
  expect(session.assets.map(({ id }) => id)).toEqual(['ask']);
  expect(session.askResponse).toEqual(response);
});

it('discards pending evidence after disposal or access invalidation', async () => {
  const session = createSession();
  const pending = deferred<SearchResponseDto>();
  vi.mocked(searchAssets).mockReturnValueOnce(pending.promise);
  session.reset(structured({ isFavorite: true }));
  const load = session.loadNextPage(options);
  session.reset();
  pending.resolve(result('revoked'));
  await load;
  expect(session.assets).toEqual([]);
  expect(session.nextPage).toBeNull();
  expect(session.nextCursor).toBeNull();
  expect(session.loading).toBe(false);
});

it('retains the retry page after a current failure and prevents duplicate concurrent loads', async () => {
  const session = createSession();
  const pending = deferred<SearchResponseDto>();
  vi.mocked(searchAssets).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(result('retry'));
  session.reset(structured({ city: 'Banff' }));
  const load = session.loadNextPage(options);
  await session.loadNextPage(options);
  expect(searchAssets).toHaveBeenCalledOnce();
  pending.reject(new Error('offline'));
  await expect(load).rejects.toThrow('offline');
  expect(session.loading).toBe(false);
  expect(session.nextPage).toBe(1);
  await session.loadNextPage(options);
  expect(session.assets.map(({ id }) => id)).toEqual(['retry']);
});

it('owns structured cursor paging and ignores a late page after disposal', async () => {
  const session = createSession();
  const pending = deferred<SearchResponseDto>();
  session.reset(structured({ filter: { city: { eq: 'Banff' } }, cursor: 'url-cursor' }));
  vi.mocked(searchAssets)
    .mockResolvedValueOnce(result('first', null, 'page-two'))
    .mockReturnValueOnce(pending.promise);
  await session.loadNextPage(options);
  expect(searchAssets).toHaveBeenNthCalledWith(
    1,
    {
      metadataSearchDto: {
        filter: { city: { eq: 'Banff' } },
        withExif: true,
      },
    },
    { signal: expect.any(AbortSignal) },
  );
  const load = session.loadNextPage(options);
  expect(searchAssets).toHaveBeenNthCalledWith(
    2,
    {
      metadataSearchDto: {
        filter: { city: { eq: 'Banff' } },
        withExif: true,
        cursor: 'page-two',
      },
    },
    { signal: expect.any(AbortSignal) },
  );
  const signal = vi.mocked(searchAssets).mock.calls[1][1]?.signal;
  session.destroy();
  expect(signal?.aborted).toBe(true);
  pending.resolve(result('late', null, 'page-three'));
  await load;
  expect(session.assets).toEqual([]);
  expect(session.nextCursor).toBeNull();
  session.reset(structured({ city: 'cannot restart a destroyed owner' }));
  await session.loadNextPage(options);
  expect(searchAssets).toHaveBeenCalledTimes(2);
});
