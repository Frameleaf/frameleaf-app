import {
  askSearch,
  AssetVisibility,
  searchAssets,
  searchSmart,
  type AlbumResponseDto,
  type AskSearchResponseDto,
  type AssetResponseDto,
  type MetadataSearchDto,
  type SmartSearchDto,
} from '@immich/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { onLibraryAccessChange } from './library-access';

export type LibrarySearchTerms = MetadataSearchDto & Pick<SmartSearchDto, 'query' | 'queryAssetId'>;
export type LibrarySearchQuery = { terms: LibrarySearchTerms } | { ask: string };

/** One route-owned result set. Neither queries nor private assets are persisted to device storage. */
export class LibrarySearchSession {
  assets = $state<AssetResponseDto[]>([]);
  albums = $state<AlbumResponseDto[]>([]);
  askResponse = $state<AskSearchResponseDto>();
  loading = $state(false);
  nextPage = $state<number | null>(null);
  accessGeneration = $state(0);
  blocked = $state(false);
  #unsubscribe = onLibraryAccessChange(
    (change) => {
      if (change === 'account' || change === 'revoked') {
        this.blocked = true;
      }
      this.reset();
      this.accessGeneration++;
    },
    authManager.authenticated ? authManager.user.id : undefined,
  );
  #query: LibrarySearchQuery | null = null;
  #request?: AbortController;

  reset(query: LibrarySearchQuery | null = null) {
    this.#request?.abort();
    this.#request = undefined;
    this.#query = query;
    this.assets = [];
    this.albums = [];
    this.askResponse = undefined;
    this.nextPage = query ? 1 : null;
    this.loading = false;
  }

  destroy() {
    this.#unsubscribe();
    this.blocked = true;
    this.reset();
  }

  async loadNextPage(options: { smartSearch: boolean; language: string }) {
    const query = this.#query;
    if (this.blocked || !query || !this.nextPage || this.loading) {
      return;
    }

    const request = new AbortController();
    this.#request = request;
    this.loading = true;
    try {
      let response;
      let askResponse: AskSearchResponseDto | undefined;
      if ('ask' in query) {
        askResponse = await askSearch(
          { askSearchDto: { query: query.ask, page: this.nextPage, language: options.language } },
          { signal: request.signal },
        );
        response = askResponse.results;
      } else {
        const searchDto = { visibility: AssetVisibility.Timeline, ...query.terms, page: this.nextPage, withExif: true };
        response =
          ('query' in searchDto || 'queryAssetId' in searchDto) && options.smartSearch
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
      this.assets.push(...response.assets.items);
      this.albums.push(...response.albums.items);
      this.askResponse = askResponse;
      this.nextPage = Number(response.assets.nextPage) || null;
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
