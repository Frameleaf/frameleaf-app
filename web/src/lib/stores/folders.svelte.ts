import {
  getAssetsByOriginalPath,
  getFolderSummary,
  /**
   * TODO: Incorrect type
   */
  type AssetResponseDto,
} from '@immich/sdk';
import { buildFolderTree, type FolderTree } from '$lib/frameleaf/folder-tree';
import { eventManager } from '$lib/managers/event-manager.svelte';

type AssetCache = {
  [path: string]: AssetResponseDto[];
};

/**
 * The Folders browser's data (FL-46): the folder tree with every folder's direct and total file
 * counts and sizes (`GET /view/folder/summary`), and a per-folder cache of its own files
 * (`GET /view/folder`), both limited server-side to the Timeline items the session may see.
 */
class FoldersStore {
  folders = $state.raw<FolderTree | null>(null);
  private assets = $state<AssetCache>({});
  private pending: Promise<FolderTree> | null = null;
  // Bumped on logout, so a response for the previous account never lands in the cleared store.
  private generation = 0;

  constructor() {
    eventManager.on({
      AuthLogout: () => this.clearCache(),
    });
  }

  /** The cached tree, or a fresh one when there is none yet or `refresh` asks for it. */
  async fetchTree({ refresh = false }: { refresh?: boolean } = {}): Promise<FolderTree> {
    if (this.folders && !refresh) {
      return this.folders;
    }
    // Concurrent loads share one request, so every caller gets the same tree.
    if (!this.pending) {
      const generation = this.generation;
      const pending: Promise<FolderTree> = getFolderSummary()
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
  }

  async refreshAssetsByPath(path: string) {
    const generation = this.generation;
    const assets = await getAssetsByOriginalPath({ path });
    if (generation === this.generation) {
      this.assets[path] = assets;
    }
    return assets;
  }

  fetchAssetsByPath(path: string): Promise<AssetResponseDto[]> {
    const cached = this.assets[path];
    return cached ? Promise.resolve(cached) : this.refreshAssetsByPath(path);
  }

  clearCache() {
    this.generation++;
    this.assets = {};
    this.folders = null;
    this.pending = null;
  }
}

export const foldersStore = new FoldersStore();
