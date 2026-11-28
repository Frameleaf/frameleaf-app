import { ConflictException, Injectable } from '@nestjs/common';
import { chunk } from 'lodash-es';
import path from 'node:path';
import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { AlbumKind, AlbumUserRole, AssetOrder, DatabaseLock, JobName, JobStatus, QueueName } from 'src/enum.js';
import { AlbumOriginField } from 'src/repositories/partner-origin.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { queueAlbumCopies, recordAlbumEdit } from 'src/services/partner-copy.service.js';
import {
  type AlbumFolderChoices,
  refreshAlbumFolderVersions,
  resolveAlbumFolderChoices,
  subfolderRulesOf,
} from 'src/utils/album-folders.js';
import {
  EVENT_FOLDER_ALBUM_OPTIONS,
  FolderAlbumOptions,
  FolderAlbumPlanNode,
  FolderCount,
  SubfolderRule,
  autoNames,
  fileKey,
  looksLikeEventFolders,
  matchMovedFolders,
  planFolderAlbums,
  resolveFolderAlbumOptions,
} from 'src/utils/folder-albums.js';
import { isSameOrInside, normalizeImportPath } from 'src/utils/library-paths.js';
import { getPreferences } from 'src/utils/preferences.js';

type FolderAlbumSuggestion = {
  libraryId: string;
  name: string;
  albums: number;
  empty: number;
  suggestedAlbums: number;
  options: ReturnType<typeof resolveFolderAlbumOptions>;
};
/** ponytail: per process, one entry per library (its latest version); a second API worker would only read again. */
const suggestionCache = new Map<string, FolderAlbumSuggestion | undefined>();

/** Albums whose photos one membership write changes; each batch is its own transaction. */
const MEMBERSHIP_BATCH = 50;

type FolderAlbumLink = {
  id: string;
  folderPath: string;
  albumId: string;
  isUserEdited: boolean;
  isKept: boolean;
  displayChoices: AlbumFolderChoices | null;
  albumName: string;
  parentId: string | null;
  kind: string;
};

export type FolderAlbumSyncResult = {
  created: number;
  moved: number;
  removed: number;
  photosAdded: number;
  photosRemoved: number;
};

/**
 * FL-838: an album for each folder of a library, kept in sync after every scan. FL-1837: the library's rules
 * (`folderAlbumOptions`, see `planFolderAlbums`) decide which folders become albums; an album then holds the photos of
 * its folder and of the folders below that join it. When the rules change, albums no longer planned go, except those
 * the owner made their own or shared, which move inside the album now made for the folder above; with "new folders
 * only" the albums made so far are kept as they were (`isKept`).
 *
 * The albums belong to the library's owner and nest as the folders do, with the folders directly in an import folder
 * at the top. Each holds its folder's own photos and videos (not those of its subfolders); photos loose in an import
 * folder go to an album named after the library. A top-level folder holding only folders is a collection; deeper, it
 * is an album that holds albums. Nothing here writes to the library's
 * folders, so read-only libraries work the same, and nothing deletes or trashes a photo: removing an album or a
 * membership never touches the item.
 *
 * The owner's edits win. They are noticed when a sync runs, by comparing the album with its folder: an album whose
 * name is not its folder's name was renamed, and an album holding an item that is not one of its folder's own items
 * had photos put in by hand. Either marks the album `isUserEdited` for good: it keeps its name when the folder is
 * renamed, keeps the photos put in by hand (a sync only ever takes out items of its folder whose file is gone), and
 * stays when its folder empties. Its folder's photos still sync. Each folder photo goes into its album once: the sync
 * remembers it (`library_folder_album_asset`), so a photo taken out of the album by hand stays out.
 */
@Injectable()
export class FolderAlbumService extends BaseService {
  @OnJob({ name: JobName.LibraryFolderAlbumSync, queue: QueueName.Library })
  async handleSync({ id }: JobOf<JobName.LibraryFolderAlbumSync>): Promise<JobStatus> {
    return (await this.sync(id)) ? JobStatus.Success : JobStatus.Skipped;
  }

  /** Ask for a sync of the library's folder albums; one waiting sync per library is enough. */
  async queueSync(libraryId: string): Promise<void> {
    await this.jobRepository.queue({ name: JobName.LibraryFolderAlbumSync, data: { id: libraryId } });
  }

