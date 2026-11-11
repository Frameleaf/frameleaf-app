import {
  askAssistant,
  askSearch,
  searchLibraryItems,
  LibraryBookmarkItemKind,
  LibraryItemSearchMode,
  LibraryViewScope,
  type LibraryItemSearchResponseDto,
  AssetOrder,
  searchAssets,
  searchSmart,
  type SearchResponseDto,
  type AskSearchResponseDto,
  type AssistantAskResponseDto,
} from '@frameleaf/sdk';
import { LibrarySearchSession, textSearchTerms } from './library-search-session.svelte';
import type { LibrarySearchTerms, LibrarySearchQuery } from './library-search-session.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  askAssistant: vi.fn(),
  askSearch: vi.fn(),
  searchAssets: vi.fn(),
  searchLibraryItems: vi.fn(),
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

it('does not append an asset twice when offset pages overlap', async () => {
  const session = createSession();
  session.reset(structured({ city: 'Edmonton' }));
  vi.mocked(searchAssets).mockResolvedValueOnce(result('first', '2')).mockResolvedValueOnce(result('first'));
  await session.loadNextPage(options);
  await session.loadNextPage(options);
  expect(session.assets.map(({ id }) => id)).toEqual(['first']);
});

const mixedResult = (id: string, nextCursor: string | null = null): LibraryItemSearchResponseDto =>
  ({
    items: [{ kind: LibraryBookmarkItemKind.Bookmark, bookmark: { id } }],
    count: 2,
    countCapped: false,
    nextCursor,
  }) as LibraryItemSearchResponseDto;

it('pages mixed records through the same request boundary and preserves their kind', async () => {
  const session = createSession();
  vi.mocked(searchLibraryItems)
    .mockResolvedValueOnce(mixedResult('one', 'next'))
    .mockResolvedValueOnce(mixedResult('two'));
  session.reset({ kind: 'library', terms: { filter: { libraryScope: LibraryViewScope.Design } } });
  await session.loadNextPage(options);
  await session.loadNextPage(options);
  expect(session.items.map((item) => item.kind === LibraryBookmarkItemKind.Bookmark && item.bookmark.id)).toEqual([
    'one',
    'two',
  ]);
  expect(session.assets).toEqual([]);
  expect(session.count).toBe(2);
  expect(vi.mocked(searchLibraryItems).mock.calls[1][0].libraryItemSearchDto.cursor).toBe('next');
});

it('discards a completed mixed response after an access reset', async () => {
  const session = createSession();
  const pending = deferred<LibraryItemSearchResponseDto>();
  vi.mocked(searchLibraryItems).mockReturnValueOnce(pending.promise);
  session.reset({ kind: 'library', terms: { filter: { libraryScope: LibraryViewScope.Design } } });
  const load = session.loadNextPage(options);
  session.reset();
  pending.resolve(mixedResult('private'));
  await load;
  expect(session.items).toEqual([]);
  expect(session.count).toBeNull();
  expect(session.nextCursor).toBeNull();
});

