import { Injectable } from '@nestjs/common';
import type {
  CloudBackupAlbum,
  CloudBackupAssetDetails,
  CloudBackupAssetRecord,
  CloudBackupPerson,
} from 'src/utils/cloud-backup.js';
import { AssetEditActionItem } from 'src/dtos/editing.dto.js';
import {
  AlbumUserRole,
  AssetFileType,
  AssetLockReason,
  AssetOrder,
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  JobName,
  SourceType,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { DetailChanges, EMPTY_DETAILS, RestoreDetailsMode, detailChanges } from 'src/utils/cloud-backup-details.js';
import { updateLockedColumns } from 'src/utils/database.js';
import { upsertTags } from 'src/utils/tag.js';

/** A deleted item as the manifest records it, and where its restored files now are. */
export type CloudBackupRecreate = {
  assetId: string;
  ownerId: string;
  record: CloudBackupAssetRecord;
  details: CloudBackupAssetDetails | undefined;
  sha256: string;
  size: number;
  originalPath: string;
  sidecarPath: string | null;
  people: Record<string, CloudBackupPerson>;
};

/** What making a deleted item again came to. */
export type CloudBackupRecreateOutcome =
  | { status: 'created'; assetId: string }
  /** The owner has the same file as another item already: that item stands for it. */
  | { status: 'duplicate'; assetId: string }
  /** The owner's account is gone, so there is no one to give the item back to. */
  | { status: 'no-owner' };

/**
 * FL-164 (cloud-backup.md, Restore): the library side of a restore, after its files are back and
 * verified. Puts an item's details back (`keep`, `fill` or `replace`), makes a deleted item again from
 * its manifest record with its details, and makes a deleted album again or adds its members back.
 *
 * Items go back to their original owner only; a person, album or stack that is gone is made again with
 * the same id so everything that named it finds it again. Faces come back without recognition running
 * again, and only onto an item that has none; an item is never taken out of an album.
 */
@Injectable()
export class CloudBackupDetailsService extends BaseService {
  /** Put `backup`'s details back on an item still in the library. Answers whether anything changed. */
  async putBack(input: {
    assetId: string;
    ownerId: string;
    type: string;
    current: CloudBackupAssetDetails;
    backup: CloudBackupAssetDetails;
    mode: RestoreDetailsMode;
    people: Record<string, CloudBackupPerson>;
  }): Promise<boolean> {
    const changes = detailChanges(input.current, input.backup, input.mode);
    await this.apply(input.assetId, input.ownerId, input.type, changes, input.people);
    return Object.keys(changes).length > 0;
  }

  /** Make a deleted item again from its manifest record, with its details, once its files are in place. */
  async recreate(input: CloudBackupRecreate): Promise<CloudBackupRecreateOutcome> {
    const owner = await this.userRepository.get(input.ownerId, {});
    if (!owner) {
      return { status: 'no-owner' };
    }
    const checksum = Buffer.from(input.sha256, 'hex');
    const existing = await this.assetRepository.getUploadAssetIdByChecksum(input.ownerId, checksum);
    if (existing) {
      return { status: 'duplicate', assetId: existing };
    }

    const details = input.details ?? EMPTY_DETAILS;
    const locked = details.visibility === 'locked';
    await this.assetRepository.create(
      {
        id: input.assetId,
        ownerId: input.ownerId,
        libraryId: null,
        checksum,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
        originalPath: input.originalPath,
        originalFileName: input.record.originalFileName,
        type: input.record.type as AssetType,
        fileCreatedAt: input.record.fileCreatedAt,
        fileModifiedAt: input.record.fileModifiedAt,
        localDateTime: input.record.localDateTime,
        duration: input.record.duration,
        isFavorite: details.isFavorite,
        visibility: locked ? AssetVisibility.Timeline : (details.visibility as AssetVisibility),
      },
      locked ? { reason: AssetLockReason.Marked, lockedBy: input.ownerId } : undefined,
    );
    if (input.sidecarPath) {
      await this.assetRepository.upsertFile({
        assetId: input.assetId,
        path: input.sidecarPath,
        type: AssetFileType.Sidecar,
      });
    }
    await this.assetRepository.upsertExif({
      exif: { assetId: input.assetId, fileSizeInByte: input.size },
      lockedPropertiesBehavior: 'override',
    });
    const { physicalDeduplication } = await this.getConfig({ withCache: true });
    if (physicalDeduplication.enabled && input.ownerId === physicalDeduplication.masterUserId) {
      await this.physicalFileRepository.ensureOriginalPhysicalFile(input.assetId);
    }

    // everything but what the record already set: favourite and visibility went in with it
    const changes = detailChanges(
      { ...EMPTY_DETAILS, isFavorite: details.isFavorite, visibility: details.visibility },
      details,
      'replace',
    );
    await this.apply(input.assetId, input.ownerId, input.record.type, changes, input.people);
    // the file's own metadata, thumbnails and previews, as after an upload; locked details stay as restored
    await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: input.assetId } });
    return { status: 'created', assetId: input.assetId };
  }

  /**
   * Make a deleted album again with its name, description, cover, order, owner and sharing, holding
   * `memberIds`; or, when it is still there, add back the members it lost. Answers `null` when the album
   * is gone and its owner is too.
   */
  async restoreAlbum(input: {
    albumId: string;
    album: CloudBackupAlbum | undefined;
    memberIds: string[];
  }): Promise<'created' | 'updated' | null> {
    const existing = await this.albumRepository.getById(input.albumId, { withAssets: false });
    if (existing) {
      await this.albumRepository.addAssetIds(input.albumId, input.memberIds);
      return 'updated';
    }
    const { album } = input;
    if (!album || !(await this.userRepository.get(album.ownerId, {}))) {
      return null;
    }
    const shared = [];
    for (const user of album.sharedUsers) {
      if (await this.userRepository.get(user.userId, {})) {
        shared.push({ userId: user.userId, role: user.role as AlbumUserRole });
      }
    }
    await this.albumRepository.create(
      {
        id: input.albumId,
        albumName: album.name,
        description: album.description,
        order: album.order as AssetOrder,
        albumThumbnailAssetId:
          album.coverAssetId && input.memberIds.includes(album.coverAssetId) ? album.coverAssetId : null,
      },
      input.memberIds,
      [{ userId: album.ownerId, role: AlbumUserRole.Owner }, ...shared],
      album.ownerId,
    );
    return 'created';
  }

  /**
   * Stacks that are gone, made again once the restore has put back at least two of their items (the
   * primary first). An item whose stack still exists joined it when its details went back.
   */
  async restoreStacks(members: Array<{ assetId: string; ownerId: string; stack: CloudBackupAssetDetails['stack'] }>) {
    const byStack = new Map<string, Array<{ assetId: string; ownerId: string; isPrimary: boolean }>>();
    for (const { assetId, ownerId, stack } of members) {
      if (stack) {
        byStack.set(stack.id, [...(byStack.get(stack.id) ?? []), { assetId, ownerId, isPrimary: stack.isPrimary }]);
      }
    }
    for (const [id, items] of byStack) {
      if (items.length < 2 || (await this.stackRepository.getById(id))) {
        continue;
      }
      const ordered = items.toSorted((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
      await this.stackRepository.create(
        { id, ownerId: ordered[0].ownerId },
        ordered.map(({ assetId }) => assetId),
      );
    }
  }

  private async apply(
    assetId: string,
    ownerId: string,
    type: string,
    changes: DetailChanges,
    people: Record<string, CloudBackupPerson>,
  ) {
    const { isFavorite, visibility, exif, clearLocation, tags, albums, faces, stack, edits } = changes;

    if (visibility === 'locked') {
      await this.assetRepository.lock([assetId], AssetLockReason.Marked, ownerId);
    } else if (visibility) {
      await this.assetRepository.unlock([assetId]);
    }
    const stackId = stack && (await this.stackRepository.getById(stack.id)) ? stack.id : undefined;
    if (isFavorite !== undefined || (visibility && visibility !== 'locked') || stackId) {
      await this.assetRepository.update({
        id: assetId,
        ...(isFavorite !== undefined && { isFavorite }),
        ...(visibility && visibility !== 'locked' && { visibility: visibility as AssetVisibility }),
        ...(stackId && { stackId }),
      });
    }

    let sidecar = false;
    if (clearLocation) {
      await this.assetRepository.clearLocation([assetId]);
      sidecar = true;
    }
    if (exif && Object.keys(exif).length > 0) {
      await this.assetRepository.upsertExif({
        exif: updateLockedColumns({ assetId, ...exif }),
        lockedPropertiesBehavior: 'append',
      });
      sidecar = true;
    }
    if (sidecar) {
      await this.jobRepository.queue({ name: JobName.SidecarWrite, data: { id: assetId } });
    }

    if (tags) {
      const tagIds = (await upsertTags(this.tagRepository, { userId: ownerId, tags: tags.values })).map(({ id }) => id);
      await (tags.exact
        ? this.tagRepository.replaceAssetTags(assetId, tagIds)
        : this.tagRepository.upsertAssetIds(tagIds.map((tagId) => ({ tagId, assetId }))));
    }

    for (const albumId of albums ?? []) {
      if (await this.albumRepository.getById(albumId, { withAssets: false })) {
        await this.albumRepository.addAssetIds(albumId, [assetId]);
      }
    }

    for (const face of faces ?? []) {
      await this.personRepository.createAssetFace({
        assetId,
        personGroupId: face.personId ? await this.personFor(ownerId, face.personId, people) : null,
        boundingBoxX1: face.box[0],
        boundingBoxY1: face.box[1],
        boundingBoxX2: face.box[2],
        boundingBoxY2: face.box[3],
        imageWidth: face.imageWidth,
        imageHeight: face.imageHeight,
        isVisible: !face.isHidden,
        sourceType: SourceType.Manual,
      });
    }

    // a video's edits are versioned renders: only a photo's edits are put back
    if (edits && type === AssetType.Image) {
      await this.assetEditRepository.replaceAll(assetId, edits as unknown as AssetEditActionItem[]);
      await this.jobRepository.queue({ name: JobName.AssetEditThumbnailGeneration, data: { id: assetId } });
    }
  }

  /**
   * The owner's person for a face: the one with this id, or, when it was deleted, made again from the
   * manifest with the same id. A face whose person the manifest does not list comes back unnamed.
   */
  private async personFor(
    ownerId: string,
    personId: string,
    people: Record<string, CloudBackupPerson>,
  ): Promise<string | null> {
    if (await this.personRepository.getByGroupId({ ownerId, personGroupId: personId })) {
      return personId;
    }
    const person = people[personId];
    const owner = await this.userRepository.get(ownerId, {});
    if (!person || person.ownerId !== ownerId || !owner) {
      return null;
    }
    const [group] = await this.personRepository.createGroups([{ id: personId, clusterGroupId: owner.clusterGroupId }]);
    await this.personRepository.create({
      ownerId,
      personGroupId: group?.id ?? personId,
      name: person.name,
      birthDate: person.birthDate,
      isHidden: person.isHidden,
      isFavorite: person.isFavorite,
    });
    return personId;
  }
}