  /**
   * Folder albums turned off. The albums stay as ordinary albums unless `removeAlbums`, which deletes them (their
   * photos stay in the library). Albums the owner put inside a folder album are kept, moved up a level.
   */
  async removeAll(libraryId: string, { removeAlbums }: { removeAlbums: boolean }): Promise<number> {
    return this.databaseRepository.withLock(DatabaseLock.LibraryFolderAlbums, async () => {
      const links = await this.libraryRepository.deleteFolderAlbums(libraryId);
      if (!removeAlbums) {
        return 0;
      }
      // deepest first, so no folder album is moved up into another that is about to go
      for (const { albumId } of links.toSorted((a, b) => b.folderPath.length - a.folderPath.length)) {
        await this.albumRepository.delete(albumId);
      }
      return links.length;
    });
  }

  /** Compare the library's folders with its folder albums and bring the albums in line. */
  async sync(libraryId: string): Promise<FolderAlbumSyncResult | undefined> {
    return this.databaseRepository.withLock(DatabaseLock.LibraryFolderAlbums, () => this.syncLocked(libraryId));
  }

  /**
   * FL-1837: the rules changed on a library whose folder albums exist. `match` lets the next sync change the albums
   * made so far to match; `newOnly` keeps them as they are, each still syncing its own folder's photos.
   */
  async applyToExisting(libraryId: string, existing: 'match' | 'newOnly'): Promise<void> {
    await this.databaseRepository.withLock(DatabaseLock.LibraryFolderAlbums, () =>
      this.libraryRepository.setFolderAlbumsKept(libraryId, existing === 'newOnly'),
    );
    await this.queueSync(libraryId);
  }

  /**
   * FL-1837: the owner's libraries that made an album for each folder of a folder-by-event layout, and how many
   * albums one album for each event folder would keep instead. The Albums page offers that change once.
   */
  async getSuggestions(ownerId: string) {
    const suggestions = [];
    for (const library of await this.libraryRepository.getAll(false)) {
      const options = resolveFolderAlbumOptions(library.folderAlbumOptions);
      if (library.ownerId !== ownerId || !library.folderAlbums || options.shape !== 'every' || library.deletedAt) {
        continue;
      }
      // reading every folder of a large library is not free: once per library until it changes or is checked again
      const key = `${library.id}:${new Date(library.updatedAt).getTime()}:${library.refreshedAt ? new Date(library.refreshedAt).getTime() : 0}`;
      if (suggestionCache.has(key)) {
        const cached = suggestionCache.get(key);
        if (cached) {
          suggestions.push(cached);
        }
        continue;
      }
      const roots = this.rootsOf(library);
      const counts = await this.libraryRepository.getFolderPhotoCounts(library.id);
      if (!looksLikeEventFolders(roots, counts)) {
        continue;
      }
      const { albums, empty } = await this.libraryRepository.getFolderAlbumCounts(library.id);
      const suggested = planFolderAlbums(roots, counts, EVENT_FOLDER_ALBUM_OPTIONS, library.name).size;
      if (suggested < albums) {
        suggestions.push({
          libraryId: library.id,
          name: library.name,
          albums,
          empty,
          suggestedAlbums: suggested,
          options,
        });
      }
    }
    return suggestions;
  }

  private rootsOf(library: { importPaths: string[] }) {
    return [...new Set(library.importPaths.map((importPath) => normalizeImportPath(importPath)))];
  }

