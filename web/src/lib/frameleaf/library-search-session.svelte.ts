import {
  askSearch,
  AssetVisibility,
  searchAssets,
  searchSmart,
  type AlbumResponseDto,
  type AskSearchResponseDto,
  type AssetResponseDto,
} from '@immich/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { onLibraryAccessChange } from './library-access';
import type { LibrarySearchQuery } from './library-session';

/** One route-owned result set. Neither queries nor private assets are persisted to device storage. */
export class LibrarySearchSession {
  assets = $state<AssetResponseDto[]>([]);
  albums = $state<AlbumResponseDto[]>([]);
  askResponse = $state<AskSearchResponseDto>();
  loading = $state(false);
  nextPage = $state<number | null>(null);
  nextCursor = $state<string | null>(null);
  accessGeneration = $state(0);
  blocked = $state(false);
  #unsubscribe = onLibraryAccessChange(
    (change) => {
      // Expansion cannot invalidate already-authorized results or destroy an open editor.
      if (change === 'expanded') {
        return;
      }
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
    this.nextCursor = null;
    this.loading = false;
  }

  destroy() {
    this.#unsubscribe();
    this.blocked = true;
    this.reset();
  }

  async loadNextPage(options: { language: string }) {
    const query = this.#query;
    if (this.blocked || !query || (!this.nextPage && !this.nextCursor) || this.loading) {
      return;
    }

    const request = new AbortController();
    this.#request = request;
    this.loading = true;
    try {
      let response;
      let askResponse: AskSearchResponseDto | undefined;
      const search = query.search;
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
        const searchDto = structured
          ? { ...search.terms, ...(this.nextCursor && { cursor: this.nextCursor }), withExif: true }
          : { visibility: AssetVisibility.Timeline, ...search.terms, page: this.nextPage ?? 1, withExif: true };
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
      this.assets.push(...response.assets.items);
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