describe('LibrarySearchSession: Library Assistant (FL-918)', () => {
  it('asks the assistant once, keeps its answer and has no next page', async () => {
    const answer = { results: result('lake'), reasons: [], answeredBy: 'rules' } as unknown as AssistantAskResponseDto;
    vi.mocked(askAssistant).mockResolvedValue(answer);
    const session = createSession();
    session.reset({ kind: 'assistant', query: 'Emma by the lake' });
    await session.loadNextPage(options);

    expect(askAssistant).toHaveBeenCalledWith(
      { assistantAskDto: { query: 'Emma by the lake', language: 'en' } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(session.assets.map(({ id }) => id)).toEqual(['lake']);
    expect(session.assistantResponse).toEqual(answer);
    expect(session.nextPage).toBeNull();
    expect(askSearch).not.toHaveBeenCalled();
  });
});

describe('LibrarySearchSession: search by meaning answered by text (FL-1403)', () => {
  const allText = (text: string) => [
    { originalFileName: { like: text } },
    { description: { like: text } },
    { ocr: { matches: text } },
    { originalPath: { like: text } },
  ];
  const meaning = (text: string): LibrarySearchQuery => ({
    kind: 'smart',
    terms: { filter: { isFavorite: { eq: true } }, query: text },
  });
  const refused = () => Object.assign(new Error('Smart search is not enabled'), { status: 400 });

  it('searches by text, never the whole library, when the server has search by meaning turned off', async () => {
    const session = createSession();
    vi.mocked(searchAssets).mockResolvedValueOnce(result('named'));
    session.reset(meaning('zzzzqqq'));
    await session.loadNextPage({ ...options, smartSearch: false });
    expect(searchSmart).not.toHaveBeenCalled();
    const sent = vi.mocked(searchAssets).mock.calls[0][0].metadataSearchDto;
    expect(sent).toEqual({ filter: { isFavorite: { eq: true }, or: allText('zzzzqqq') }, withExif: true });
    expect(session.assets.map(({ id }) => id)).toEqual(['named']);
    expect(session.textFallback).toBe(true);
  });

  it('searches by text when the server refuses the search by meaning, and keeps to text for later pages', async () => {
    const session = createSession();
    vi.mocked(searchSmart).mockRejectedValueOnce(refused());
    vi.mocked(searchAssets)
      .mockResolvedValueOnce(result('first', null, 'next'))
      .mockResolvedValueOnce(result('second'));
    session.reset(meaning('screenshot'));
    await session.loadNextPage({ ...options, smartSearch: true });
    expect(session.textFallback).toBe(true);
    await session.loadNextPage({ ...options, smartSearch: true });
    expect(searchSmart).toHaveBeenCalledOnce();
    expect(vi.mocked(searchAssets).mock.calls.map(([{ metadataSearchDto }]) => metadataSearchDto)).toEqual([
      { filter: { isFavorite: { eq: true }, or: allText('screenshot') }, withExif: true },
      { filter: { isFavorite: { eq: true }, or: allText('screenshot') }, withExif: true, cursor: 'next' },
    ]);
    expect(session.assets.map(({ id }) => id)).toEqual(['first', 'second']);
  });

  it('shows nothing, not the library, when the text matches nothing', async () => {
    const session = createSession();
    vi.mocked(searchSmart).mockRejectedValueOnce(refused());
    vi.mocked(searchAssets).mockResolvedValueOnce({
      albums: { items: [] },
      assets: { items: [], nextPage: null },
    } as unknown as SearchResponseDto);
    session.reset(meaning('zzzzqqq'));
    await session.loadNextPage(options);
    expect(session.assets).toEqual([]);
    expect(session.nextPage).toBeNull();
    expect(session.textFallback).toBe(true);
  });

  it('leaves a search by meaning that answers exactly as it was', async () => {
    const session = createSession();
    vi.mocked(searchSmart).mockResolvedValueOnce(result('ranked'));
    session.reset(meaning('beach'));
    await session.loadNextPage({ ...options, smartSearch: true });
    expect(searchSmart).toHaveBeenCalledWith(
      { smartSearchDto: { filter: { isFavorite: { eq: true } }, query: 'beach', withExif: true, language: 'en' } },
      { signal: expect.any(AbortSignal) },
    );
    expect(searchAssets).not.toHaveBeenCalled();
    expect(session.textFallback).toBe(false);
  });

  it('does not change how a list is matched part-way: a later page that fails stays failed', async () => {
    const session = createSession();
    vi.mocked(searchSmart)
      .mockResolvedValueOnce(result('ranked', null, 'next'))
      .mockRejectedValueOnce(new Error('offline'));
    session.reset(meaning('beach'));
    await session.loadNextPage(options);
    await expect(session.loadNextPage(options)).rejects.toThrow('offline');
    expect(searchAssets).not.toHaveBeenCalled();
    expect(session.textFallback).toBe(false);
  });

  it('has no text form of a similar-photo search: the refusal is reported, never the library', async () => {
    const session = createSession();
    vi.mocked(searchSmart).mockRejectedValueOnce(refused());
    session.reset({ kind: 'smart', terms: { filter: {}, queryAssetId: 'asset' } });
    await expect(session.loadNextPage({ ...options, smartSearch: false })).rejects.toThrow('not enabled');
    expect(searchAssets).not.toHaveBeenCalled();
    expect(textSearchTerms({ queryAssetId: 'asset', query: 'beach' })).toBeNull();
  });

  it('matches an old link that is only its text by all text, in the Library, never in Trash', () => {
    expect(textSearchTerms({ query: ' tree ' })).toEqual({
      filter: { visibility: { eq: 'timeline' }, trashedAt: { eq: null }, or: allText('tree') },
    });
  });

  it('matches an old link with other flat fields by file name', () => {
    expect(textSearchTerms({ query: ' tree ', city: 'Banff' })).toEqual({ city: 'Banff', originalFileName: 'tree' });
  });

  it('sends a mixed (Boards, album) search in text mode when meaning is off or refused', async () => {
    const terms = { filter: {}, query: 'poster', mode: LibraryItemSearchMode.Smart, limit: 100 };
    const modes = () =>
      vi.mocked(searchLibraryItems).mock.calls.map(([{ libraryItemSearchDto }]) => libraryItemSearchDto.mode);

    const off = createSession();
    vi.mocked(searchLibraryItems).mockResolvedValueOnce(mixedResult('one'));
    off.reset({ kind: 'library', terms });
    await off.loadNextPage({ ...options, smartSearch: false });
    expect(modes()).toEqual([LibraryItemSearchMode.Text]);
    expect(off.textFallback).toBe(true);

    vi.mocked(searchLibraryItems).mockReset();
    const refusing = createSession();
    vi.mocked(searchLibraryItems).mockRejectedValueOnce(refused()).mockResolvedValueOnce(mixedResult('two'));
    refusing.reset({ kind: 'library', terms });
    await refusing.loadNextPage({ ...options, smartSearch: true });
    expect(modes()).toEqual([LibraryItemSearchMode.Smart, LibraryItemSearchMode.Text]);
    expect(refusing.items).toHaveLength(1);
    expect(refusing.textFallback).toBe(true);
  });
});