  private async syncLocked(libraryId: string): Promise<FolderAlbumSyncResult | undefined> {
    const library = await this.libraryRepository.get(libraryId);
    if (!library?.folderAlbums) {
      return;
    }
    const owner = await this.userRepository.get(library.ownerId, {});
    if (!owner) {
      return;
    }
    const ownerId = library.ownerId;
    const roots = this.rootsOf(library);
    const options = resolveFolderAlbumOptions(library.folderAlbumOptions);
    const isAutoName = (link: FolderAlbumLink) => autoNames(link.folderPath, library.name, roots).has(link.albumName);
    const result: FolderAlbumSyncResult = { created: 0, moved: 0, removed: 0, photosAdded: 0, photosRemoved: 0 };

    const byPath = new Map<string, FolderAlbumLink>();
    for (const link of await this.libraryRepository.getFolderAlbums(libraryId)) {
      if (link.deletedAt) {
        // its album went to the trash with its owner; it is made again if the folder is still here
        await this.libraryRepository.deleteFolderAlbum(link.id);
        continue;
      }
      byPath.set(link.folderPath, link);
    }

    // FL-1837: albums kept from before the rules changed ("new folders only") stay as they were, each with its own
    // folder's photos; the rules plan the albums for every other folder.
    const counts = await this.libraryRepository.getFolderPhotoCounts(libraryId);
    const kept = byPath
      .values()
      .filter((link) => link.isKept)
      .toArray();
    const keptPaths = new Set(kept.map(({ folderPath }) => folderPath));
    // FL-1838: an album's own "Folders in this album" choices: an album inside, or in the album
    const albumRules = new Map(
      byPath
        .values()
        .filter((link) => !!link.displayChoices)
        .map((link) => [link.folderPath, subfolderRulesOf(resolveAlbumFolderChoices(link.displayChoices))] as const),
    );
    const tree = planFolderAlbums(
      roots,
      counts.filter(({ folderPath }) => !keptPaths.has(folderPath)),
      options,
      library.name,
      albumRules,
    );
    this.addKept(tree, kept, counts, roots, options.skipEmpty);

    const changed = new Set<string>();
    const original = new Map(byPath);

    // Folders renamed or moved: their albums follow, so nothing the owner did to them is lost.
    const moves = await this.findMovedFolders(libraryId, tree, byPath, {
      roots,
      options,
      name: library.name,
      albumRules,
    });
    const previousPaths: { folderPath: string; albumId: string }[] = [];
    // a moved album with the name its old folder gave it takes the new folder's name
    const movedAuto = new Set<string>();
    for (const [from, to] of moves) {
      const link = byPath.get(from)!;
      await this.libraryRepository.updateFolderAlbum(link.id, { folderPath: to });
      if (isAutoName(link)) {
        movedAuto.add(to);
      }
      byPath.delete(from);
      byPath.set(to, { ...link, folderPath: to });
      previousPaths.push({ folderPath: from, albumId: link.albumId });
      result.moved++;
    }

    // A name the sync gave follows the folder and the naming rule; one the owner gave stays.
    for (const [folderPath, link] of byPath) {
      const node = tree.get(folderPath);
      if (
        !node ||
        link.isUserEdited ||
        link.isKept ||
        link.albumName === node.name ||
        !(movedAuto.has(folderPath) || isAutoName(link))
      ) {
        continue;
      }
      await this.albumRepository.update(link.albumId, { id: link.albumId, albumName: node.name }, ownerId);
      byPath.set(folderPath, { ...link, albumName: node.name });
      changed.add(link.albumId);
    }

    // Albums for new folders, parents first.
    const order = getPreferences(await this.userRepository.getMetadata(ownerId)).albums.defaultAssetOrder;
    const nodes = tree
      .values()
      .toArray()
      .toSorted((a, b) => a.depth - b.depth || a.folderPath.localeCompare(b.folderPath));
    for (const node of nodes) {
      const link = byPath.get(node.folderPath);
      if (link) {
        if (link.kind === AlbumKind.Collection && node.kind === AlbumKind.Album) {
          // a folder of folders that now holds photos, or one below the top
          await this.albumRepository.update(link.albumId, { id: link.albumId, kind: AlbumKind.Album }, ownerId);
          byPath.set(node.folderPath, { ...link, kind: AlbumKind.Album });
        }
        continue;
      }
      byPath.set(node.folderPath, await this.createAlbum(libraryId, ownerId, node, order, byPath));
      result.created++;
    }

    // A moved folder's album follows it to its new parent folder, unless the owner moved the album elsewhere.
    for (const [from, to] of moves) {
      await this.followMove(original, byPath, tree, roots, from, to);
    }

    // Each album's photos: new ones from its folders in; ones whose file is gone, or whose folder no longer joins
    // it, out (never the item itself). An album no longer planned keeps its own folder's photos.
    const add = nodes
      .filter((node) => node.photos > 0)
      .flatMap((node) =>
        node.members.map((folderPath) => ({ folderPath, albumId: byPath.get(node.folderPath)!.albumId })),
      );
    const current = byPath
      .values()
      .flatMap(({ folderPath, albumId }) =>
        (tree.get(folderPath)?.members ?? [folderPath]).map((member) => ({ folderPath: member, albumId })),
      )
      .toArray();
    // FL-1837: in batches of albums, each its own short transaction: one write locking every album of a large
    // library ran into the pool's lock timeout and rolled back every album's photos, leaving them all empty.
    const removeFrom = [...current, ...previousPaths];
    const toAdd = await this.albumRepository.getFolderPhotosToAdd(libraryId, add);
    for (const albumIds of chunk([...new Set(byPath.values().map(({ albumId }) => albumId))], MEMBERSHIP_BATCH)) {
      const batch = new Set(albumIds);
      const inBatch = ({ albumId }: { albumId: string }) => batch.has(albumId);
      const { added, removed } = await this.albumRepository.syncFolderMemberships(
        libraryId,
        toAdd.filter((item) => inBatch(item)),
        removeFrom.filter((item) => inBatch(item)),
        { members: current.filter((item) => inBatch(item)), albumIds },
      );
      result.photosAdded += added.length;
      result.photosRemoved += removed.length;
      for (const { albumId } of [...added, ...removed]) {
        changed.add(albumId);
      }
    }

    // The owner's edits, noticed now (see the class comment). A shared album is kept too, without freezing its name.
    const withOtherItems = await this.libraryRepository.getFolderAlbumsWithOtherItems(libraryId, [
      ...current,
      ...previousPaths,
    ]);
    const shared = await this.albumRepository.getSharedAlbumIds(
      byPath
        .values()
        .map(({ albumId }) => albumId)
        .toArray(),
    );
    const edited = new Set<string>();
    for (const link of byPath.values()) {
      if (link.isUserEdited || !isAutoName(link) || withOtherItems.has(link.albumId)) {
        edited.add(link.folderPath);
        if (!link.isUserEdited) {
          await this.libraryRepository.updateFolderAlbum(link.id, { isUserEdited: true });
        }
      } else if (shared.has(link.albumId)) {
        edited.add(link.folderPath);
      }
    }

    // A folder of folders again (the rules changed back): its album, emptied above and not the owner's, is a
    // collection once more.
    for (const node of nodes) {
      const link = byPath.get(node.folderPath)!;
      if (
        node.kind === AlbumKind.Collection &&
        link.kind === AlbumKind.Album &&
        !link.isKept &&
        !edited.has(node.folderPath)
      ) {
        const [stats] = await this.albumRepository.getMetadataForIds([link.albumId]);
        if (!stats?.assetCount) {
          await this.albumRepository.update(link.albumId, { id: link.albumId, kind: AlbumKind.Collection }, ownerId);
          byPath.set(node.folderPath, { ...link, kind: AlbumKind.Collection });
        }
      }
    }

    // Folders that are gone, or no longer get an album: their albums go too, unless the owner made them their own (or
    // one inside them). An import folder's album holds no folder's album, so it goes once no photo is loose in it.
    const gone = byPath
      .values()
      .filter((link) => !tree.has(link.folderPath))
      .toArray()
      .toSorted((a, b) => b.folderPath.length - a.folderPath.length);
    const keep = new Set(byPath.keys().filter((folderPath) => tree.has(folderPath) || edited.has(folderPath)));
    for (const link of gone) {
      const keepsSomething =
        !roots.includes(link.folderPath) &&
        [...keep].some((folderPath) => folderPath.startsWith(`${link.folderPath}/`));
      if (edited.has(link.folderPath) || keepsSomething) {
        keep.add(link.folderPath);
        await this.moveIntoPlannedAlbum(byPath, tree, roots, link);
        continue;
      }
      // FL-1837: read again now, as a merge may have moved links since this sync started. An album another folder was
      // merged into stays while that folder keeps it (only this link goes); a link a merge moved is left alone.
      const now = await this.libraryRepository.getFolderAlbumLinks(link.id, link.albumId);
      const mine = now.find(({ id }) => id === link.id);
      if (!mine || mine.albumId !== link.albumId) {
        continue;
      }
      const sharedWith = now.some(({ id }) => id !== link.id);
      if (sharedWith) {
        await this.libraryRepository.deleteFolderAlbum(link.id);
        byPath.delete(link.folderPath);
        continue;
      }
      await this.albumRepository.delete(link.albumId);
      changed.delete(link.albumId);
      result.removed++;
    }

    await this.announce(ownerId, [...changed]);
    this.logger.log(
      `Folder albums of library ${libraryId}: ${result.created} made, ${result.moved} moved, ${result.removed} removed, ` +
        `${result.photosAdded} photos added, ${result.photosRemoved} taken out`,
    );
    return result;
  }

