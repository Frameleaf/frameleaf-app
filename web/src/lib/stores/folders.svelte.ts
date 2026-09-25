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
    this.pending ??= getFolderSummary()
      .then((rows) => (this.folders = buildFolderTree(rows)))
      .finally(() => (this.pending = null));
    return this.pending;
  }

  bustAssetCache() {
    this.assets = {};
  }

  async refreshAssetsByPath(path: string) {
    return (this.assets[path] = await getAssetsByOriginalPath({ path }));
  }

  async fetchAssetsByPath(path: string) {
    return (this.assets[path] ??= await getAssetsByOriginalPath({ path }));
  }

  clearCache() {
    this.assets = {};
    this.folders = null;
    this.pending = null;
  }
}

export const foldersStore = new FoldersStore();
