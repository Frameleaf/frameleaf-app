import {
  getAlbumHierarchy,
  getPartners,
  PartnerDirection,
  type AlbumHierarchyNode,
  type AlbumResponseDto,
  type LibraryViewScope,
  type PartnerResponseDto,
} from '@frameleaf/sdk';
import { buildAlbumTree, type FrameleafAlbumTree } from '$lib/frameleaf/album-tree';
import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

export type RailAlbums = {
  tree: FrameleafAlbumTree;
  /** The same albums as the server sent them, for the right-click menu's dialogs. */
  records: AlbumResponseDto[];
};

const flatten = (nodes: AlbumHierarchyNode[]): AlbumResponseDto[] =>
  nodes.flatMap((node) => [node.album, ...flatten(node.children)]);

/**
 * FL-1796: what the library rail shows, kept for the session instead of in the rail itself, so a
 * rail that mounts again (a page change, coming back from the viewer) draws at once from the last
 * answer while it is read again. Album trees are kept per workspace. Everything is dropped when
 * library access changes (a lock, another account), as the rail always did.
 */
class RailSession {
  albums = $state.raw<Record<string, RailAlbums>>({});
  /** People who share their library with this account; undefined until first read. */
  partners = $state.raw<PartnerResponseDto[] | undefined>();

  #albumVersion = new Map<string, number>();
  #partnerVersion = 0;
  #generation = 0;

  constructor() {
    onLibraryAccessChange(() => this.reset());
    eventManager.on({
      // a partner who stopped sharing is gone from the rail without waiting for the next page
      PartnerRevoke: () => void this.refreshPartners(),
    });
  }

  reset() {
    this.#generation++;
    this.albums = {};
    this.partners = undefined;
  }

  /** Forget one workspace's tree, for a change that may have taken albums away (a delete, a share). */
  dropAlbums(scope?: LibraryViewScope) {
    const rest = { ...this.albums };
    delete rest[scope ?? ''];
    this.albums = rest;
  }

  /**
   * Read a workspace's album tree again; of several reads the newest asked is the one kept, so a
   * read asked after a change never loses to one asked before it. Rejects when the read fails,
   * leaving the last tree in place.
   */
  async refreshAlbums(scope?: LibraryViewScope): Promise<void> {
    const key = scope ?? '';
    const generation = this.#generation;
    const version = (this.#albumVersion.get(key) ?? 0) + 1;
    this.#albumVersion.set(key, version);
    const current = authManager.captureSession();
    const isLatest = () => generation === this.#generation && version === this.#albumVersion.get(key) && current();
    let response: Awaited<ReturnType<typeof getAlbumHierarchy>>;
    try {
      response = await getAlbumHierarchy(scope ? { libraryScope: scope } : {});
    } catch (error) {
      if (isLatest()) {
        throw error;
      }
      return;
    }
    if (isLatest()) {
      this.albums = { ...this.albums, [key]: { tree: buildAlbumTree(response), records: flatten(response.roots) } };
    }
  }

  /** Read the partners again. A failed read shows none: the rail works without the entry. */
  async refreshPartners(): Promise<void> {
    const generation = this.#generation;
    const version = ++this.#partnerVersion;
    const current = authManager.captureSession();
    let partners: PartnerResponseDto[] = [];
    try {
      partners = await getPartners({ direction: PartnerDirection.SharedWith });
    } catch {
      // the Sharing page reports partner errors
    }
    if (generation === this.#generation && version === this.#partnerVersion && current()) {
      this.partners = partners;
    }
  }
}

export const railSession = new RailSession();