  /** Albums kept from before the rules changed stay planned while their folder holds photos, as they were. */
  private addKept(
    tree: Map<string, FolderAlbumPlanNode>,
    kept: FolderAlbumLink[],
    counts: FolderCount[],
    roots: string[],
    skipEmpty: boolean,
  ) {
    const byFolder = new Map(counts.map((row) => [row.folderPath, row]));
    for (const link of kept) {
      const row = byFolder.get(link.folderPath);
      const holds = row && (row.photos > 0 || (!skipEmpty && (row.items ?? 0) > 0));
      if (!holds) {
        continue;
      }
      const planned = tree.get(link.folderPath);
      if (planned) {
        // planned anyway, for a new folder below it: it keeps its own folder's photos too
        planned.members.unshift(link.folderPath);
        planned.photos += row.photos;
        planned.kind = AlbumKind.Album;
        continue;
      }
      const root =
        roots
          .filter((candidate) => isSameOrInside(link.folderPath, candidate))
          .toSorted((a, b) => b.length - a.length)[0] ?? '/';
      const parent = path.posix.dirname(link.folderPath);
      tree.set(link.folderPath, {
        folderPath: link.folderPath,
        parentPath: roots.includes(link.folderPath) || roots.includes(parent) ? null : parent,
        photos: row.photos,
        // 1 for an import folder, as the planner counts
        depth: link.folderPath === root ? 1 : link.folderPath.split('/').length - root.split('/').length + 1,
        kind: link.kind as AlbumKind,
        name: link.albumName,
        members: [link.folderPath],
      });
    }
  }

