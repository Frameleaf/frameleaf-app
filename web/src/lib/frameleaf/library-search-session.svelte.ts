import {
  askAssistant,
  askSearch,
  recordAssistantSwitchBack,
  searchLibraryItems,
  LibraryAssetItemKind,
  LibraryItemSearchMode,
  type LibraryItemDto,
  type LibraryItemSearchDto,
  AssetVisibility,
  searchAssets,
  searchSmart,
  type AlbumResponseDto,
  type AskSearchResponseDto,
  type AssistantAskResponseDto,
  type AssetResponseDto,
  type MetadataSearchDto,
  type SmartSearchDto,
} from '@frameleaf/sdk';
import { withSearchDefaults } from '$lib/components/discovery/query';
import { withAllText } from '$lib/frameleaf/search-palette';

export type LibrarySearchTerms = MetadataSearchDto & Pick<SmartSearchDto, 'query' | 'queryAssetId'>;
export type LibrarySearchQuery =
  | { kind: 'ask'; query: string }
  /** FL-918: the Library Assistant answers in one page; it has no next page. */
  | { kind: 'assistant'; query: string }
  | { kind: 'metadata' | 'smart'; terms: LibrarySearchTerms }
  | { kind: 'library'; terms: LibraryItemSearchDto };

/**
 * FL-1403: the same search matched by text, for a server where search by meaning is off or does not
 * answer. Null when there is no text form of it: nothing was typed (a similar-photo search), or the
 * text cannot be added to the filter inside the server's limits.
 */
export const textSearchTerms = (terms: LibrarySearchTerms): LibrarySearchTerms | null => {
  const { query, ...rest } = terms;
  const text = query?.trim();
  if (!text || rest.queryAssetId) {
    return null;
  }
  // A link that is only its text (an old `?query=` address) takes the filter shape, so it is matched
  // by all text like any other; the filter then carries the defaults the flat request had.
  if (rest.filter !== undefined || Object.keys(rest).length === 0) {
    const filter = withAllText(rest.filter ?? withSearchDefaults({}), text);
    return filter ? { ...rest, filter } : null;
  }
  // ponytail: an old link with other flat fields is matched by file name only; "All text" needs the
  // filter shape, which flat fields cannot ride beside.
  return rest.originalFileName ? null : { ...rest, originalFileName: text };
};

/** One route-owned result set. Neither queries nor private assets are persisted to device storage. */
export class LibrarySearchSession {
  items = $state<LibraryItemDto[]>([]);
  count = $state<number | null>(null);
  countCapped = $state(false);
  /** FL-1403: these results were matched by text, because search by meaning was off or did not answer. */
  textFallback = $state(false);
  assets = $state<AssetResponseDto[]>([]);
  albums = $state<AlbumResponseDto[]>([]);
  askResponse = $state<AskSearchResponseDto>();
  assistantResponse = $state<AssistantAskResponseDto>();
  loading = $state(false);
  nextPage = $state<number | null>(null);
  nextCursor = $state<string | null>(null);
  #destroyed = false;
  #query: LibrarySearchQuery | null = null;
  #request?: AbortController;
  #switchBack?: { token: string; isCurrent: () => boolean };

  reset(query: LibrarySearchQuery | null = null) {
    this.#request?.abort();
    this.#request = undefined;
    this.#query = query;
    this.items = [];
    this.count = null;
    this.countCapped = false;
    this.textFallback = false;
    this.assets = [];
    this.albums = [];
    this.askResponse = undefined;
    this.assistantResponse = undefined;
    this.#switchBack = undefined;
    this.nextPage = query ? 1 : null;
    this.nextCursor = null;
    this.loading = false;
  }

  destroy() {
    this.#destroyed = true;
    this.reset();
  }

  async reportSwitchBack() {
    const pending = this.#switchBack;
    this.#switchBack = undefined;
    if (pending?.isCurrent()) {
      await recordAssistantSwitchBack({ assistantSwitchBackDto: { token: pending.token } }).catch(() => {});
    }
  }

