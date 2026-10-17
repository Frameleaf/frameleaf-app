import { getAssetsByOriginalPath, getFolderSummary, type AssetResponseDto } from '@frameleaf/sdk';
import { persisted } from 'svelte-persisted-store';
import { MediaQuery } from 'svelte/reactivity';
import { get } from 'svelte/store';
import {
  buildFolderTree,
  defaultFoldersView,
  normalizeFoldersView,
  type FoldersView,
  type FolderTree,
} from '$lib/frameleaf/folder-tree';
import { onLibraryAccessChange } from '$lib/frameleaf/library-access';

/**
 * The Folders browser's view (grid or columns) and whether file names show under the tiles. A
 * per-device convenience like the Albums page's `albumDirectoryView`, never authority; readers
 * repair a stale or edited value with `normalizeFoldersView`.
 */
export const foldersView = persisted<FoldersView>('frameleaf-folders-view', { ...defaultFoldersView });

/** Columns need the room: the mock offers them from 900px (`FoldersV2.jsx` `wide`), never on phones. */
const columnsFit = new MediaQuery('min-width: 900px');
export const foldersColumnsFit = () => columnsFit.current;
/** Whether the browser is showing columns right now: the viewer chose them and they fit. */
export const foldersShowColumns = () => normalizeFoldersView(get(foldersView)).view === 'columns' && columnsFit.current;

type AssetCache = {
  [path: string]: AssetResponseDto[];
};

/**
 * The Folders browser's data (FL-46): the folder tree with every folder's direct and total file
 * counts, sizes, cover and dates (`GET /view/folder/summary`), and a per-folder cache of its own
 * files (`GET /view/folder`), both limited server-side to the Timeline items the session may see.
 */
class FoldersStore {
  folders = $state.raw<FolderTree | null>(null);
  private assets = $state<AssetCache>({});
  private assetLoads = new Map<string, Promise<AssetResponseDto[]>>();
  private pending: Promise<FolderTree> | null = null;
  // Library access changes retire every response from the preceding access state.
  private generation = 0;

  constructor() {
    onLibraryAccessChange(() => this.clearCache());
  }

  /** The cached tree, or a fresh one when there is none yet or `refresh` asks for it. */
  async fetchTree({ refresh = false }: { refresh?: boolean } = {}): Promise<FolderTree> {
    if (this.folders && !refresh) {
      return this.folders;
    }
    // Concurrent loads share one request, so every caller gets the same tree.
    if (!this.pending) {
      const generation = this.generation;
      const pending: Promise<FolderTree> = Promise.resolve(generation)
        .then((owner) => {
          if (owner !== this.generation) {
            throw new DOMException('Folder tree read retired', 'AbortError');
          }
          return getFolderSummary();
        })
        .then((rows) => {
          const tree = buildFolderTree(rows);
          if (generation === this.generation) {
            this.folders = tree;
          }
          return tree;
        })
        .finally(() => {
          if (this.pending === pending) {
            this.pending = null;
          }
        });
      this.pending = pending;
    }
    return this.pending;
  }

  bustAssetCache() {
    this.assets = {};
    this.assetLoads.clear();
  }

  refreshAssetsByPath(path: string): Promise<AssetResponseDto[]> {
    const cache = this.assets;
    const pending = Promise.resolve({ path })
      .then((request) => {
        if (cache !== this.assets) {
          throw new DOMException('Folder file read retired', 'AbortError');
        }
        return getAssetsByOriginalPath(request);
      })
      .then((assets) => {
        if (cache === this.assets && this.assetLoads.get(path) === pending) {
          // Prefix keys so reserved object names stay data, using ordinary assignment for deep Svelte reactivity.
          cache[`:${path}`] = assets;
        }
        return assets;
      })
      .finally(() => {
        if (this.assetLoads.get(path) === pending) {
          this.assetLoads.delete(path);
        }
      });
    this.assetLoads.set(path, pending);
    return pending;
  }

  fetchAssetsByPath(path: string): Promise<AssetResponseDto[]> {
    const key = `:${path}`;
    if (Object.hasOwn(this.assets, key)) {
      return Promise.resolve(this.assets[key]);
    }
    return this.assetLoads.get(path) ?? this.refreshAssetsByPath(path);
  }

  clearCache() {
    this.generation++;
    this.bustAssetCache();
    this.folders = null;
    this.pending = null;
  }
}

export const foldersStore = new FoldersStore();
