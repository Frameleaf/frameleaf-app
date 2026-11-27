import {
  getAlbumHierarchy,
  getAlbumRail,
  getPartners,
  PartnerDirection,
  type AlbumHierarchyNode,
  type AlbumRailItemDto,
  type AlbumResponseDto,
  type LibraryViewScope,
  type PartnerResponseDto,
} from '@frameleaf/sdk';
import { buildRailAlbumTree, type FrameleafAlbumTree } from '$lib/frameleaf/album-tree';
import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

export type RailAlbums = {
  tree: FrameleafAlbumTree;
  /** The slim albums as the server sent them, in rail order: names, kinds, parents, the viewer's role. */
  records: AlbumRailItemDto[];
};

const flatten = (nodes: AlbumHierarchyNode[]): AlbumResponseDto[] =>
  nodes.flatMap((node) => [node.album, ...flatten(node.children)]);

/**
 * FL-1796: what the library rail shows, kept for the session instead of in the rail itself, so a
 * rail that mounts again (a page change, coming back from the viewer) draws at once from the last
 * answer while it is read again. Album trees are kept per workspace. Everything is dropped when
 * library access changes (a lock, another account), as the rail always did.
 *
 * The tree is read from the slim `GET /albums/rail`. The full albums (members, links, origin), which only
 * the right-click menu's dialogs need, are read from `GET /albums/hierarchy` when one opens, and kept
 * until the tree is read again.
 */
class RailSession {
  albums = $state.raw<Record<string, RailAlbums>>({});
  /** People who share their library with this account; undefined until first read. */
  partners = $state.raw<PartnerResponseDto[] | undefined>();

  #albumVersion = new Map<string, number>();
  #fullAlbums = new Map<string, Promise<AlbumResponseDto[]>>();
  #railJson = new Map<string, string>();
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
    this.#fullAlbums.clear();
    this.#railJson.clear();
  }

  /** Forget one workspace's tree, for a change that may have taken albums away (a delete, a share). */
  dropAlbums(scope?: LibraryViewScope) {
    const rest = { ...this.albums };
    delete rest[scope ?? ''];
    this.albums = rest;
    this.#fullAlbums.delete(scope ?? '');
    this.#railJson.delete(scope ?? '');
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
    let response: Awaited<ReturnType<typeof getAlbumRail>>;
    try {
      response = await getAlbumRail(scope ? { libraryScope: scope } : {});
    } catch (error) {
      if (isLatest()) {
        throw error;
      }
      return;
    }
    if (isLatest()) {
      const json = JSON.stringify(response.albums);
      // An unchanged answer keeps the tree (nothing redraws) and the full albums already read for it.
      if (this.#railJson.get(key) === json && Object.hasOwn(this.albums, key)) {
        return;
      }
      this.#railJson.set(key, json);
      this.#fullAlbums.delete(key);
      this.albums = { ...this.albums, [key]: { tree: buildRailAlbumTree(response.albums), records: response.albums } };
    }
  }

  /**
   * The workspace's albums with everything the album dialogs read (members, links, origin), in rail
   * order. Read once and shared until the tree is read again; a failed read is not kept.
   */
  fullAlbums(scope?: LibraryViewScope): Promise<AlbumResponseDto[]> {
    const key = scope ?? '';
    const kept = this.#fullAlbums.get(key);
    if (kept) {
      return kept;
    }
    const generation = this.#generation;
    // Every caller, not only the first, gets the check: an answer for the account or access state
    // before a change is never handed out.
    const read = getAlbumHierarchy(scope ? { libraryScope: scope } : {}).then((response) =>
      generation === this.#generation ? flatten(response.roots) : [],
    );
    this.#fullAlbums.set(key, read);
    read.catch(() => {
      if (this.#fullAlbums.get(key) === read) {
        this.#fullAlbums.delete(key);
      }
    });
    return read;
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
