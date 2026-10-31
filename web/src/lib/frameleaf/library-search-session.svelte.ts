import {
  askSearch,
  searchLibraryItems,
  LibraryAssetItemKind,
  type LibraryItemDto,
  type LibraryItemSearchDto,
  AssetVisibility,
  searchAssets,
  searchSmart,
  type AlbumResponseDto,
  type AskSearchResponseDto,
  type AssetResponseDto,
  type MetadataSearchDto,
  type SmartSearchDto,
} from '@frameleaf/sdk';

export type LibrarySearchTerms = MetadataSearchDto & Pick<SmartSearchDto, 'query' | 'queryAssetId'>;
export type LibrarySearchQuery =
  | { kind: 'ask'; query: string }
  | { kind: 'metadata' | 'smart'; terms: LibrarySearchTerms }
  | { kind: 'library'; terms: LibraryItemSearchDto };

/** One route-owned result set. Neither queries nor private assets are persisted to device storage. */
export class LibrarySearchSession {
  items = $state<LibraryItemDto[]>([]);
  count = $state<number | null>(null);
  countCapped = $state(false);
  assets = $state<AssetResponseDto[]>([]);
  albums = $state<AlbumResponseDto[]>([]);
  askResponse = $state<AskSearchResponseDto>();
  loading = $state(false);
  nextPage = $state<number | null>(null);
  nextCursor = $state<string | null>(null);
  #destroyed = false;
  #query: LibrarySearchQuery | null = null;
  #request?: AbortController;

  reset(query: LibrarySearchQuery | null = null) {
    this.#request?.abort();
    this.#request = undefined;
    this.#query = query;
    this.items = [];
    this.count = null;
    this.countCapped = false;
    this.assets = [];
    this.albums = [];
    this.askResponse = undefined;
    this.nextPage = query ? 1 : null;
    this.nextCursor = null;
    this.loading = false;
  }

  destroy() {
    this.#destroyed = true;
    this.reset();
  }

  async loadNextPage(options: { language: string }) {
    const query = this.#query;
    if (this.#destroyed || !query || (!this.nextPage && !this.nextCursor) || this.loading) {
      return;
    }

    const request = new AbortController();
    this.#request = request;
    this.loading = true;
    try {
      if (query.kind === 'library') {
        const response = await searchLibraryItems(
          { libraryItemSearchDto: { ...query.terms, cursor: this.nextCursor ?? undefined } },
          { signal: request.signal },
        );
        if (this.#request !== request) {
          return;
        }
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
      let response;
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
        const structured =
          search.terms.filter !== undefined || search.terms.orderBy !== undefined || search.terms.cursor !== undefined;
        const terms = { ...search.terms };
        delete terms.cursor;
        delete terms.page;
        const searchDto = structured
          ? { ...terms, ...(this.nextCursor && { cursor: this.nextCursor }), withExif: true }
          : { visibility: AssetVisibility.Timeline, ...terms, page: this.nextPage ?? 1, withExif: true };
        response =
          search.kind === 'smart'
            ? await searchSmart(
                { smartSearchDto: { ...searchDto, language: options.language } },
                { signal: request.signal },
              )
            : await searchAssets({ metadataSearchDto: searchDto }, { signal: request.signal });
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