  /**
   * FL-1837: an album the owner made their own whose folder no longer gets an album of its own moves inside the album
   * now made for the folder above it, unless the owner moved it elsewhere or kept it from before the rules changed.
   */
  private async moveIntoPlannedAlbum(
    byPath: Map<string, FolderAlbumLink>,
    tree: Map<string, FolderAlbumPlanNode>,
    roots: string[],
    link: FolderAlbumLink,
  ) {
    if (link.isKept || roots.includes(link.folderPath)) {
      return;
    }
    let folder = path.posix.dirname(link.folderPath);
    while (!roots.includes(folder) && folder !== path.posix.dirname(folder) && !tree.has(folder)) {
      folder = path.posix.dirname(folder);
    }
    const target = tree.has(folder) ? byPath.get(folder) : undefined;
    if (!target || target.albumId === link.parentId || target.kind !== AlbumKind.Album) {
      return;
    }
    // only one the sync placed: under the folder above's album, or at the top
    const placedParent = byPath.get(path.posix.dirname(link.folderPath))?.albumId ?? null;
    if (link.parentId !== placedParent && link.parentId !== null) {
      return;
    }
    try {
      await this.albumRepository.reparent(link.albumId, target.albumId, link.parentId);
      byPath.set(link.folderPath, { ...link, parentId: target.albumId });
    } catch (error) {
      if (!(error instanceof ConflictException)) {
        throw error;
      }
    }
  }

  private async findMovedFolders(
    libraryId: string,
    tree: Map<string, FolderAlbumPlanNode>,
    byPath: Map<string, FolderAlbumLink>,
    {
      roots,
      options,
      name,
      albumRules,
    }: {
      roots: string[];
      options: FolderAlbumOptions;
      name: string;
      albumRules: ReadonlyMap<string, Readonly<Record<string, SubfolderRule>>>;
    },
  ) {
    const goneFolders = byPath
      .keys()
      .filter((folderPath) => !tree.has(folderPath))
      .toArray();
    const free = new Set(tree.keys().filter((folderPath) => !byPath.has(folderPath)));
    if (goneFolders.length === 0 || free.size === 0) {
      return new Map<string, string>();
    }
    const newFolders = [...free].filter((folderPath) => tree.get(folderPath)!.photos > 0);
    const gone = new Map(goneFolders.map((folderPath) => [folderPath, new Set<string>()]));
    const candidates = new Map(newFolders.map((folderPath) => [folderPath, new Set<string>()]));
    // FL-1837: an album holds the photos of every folder that joins it (an event folder's Capture, Videos…), so it is
    // matched by all their files. A gone album's folders are planned again over every folder the library has had,
    // the ones whose files went offline too.
    if (newFolders.length === 0) {
      return new Map<string, string>();
    }
    const known = await this.libraryRepository.getFolderPaths(libraryId, goneFolders);
    const before = planFolderAlbums(
      roots,
      known.map((folderPath) => ({ folderPath, photos: 1 })),
      { ...options, skipEmpty: true },
      name,
      // FL-1838: a gone album was planned with its own folder rules, so it is planned again with them
      albumRules,
    );
    const albumsOf = (lists: [string, string[]][]) => {
      const byFolder = new Map<string, string[]>();
      for (const [album, folders] of lists) {
        for (const folder of folders) {
          byFolder.set(folder, [...(byFolder.get(folder) ?? []), album]);
        }
      }
      return byFolder;
    };
    const goneBy = albumsOf(goneFolders.map((album) => [album, before.get(album)?.members ?? [album]]));
    const newBy = albumsOf(newFolders.map((album) => [album, tree.get(album)!.members]));
    for (const row of await this.libraryRepository.getFolderFileKeys(
      libraryId,
      goneBy.keys().toArray(),
      newBy.keys().toArray(),
    )) {
      const key = fileKey(row.originalFileName, row.fileModifiedAt);
      for (const album of (row.gone ? goneBy : newBy).get(row.folderPath) ?? []) {
        (row.gone ? gone : candidates).get(album)!.add(key);
      }
    }
    return matchMovedFolders(
      [...gone].map(([folderPath, keys]) => ({ folderPath, keys })),
      candidates,
      free,
    );
  }

