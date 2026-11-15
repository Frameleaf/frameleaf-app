import { ConflictException, Injectable } from '@nestjs/common';
import path from 'node:path';
import type { JobOf } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { AlbumKind, AlbumUserRole, AssetOrder, DatabaseLock, JobName, JobStatus, QueueName } from 'src/enum.js';
import { AlbumOriginField } from 'src/repositories/partner-origin.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { queueAlbumCopies, recordAlbumEdit } from 'src/services/partner-copy.service.js';
import { FolderNode, buildFolderTree, fileKey, folderName, matchMovedFolders } from 'src/utils/folder-albums.js';
import { normalizeImportPath } from 'src/utils/library-paths.js';
import { getPreferences } from 'src/utils/preferences.js';

type FolderAlbumLink = {
  id: string;
  folderPath: string;
  albumId: string;
  isUserEdited: boolean;
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
 * FL-838: an album for each folder of a library, kept in sync after every scan.
 *
 * The albums belong to the library's owner and nest as the folders do. Each holds its folder's own photos and videos
 * (not those of its subfolders); a folder holding only folders is a collection. Nothing here writes to the library's
 * folders, so read-only libraries work the same, and nothing deletes or trashes a photo: removing an album or a
 * membership never touches the item.
 *
 * The owner's edits win. They are noticed when a sync runs, by comparing the album with its folder: an album whose
 * name is not its folder's name was renamed, and an album holding an item that is not one of its folder's own items
 * had photos put in by hand. Either marks the album `isUserEdited` for good: it keeps its name when the folder is
 * renamed, keeps the photos put in by hand (a sync only ever takes out items of its folder whose file is gone), and
 * stays when its folder empties. Its folder's photos still sync. A photo taken out of an album by hand comes back
 * with the next sync while it is still in the folder.
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
    const nameOf = (folderPath: string) => folderName(folderPath, library.name);
    const result: FolderAlbumSyncResult = { created: 0, moved: 0, removed: 0, photosAdded: 0, photosRemoved: 0 };

    const roots = [...new Set(library.importPaths.map((importPath) => normalizeImportPath(importPath)))];
    const tree = buildFolderTree(roots, await this.libraryRepository.getFolderPhotoCounts(libraryId));

    const byPath = new Map<string, FolderAlbumLink>();
    for (const link of await this.libraryRepository.getFolderAlbums(libraryId)) {
      if (link.deletedAt) {
        // its album went to the trash with its owner; it is made again if the folder is still here
        await this.libraryRepository.deleteFolderAlbum(link.id);
        continue;
      }
      byPath.set(link.folderPath, link);
    }
    const original = new Map(byPath);

    // Folders renamed or moved: their albums follow, so nothing the owner did to them is lost.
    const moves = await this.findMovedFolders(libraryId, tree, byPath);
    const changed = new Set<string>();
    const previousPaths: { folderPath: string; albumId: string }[] = [];
    for (const [from, to] of moves) {
      const link = byPath.get(from)!;
      await this.libraryRepository.updateFolderAlbum(link.id, { folderPath: to });
      let albumName = link.albumName;
      if (link.albumName === nameOf(from) && nameOf(to) !== nameOf(from)) {
        albumName = nameOf(to);
        await this.albumRepository.update(link.albumId, { id: link.albumId, albumName }, ownerId);
        changed.add(link.albumId);
      }
      byPath.delete(from);
      byPath.set(to, { ...link, folderPath: to, albumName });
      previousPaths.push({ folderPath: from, albumId: link.albumId });
      result.moved++;
    }

    // Albums for new folders, parents first.
    const order = getPreferences(await this.userRepository.getMetadata(ownerId)).albums.defaultAssetOrder;
    const nodes = [...tree.values()].toSorted(
      (a, b) => a.depth - b.depth || a.folderPath.localeCompare(b.folderPath),
    );
    for (const node of nodes) {
      const link = byPath.get(node.folderPath);
      if (link) {
        if (link.kind === AlbumKind.Collection && node.photos > 0) {
          // a folder of folders that now holds photos of its own
          await this.albumRepository.update(link.albumId, { id: link.albumId, kind: AlbumKind.Album }, ownerId);
          byPath.set(node.folderPath, { ...link, kind: AlbumKind.Album });
        }
        continue;
      }
      byPath.set(node.folderPath, await this.createAlbum(libraryId, ownerId, node, nameOf(node.folderPath), order, byPath));
      result.created++;
    }

    // A moved folder's album follows it to its new parent folder, unless the owner moved the album elsewhere.
    for (const [from, to] of moves) {
      await this.followMove(original, byPath, tree, from, to);
    }

    // Each folder's photos: new ones in, ones whose file is gone out.
    const add = nodes
      .filter((node) => node.photos > 0)
      .map((node) => ({ folderPath: node.folderPath, albumId: byPath.get(node.folderPath)!.albumId }));
    const current = [...byPath.values()].map(({ folderPath, albumId }) => ({ folderPath, albumId }));
    const { added, removed } = await this.albumRepository.syncFolderMemberships(libraryId, add, [
      ...current,
      ...previousPaths,
    ]);
    result.photosAdded = added.length;
    result.photosRemoved = removed.length;
    for (const { albumId } of [...added, ...removed]) {
      changed.add(albumId);
    }

    // The owner's edits, noticed now (see the class comment).
    const withOtherItems = await this.libraryRepository.getFolderAlbumsWithOtherItems(libraryId, [
      ...current,
      ...previousPaths,
    ]);
    const edited = new Set<string>();
    for (const link of byPath.values()) {
      if (link.isUserEdited || link.albumName !== nameOf(link.folderPath) || withOtherItems.has(link.albumId)) {
        edited.add(link.folderPath);
        if (!link.isUserEdited) {
          await this.libraryRepository.updateFolderAlbum(link.id, { isUserEdited: true });
        }
      }
    }

    // Folders that are gone: their albums go too, unless the owner made them their own (or one inside them).
    const gone = [...byPath.values()]
      .filter((link) => !tree.has(link.folderPath))
      .toSorted((a, b) => b.folderPath.length - a.folderPath.length);
    const kept = new Set([...byPath.keys()].filter((folderPath) => tree.has(folderPath) || edited.has(folderPath)));
    for (const link of gone) {
      const keepsSomething = [...kept].some((folderPath) => folderPath.startsWith(`${link.folderPath}/`));
      if (edited.has(link.folderPath) || keepsSomething) {
        kept.add(link.folderPath);
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

  private async findMovedFolders(libraryId: string, tree: Map<string, FolderNode>, byPath: Map<string, FolderAlbumLink>) {
    const goneFolders = [...byPath.keys()].filter((folderPath) => !tree.has(folderPath));
    const free = new Set([...tree.keys()].filter((folderPath) => !byPath.has(folderPath)));
    if (goneFolders.length === 0 || free.size === 0) {
      return new Map<string, string>();
    }
    const newFolders = [...free].filter((folderPath) => tree.get(folderPath)!.photos > 0);
    const gone = new Map(goneFolders.map((folderPath) => [folderPath, new Set<string>()]));
    const candidates = new Map(newFolders.map((folderPath) => [folderPath, new Set<string>()]));
    for (const row of await this.libraryRepository.getFolderFileKeys(libraryId, goneFolders, newFolders)) {
      (row.gone ? gone : candidates).get(row.folderPath)?.add(fileKey(row.originalFileName, row.fileModifiedAt));
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
    node: FolderNode,
    albumName: string,
    order: AssetOrder,
    byPath: Map<string, FolderAlbumLink>,
  ): Promise<FolderAlbumLink> {
    const kind = node.photos > 0 ? AlbumKind.Album : AlbumKind.Collection;
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
    return { ...link, albumName, parentId, kind };
  }

  private async followMove(
    original: Map<string, FolderAlbumLink>,
    byPath: Map<string, FolderAlbumLink>,
    tree: Map<string, FolderNode>,
    from: string,
    to: string,
  ) {
    const link = byPath.get(to)!;
    const oldParentId = original.get(path.posix.dirname(from))?.albumId ?? null;
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
    await recordAlbumEdit({ partnerOrigin: this.partnerOriginRepository, job: this.jobRepository }, albumIds, [
      AlbumOriginField.Membership,
    ]);
    for (const id of albumIds) {
      await this.eventRepository.emit('AlbumUpdate', { id, userIds: [ownerId], recipientIds: [] });
    }
  }
}
