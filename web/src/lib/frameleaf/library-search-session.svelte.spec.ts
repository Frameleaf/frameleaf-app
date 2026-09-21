import {
  askSearch,
  AssetOrder,
  searchAssets,
  searchSmart,
  type SearchResponseDto,
  type AskSearchResponseDto,
} from '@immich/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { LibrarySearchSession } from './library-search-session.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  askSearch: vi.fn(),
  searchAssets: vi.fn(),
  searchSmart: vi.fn(),
}));

const result = (id: string, nextPage: string | null = null) =>
  ({
    albums: { items: [] },
    assets: { items: [{ id }], nextPage },
  }) as unknown as SearchResponseDto;
const options = { smartSearch: true, language: 'en' };

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
  session.reset({ terms });
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
  session.reset({ terms: { albumIds: ['old'] } });
  const oldLoad = session.loadNextPage(options);
  const signal = vi.mocked(searchAssets).mock.calls[0][1]?.signal;
  session.reset({ terms: { albumIds: ['new'] } });
  const newLoad = session.loadNextPage(options);
  old.resolve(result('private-old', '9'));
  await oldLoad;
  expect(signal?.aborted).toBe(true);
  expect(session.assets).toEqual([]);
  expect(session.nextPage).toBe(1);
  expect(session.loading).toBe(true);
  current.resolve(result('new'));
  await newLoad;
  expect(session.assets.map(({ id }) => id)).toEqual(['new']);
});

it('shares request ownership between metadata, smart and Ask searches', async () => {
  const session = createSession();
  const old = deferred<SearchResponseDto>();
  vi.mocked(searchSmart).mockReturnValueOnce(old.promise);
  session.reset({ terms: { query: 'old' } });
  const oldLoad = session.loadNextPage(options);
  const response = {
    query: 'new',
    results: result('ask'),
    warnings: [],
    explanation: 'new',
  } as unknown as AskSearchResponseDto;
  vi.mocked(askSearch).mockResolvedValueOnce(response);
  session.reset({ ask: 'new' });
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
  session.reset({ terms: { isFavorite: true } });
  const load = session.loadNextPage(options);
  session.reset();
  pending.resolve(result('revoked'));
  await load;
  expect(session.assets).toEqual([]);
  expect(session.nextPage).toBeNull();
  expect(session.loading).toBe(false);
});

it('retains the retry page after a current failure and prevents duplicate concurrent loads', async () => {
  const session = createSession();
  const pending = deferred<SearchResponseDto>();
  vi.mocked(searchAssets).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(result('retry'));
  session.reset({ terms: { city: 'Banff' } });
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

it.each([
  ['lock', () => eventManager.emit('SessionLocked'), false],
  ['PIN reset', () => eventManager.emit('UserPinCodeReset'), false],
  ['access restriction', () => eventManager.emit('SessionAccessChanged', { isElevated: false }), false],
  ['logout', () => eventManager.emit('AuthLogout'), true],
  ['session deletion', () => eventManager.emit('SessionDelete'), true],
] as const)('invalidates pending search on %s, retiring revoked sessions', async (_name, change, blocked) => {
  const session = createSession();
  const pending = deferred<SearchResponseDto>();
  vi.mocked(searchAssets).mockReturnValueOnce(pending.promise);
  session.reset({ terms: { city: 'private place' } });
  const load = session.loadNextPage(options);
  const signal = vi.mocked(searchAssets).mock.calls[0][1]?.signal;
  change();
  expect(signal?.aborted).toBe(true);
  expect(session.blocked).toBe(blocked);
  expect(session.accessGeneration).toBe(1);
  pending.resolve(result('private-old'));
  await load;
  expect(session.assets).toEqual([]);
  expect(session.loading).toBe(false);
  if (blocked) {
    session.reset({ terms: { city: 'still private' } });
    await session.loadNextPage(options);
    expect(searchAssets).toHaveBeenCalledOnce();
  }
});