  /**
   * FL-1403: a search by meaning, or the same search by text when the server has search by meaning
   * turned off (`smartOff`), refuses it or fails it. Only a first page may change how it is matched,
   * so a list never mixes the two; later pages keep the first page's choice.
   */
  async #byMeaningOrText<T>(
    request: AbortController,
    smartOff: boolean,
    smart: () => Promise<T>,
    text: (() => Promise<T>) | null,
  ): Promise<{ response: T; byText: boolean }> {
    if (!text) {
      return { response: await smart(), byText: false };
    }
    if (smartOff || this.textFallback) {
      return { response: await text(), byText: true };
    }
    const firstPage = !this.nextCursor && (this.nextPage ?? 1) <= 1;
    try {
      return { response: await smart(), byText: false };
    } catch (error) {
      if (this.#request !== request || !firstPage) {
        throw error;
      }
      return { response: await text(), byText: true };
    }
  }

  /** `smartSearch`: the server's feature flag; false sends a search by meaning straight to text. */
  async loadNextPage(options: { language: string; smartSearch?: boolean; isCurrent?: () => boolean }) {
    const query = this.#query;
    if (this.#destroyed || !query || (!this.nextPage && !this.nextCursor) || this.loading) {
      return;
    }

    const request = new AbortController();
    this.#request = request;
    this.loading = true;
    try {
      const smartOff = options.smartSearch === false;
      if (query.kind === 'library') {
        const searchItems = (mode: LibraryItemSearchDto['mode']) => () =>
          searchLibraryItems(
            { libraryItemSearchDto: { ...query.terms, mode, cursor: this.nextCursor ?? undefined } },
            { signal: request.signal },
          );
        const typed =
          query.terms.mode === LibraryItemSearchMode.Smart && !!query.terms.query?.trim() && !query.terms.queryAssetId;
        const { response, byText } = await this.#byMeaningOrText(
          request,
          smartOff,
          searchItems(query.terms.mode),
          typed ? searchItems(LibraryItemSearchMode.Text) : null,
        );
        if (this.#request !== request) {
          return;
        }
        this.textFallback = byText;
        const key = (item: LibraryItemDto) =>
          item.kind === LibraryAssetItemKind.Asset ? item.asset.id : `bookmark:${item.bookmark.id}`;
        const known = new Set(this.items.map((item) => key(item)));
        for (const item of response.items) {
          if (!known.has(key(item))) {
            known.add(key(item));
            this.items.push(item);
          }
        }
        this.count = response.count;
        this.countCapped = response.countCapped;
        this.nextPage = null;
        this.nextCursor = response.nextCursor;
        return;
      }
      if (query.kind === 'assistant') {
        const answer = await askAssistant(
          { assistantAskDto: { query: query.query, language: options.language } },
          { signal: request.signal },
        );
        if (this.#request !== request) {
          return;
        }
        this.assets = answer.results.assets.items;
        this.assistantResponse = answer;
        if (answer.switchBackToken && options.isCurrent) {
          this.#switchBack = { token: answer.switchBackToken, isCurrent: options.isCurrent };
        }
        this.nextPage = null;
        this.nextCursor = null;
        return;
      }
      let response;
      let byText = false;
      let askResponse: AskSearchResponseDto | undefined;
      const search = query;
      if (search.kind === 'ask') {
        askResponse = await askSearch(
          { askSearchDto: { query: search.query, page: this.nextPage ?? 1, language: options.language } },
          { signal: request.signal },
        );
        response = askResponse.results;
      } else {
        // The API rejects deprecated page/visibility fields alongside its structured filter shape.
        const searchDto = (source: LibrarySearchTerms) => {
          const structured = source.filter !== undefined || source.orderBy !== undefined || source.cursor !== undefined;
          const terms = { ...source };
          delete terms.cursor;
          delete terms.page;
          return structured
            ? { ...terms, ...(this.nextCursor && { cursor: this.nextCursor }), withExif: true }
            : { visibility: AssetVisibility.Timeline, ...terms, page: this.nextPage ?? 1, withExif: true };
        };
        const metadata = (terms: LibrarySearchTerms) => () =>
          searchAssets({ metadataSearchDto: searchDto(terms) }, { signal: request.signal });
        if (search.kind === 'smart') {
          const textTerms = textSearchTerms(search.terms);
          ({ response, byText } = await this.#byMeaningOrText(
            request,
            smartOff,
            () =>
              searchSmart(
                { smartSearchDto: { ...searchDto(search.terms), language: options.language } },
                { signal: request.signal },
              ),
            textTerms && metadata(textTerms),
          ));
        } else {
          response = await metadata(search.terms)();
        }
      }

      // Abort is advisory: a completed response can still arrive after a scope switch.
      if (this.#request !== request) {
        return;
      }
      const known = new Set(this.assets.map(({ id }) => id));
      for (const asset of response.assets.items) {
        if (known.has(asset.id)) {
          continue;
        }

        known.add(asset.id);
        this.assets.push(asset);
      }
      this.albums.push(...response.albums.items);
      this.textFallback = byText;
      this.askResponse = askResponse;
      this.nextPage = Number(response.assets.nextPage) || null;
      this.nextCursor = response.assets.nextCursor ?? null;
    } catch (error) {
      if (this.#request === request) {
        throw error;
      }
    } finally {
      if (this.#request === request) {
        this.loading = false;
      }
    }
  }
}
