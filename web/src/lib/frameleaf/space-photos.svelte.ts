import { searchAssets, type AssetOrder, type AssetResponseDto } from '@immich/sdk';
import { SPACE_TIMELINE_PAGE } from '$lib/frameleaf/shared-space';

/**
 * The photos in one shared space, as far as they have been loaded (FL-55).
 *
 * The space's grid and the space's viewer read the same list, so next and previous in the viewer
 * are exactly the grid's order and an item removed in one is gone from the other. The page owns one
 * of these per space and hands it to both; neither keeps a copy.
 *
 * Items come from the existing metadata search narrowed to the space, which checks album access for
 * the caller and applies their hidden-content rules, so the list only ever holds what this member
 * may see here, with anything marked sensitive and anything Locked left out.
 */
export type SpacePageFetcher = (request: {
  spaceId: string;
  page: number;
  size: number;
  order?: AssetOrder;
}) => Promise<{ items: AssetResponseDto[]; nextPage: string | null }>;

const searchSpace: SpacePageFetcher = async ({ spaceId, page, size, order }) => {
  const { assets } = await searchAssets({ metadataSearchDto: { albumIds: [spaceId], page, size, order } });
  return { items: assets.items, nextPage: assets.nextPage };
};

export class SpacePhotoSet {
  assets = $state<AssetResponseDto[]>([]);
  /** The last page loaded; 0 before the first. */
  page = $state(0);
  loading = $state(false);
  exhausted = $state(false);
  failed = $state(false);

  readonly spaceId: string;
  readonly #order: AssetOrder | undefined;
  readonly #fetch: SpacePageFetcher;
  readonly #onError: ((error: unknown) => void) | undefined;
  /** Bumped on every reload, so an answer to an older request is dropped rather than mixed in. */
  #generation = 0;

  constructor({
    spaceId,
    order,
    fetch = searchSpace,
    onError,
  }: {
    spaceId: string;
    order?: AssetOrder;
    fetch?: SpacePageFetcher;
    /** Told about a failed page; the set itself only records that it failed. */
    onError?: (error: unknown) => void;
  }) {
    this.spaceId = spaceId;
    this.#order = order;
    this.#fetch = fetch;
    this.#onError = onError;
  }

  /** Load one page. Page 1 replaces the list; any later page is appended. */
  async load(next: number) {
    const generation = next === 1 ? ++this.#generation : this.#generation;
    this.loading = true;
    this.failed = false;
    try {
      const results = await this.#fetch({
        spaceId: this.spaceId,
        page: next,
        size: SPACE_TIMELINE_PAGE,
        order: this.#order,
      });
      if (generation !== this.#generation) {
        return;
      }
      const known = next === 1 ? new Set<string>() : new Set(this.assets.map(({ id }) => id));
      const fresh = results.items.filter(({ id }) => !known.has(id));
      this.assets = next === 1 ? fresh : [...this.assets, ...fresh];
      this.exhausted = results.nextPage === null;
      this.page = next;
    } catch (error) {
      if (generation === this.#generation) {
        this.failed = true;
        this.#onError?.(error);
      }
    } finally {
      if (generation === this.#generation) {
        this.loading = false;
      }
    }
  }

  /** The next page, unless one is already on its way, the space has run out, or the last one failed. */
  loadMore(): Promise<void> | undefined {
    if (this.loading || this.exhausted || this.failed) {
      return;
    }
    return this.load(this.page + 1);
  }

  /** Try again after a failure, from where it stopped. */
  retry(): Promise<void> {
    return this.load(this.assets.length === 0 ? 1 : this.page + 1);
  }

  /** Start again from the first page. */
  reload(): Promise<void> {
    return this.load(1);
  }

  /** Items a bulk action or the viewer took out of the space. */
  remove(ids: Iterable<string>) {
    const removed = new Set(ids);
    if (removed.size === 0) {
      return;
    }
    this.assets = this.assets.filter(({ id }) => !removed.has(id));
  }

  /** An item the viewer changed (a favourite, a rating, a new description). */
  replace(asset: AssetResponseDto) {
    const index = this.assets.findIndex(({ id }) => id === asset.id);
    if (index !== -1) {
      this.assets[index] = asset;
    }
  }

  indexOf(id: string | undefined | null): number {
    return id ? this.assets.findIndex((asset) => asset.id === id) : -1;
  }
}