  private async createAlbum(
    libraryId: string,
    ownerId: string,
    node: FolderAlbumPlanNode,
    order: AssetOrder,
    byPath: Map<string, FolderAlbumLink>,
  ): Promise<FolderAlbumLink> {
    const { kind, name: albumName } = node;
    const parentId = node.parentPath ? (byPath.get(node.parentPath)?.albumId ?? null) : null;
    const album = await this.albumRepository.create(
      { albumName, parentId, kind, order },
      [],
      [{ userId: ownerId, role: AlbumUserRole.Owner }],
      ownerId,
    );
    const link = await this.libraryRepository.createFolderAlbum({
      libraryId,
      folderPath: node.folderPath,
      albumId: album.id,
    });
    // FL-326: a plain album goes to everyone its owner shares their library with, as one made by hand does
    if (kind === AlbumKind.Album) {
      await queueAlbumCopies({ partner: this.partnerRepository, job: this.jobRepository }, ownerId, album.id);
    }
    return { ...link, isKept: false, albumName, parentId, kind };
  }

  private async followMove(
    original: Map<string, FolderAlbumLink>,
    byPath: Map<string, FolderAlbumLink>,
    tree: Map<string, FolderAlbumPlanNode>,
    roots: string[],
    from: string,
    to: string,
  ) {
    const link = byPath.get(to)!;
    // a folder directly in an import folder has no parent album
    const oldParentPath = path.posix.dirname(from);
    const oldParentId = roots.includes(oldParentPath) ? null : (original.get(oldParentPath)?.albumId ?? null);
    const newParentPath = tree.get(to)?.parentPath;
    const newParentId = newParentPath ? (byPath.get(newParentPath)?.albumId ?? null) : null;
    if (link.parentId !== oldParentId || oldParentId === newParentId) {
      return;
    }
    try {
      await this.albumRepository.reparent(link.albumId, newParentId, oldParentId);
      byPath.set(to, { ...link, parentId: newParentId });
    } catch (error) {
      // the owner moved it meanwhile: where they put it wins
      if (!(error instanceof ConflictException)) {
        throw error;
      }
    }
  }

  /** Covers, open pages and partner copies catch up with the albums that changed. */
  private async announce(ownerId: string, albumIds: string[]) {
    if (albumIds.length === 0) {
      return;
    }
    await this.albumRepository.updateThumbnails(albumIds);
    await this.albumRepository.updateNewestCovers(albumIds);
    // FL-1838: the same photo in more than one of an album's folders, worked out again for the photos that came in
    for (const albumId of albumIds) {
      const link = await this.albumRepository.getFolderAlbumLink(albumId);
      if (link) {
        const choices = resolveAlbumFolderChoices(link.displayChoices ?? link.libraryDisplay);
        await refreshAlbumFolderVersions(this.albumRepository, albumId, link.folderPath, choices);
      }
    }
    // FL-1837: an album list that read these albums while the membership write was running stored them as empty, and
    // that write's change time (its start) can be too old for the list to notice. Their numbers are read again.
    await this.albumSummaryRepository.deleteByAlbumIds(albumIds);
    await recordAlbumEdit({ partnerOrigin: this.partnerOriginRepository, job: this.jobRepository }, albumIds, [
      AlbumOriginField.Membership,
    ]);
    for (const id of albumIds) {
      await this.eventRepository.emit('AlbumUpdate', { id, userIds: [ownerId], recipientIds: [] });
    }
  }
}
