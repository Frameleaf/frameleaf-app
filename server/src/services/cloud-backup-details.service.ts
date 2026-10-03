import { Injectable } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type { JobRepository } from 'src/repositories/job.repository.js';
import type { DB } from 'src/schema/index.js';
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
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';

import { BaseService } from 'src/services/base.service.js';
import { DetailChanges, EMPTY_DETAILS, RestoreDetailsMode, detailChanges } from 'src/utils/cloud-backup-details.js';
import { updateLockedColumns } from 'src/utils/database.js';
import { upsertTags } from 'src/utils/tag.js';

export type OwnerRestoreDetailsContext = {
  db: Transaction<DB>;
  ownerId: string;
  jobs: Array<Parameters<JobRepository['queue']>[0]>;
  /** Internal Buddy policy; ordinary Cloud owner restores keep their existing group restrictions. */
  buddyPeople?: boolean;
  buddyPeopleMode?: 'keep' | 'replace';
};

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
  private restoreRepositories(context?: OwnerRestoreDetailsContext) {
    const db = context?.db;
    return {
      asset: db ? new AssetRepository(db) : this.assetRepository,
      album: db ? new AlbumRepository(db) : this.albumRepository,
      assetEdit: db ? new AssetEditRepository(db) : this.assetEditRepository,
      person: db ? new PersonRepository(db) : this.personRepository,
      physicalFile: db ? new PhysicalFileRepository(db) : this.physicalFileRepository,
      stack: db ? new StackRepository(db) : this.stackRepository,
      tag: db ? new TagRepository(db, this.logger) : this.tagRepository,
      user: db ? new UserRepository(db) : this.userRepository,
    };
  }

  private async restoreJob(
    context: OwnerRestoreDetailsContext | undefined,
    job: Parameters<JobRepository['queue']>[0],
  ) {
    if (context) context.jobs.push(job);
    else await this.jobRepository.queue(job);
  }

  /** Put `backup`'s details back on an item still in the library. Answers whether anything changed. */
  async putBack(
    input: {
      assetId: string;
      ownerId: string;
      type: string;
      current: CloudBackupAssetDetails;
      backup: CloudBackupAssetDetails;
      mode: RestoreDetailsMode;
      people: Record<string, CloudBackupPerson>;
    },
    context?: OwnerRestoreDetailsContext,
  ): Promise<boolean> {
    if (context && input.ownerId !== context.ownerId) throw new Error('Owner restore details unavailable');
    const changes = detailChanges(input.current, input.backup, input.mode);
    await this.apply(input.assetId, input.ownerId, input.type, changes, input.people, context);
    return Object.keys(changes).length > 0;
  }

  /** Make a deleted item again from its manifest record, with its details, once its files are in place. */
  async recreate(
    input: CloudBackupRecreate,
    context?: OwnerRestoreDetailsContext,
  ): Promise<CloudBackupRecreateOutcome> {
    const repositories = this.restoreRepositories(context);
    if (context && input.ownerId !== context.ownerId) throw new Error('Owner restore details unavailable');
    const owner = await repositories.user.get(input.ownerId, {});
    if (!owner) {
      return { status: 'no-owner' };
    }
    const checksum = Buffer.from(input.sha256, 'hex');
    const existing = await repositories.asset.getUploadAssetIdByChecksum(input.ownerId, checksum);
    if (existing) {
      return { status: 'duplicate', assetId: existing };
    }

    const details = input.details ?? EMPTY_DETAILS;
    const locked = details.visibility === 'locked';
    await repositories.asset.create(
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
      await repositories.asset.upsertFile({
        assetId: input.assetId,
        path: input.sidecarPath,
        type: AssetFileType.Sidecar,
      });
    }
    await repositories.asset.upsertExif({
      exif: { assetId: input.assetId, fileSizeInByte: input.size },
      lockedPropertiesBehavior: 'override',
    });
    // universal storage: every managed original is registered as its own primary physical file
    await repositories.physicalFile.ensureOriginalPhysicalFile(input.assetId);

    // everything but what the record already set: favourite and visibility went in with it
    const changes = detailChanges(
      { ...EMPTY_DETAILS, isFavorite: details.isFavorite, visibility: details.visibility },
      details,
      'replace',
    );
    await this.apply(input.assetId, input.ownerId, input.record.type, changes, input.people, context);
    // the file's own metadata, thumbnails and previews, as after an upload; locked details stay as restored
    await this.restoreJob(context, { name: JobName.AssetExtractMetadata, data: { id: input.assetId } });
    return { status: 'created', assetId: input.assetId };
  }

  /**
   * Make a deleted album again with its name, description, cover, order, owner and sharing, holding
   * `memberIds`; or, when it is still there, add back the members it lost. Answers `null` when the album
   * is gone and its owner is too.
   */
  async restoreAlbum(
    input: {
      albumId: string;
      album: CloudBackupAlbum | undefined;
      memberIds: string[];
    },
    context?: OwnerRestoreDetailsContext,
  ): Promise<'created' | 'updated' | null> {
    const repositories = this.restoreRepositories(context);
    let ownedAlbum = true;
    if (context) {
      const row = await context.db
        .selectFrom('album')
        .select(['id', 'deletedAt'])
        .where('id', '=', input.albumId)
        .forUpdate()
        .noWait()
        .executeTakeFirst();
      const owner = await context.db
        .selectFrom('album_user')
        .select('userId')
        .where('albumId', '=', input.albumId)
        .where('userId', '=', context.ownerId)
        .where('role', '=', AlbumUserRole.Owner)
        .forShare()
        .noWait()
        .executeTakeFirst();
      ownedAlbum = !row || (!!owner && !row.deletedAt);
    }
    const existing = await repositories.album.getById(input.albumId, { withAssets: false });
    if (context && (!ownedAlbum || (!existing && input.album?.ownerId !== context.ownerId)))
      throw new Error('Owner restore album unavailable');
    if (existing) {
      await repositories.album.addAssetIds(input.albumId, input.memberIds);
      return 'updated';
    }
    const { album } = input;
    if (!album || !(await repositories.user.get(album.ownerId, {}))) {
      return null;
    }
    const shared = [];
    for (const user of context ? [] : album.sharedUsers) {
      if (await repositories.user.get(user.userId, {})) {
        shared.push({ userId: user.userId, role: user.role as AlbumUserRole });
      }
    }
    await repositories.album.create(
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
  async restoreStacks(
    members: Array<{ assetId: string; ownerId: string; stack: CloudBackupAssetDetails['stack'] }>,
    context?: OwnerRestoreDetailsContext,
  ) {
    const repositories = this.restoreRepositories(context);
    if (context && members.some((item) => item.ownerId !== context.ownerId))
      throw new Error('Owner restore stack unavailable');
    const byStack = new Map<string, Array<{ assetId: string; ownerId: string; isPrimary: boolean }>>();
    for (const { assetId, ownerId, stack } of members) {
      if (stack) {
        byStack.set(stack.id, [...(byStack.get(stack.id) ?? []), { assetId, ownerId, isPrimary: stack.isPrimary }]);
      }
    }
    for (const [id, items] of byStack) {
      if (items.length < 2 || (await repositories.stack.getById(id))) {
        continue;
      }
      const ordered = items.toSorted((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
      await repositories.stack.create(
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
    context?: OwnerRestoreDetailsContext,
  ) {
    const repositories = this.restoreRepositories(context);
    if (context) {
      const asset = await context.db
        .selectFrom('asset')
        .select('id')
        .where('id', '=', assetId)
        .where('ownerId', '=', context.ownerId)
        .forUpdate()
        .noWait()
        .executeTakeFirst();
      if (!asset || ownerId !== context.ownerId) throw new Error('Owner restore details unavailable');
      if (changes.stack) {
        const stack = await context.db
          .selectFrom('stack')
          .select('ownerId')
          .where('id', '=', changes.stack.id)
          .forUpdate()
          .noWait()
          .executeTakeFirst();
        if (stack && stack.ownerId !== context.ownerId) throw new Error('Owner restore stack unavailable');
      }
    }
    const { isFavorite, visibility, exif, clearLocation, tags, albums, faces, stack, edits } = changes;

    if (visibility === 'locked') {
      await repositories.asset.lock([assetId], AssetLockReason.Marked, ownerId);
    } else if (visibility) {
      await repositories.asset.unlock([assetId]);
    }
    const stackId = stack && (await repositories.stack.getById(stack.id)) ? stack.id : undefined;
    if (isFavorite !== undefined || (visibility && visibility !== 'locked') || stackId) {
      await repositories.asset.update({
        id: assetId,
        ...(isFavorite !== undefined && { isFavorite }),
        ...(visibility && visibility !== 'locked' && { visibility: visibility as AssetVisibility }),
        ...(stackId && { stackId }),
      });
    }

    let sidecar = false;
    if (clearLocation) {
      await repositories.asset.clearLocation([assetId]);
      sidecar = true;
    }
    if (exif && Object.keys(exif).length > 0) {
      await repositories.asset.upsertExif({
        exif: updateLockedColumns({ assetId, ...exif }),
        lockedPropertiesBehavior: 'append',
      });
      sidecar = true;
    }
    if (sidecar) {
      await this.restoreJob(context, { name: JobName.SidecarWrite, data: { id: assetId } });
    }

    if (tags) {
      const tagIds = (await upsertTags(repositories.tag, { userId: ownerId, tags: tags.values })).map(({ id }) => id);
      await (tags.exact
        ? repositories.tag.replaceAssetTags(assetId, tagIds)
        : repositories.tag.upsertAssetIds(tagIds.map((tagId) => ({ tagId, assetId }))));
    }

    for (const albumId of albums ?? []) {
      if (context) {
        const album = await context.db
          .selectFrom('album')
          .select(['id', 'deletedAt'])
          .where('id', '=', albumId)
          .forUpdate()
          .noWait()
          .executeTakeFirst();
        const owner = await context.db
          .selectFrom('album_user')
          .select('userId')
          .where('albumId', '=', albumId)
          .where('userId', '=', context.ownerId)
          .where('role', '=', AlbumUserRole.Owner)
          .forShare()
          .noWait()
          .executeTakeFirst();
        if (album && (!owner || album.deletedAt)) throw new Error('Owner restore album unavailable');
      }
      if (await repositories.album.getById(albumId, { withAssets: false })) {
        await repositories.album.addAssetIds(albumId, [assetId]);
      }
    }

    for (const face of faces ?? []) {
      await repositories.person.createAssetFace({
        assetId,
        personGroupId: face.personId ? await this.personFor(ownerId, face.personId, people, context) : null,
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
      await repositories.assetEdit.replaceAll(assetId, edits as unknown as AssetEditActionItem[]);
      await this.restoreJob(context, { name: JobName.AssetEditThumbnailGeneration, data: { id: assetId } });
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
    context?: OwnerRestoreDetailsContext,
  ): Promise<string | null> {
    const repositories = this.restoreRepositories(context);
    if (context?.buddyPeople) {
      return this.buddyPersonFor(ownerId, personId, people, context);
    }
    if (context) {
      await context.db
        .selectFrom('person_group')
        .select('id')
        .where('id', '=', personId)
        .forUpdate()
        .noWait()
        .execute();
      const persons = await context.db
        .selectFrom('person')
        .select('ownerId')
        .where('personGroupId', '=', personId)
        .forUpdate()
        .noWait()
        .execute();
      if (persons.some((person) => person.ownerId !== ownerId)) throw new Error('Owner restore person unavailable');
    }
    if (await repositories.person.getByGroupId({ ownerId, personGroupId: personId })) {
      return personId;
    }
    const person = people[personId];
    const owner = await repositories.user.get(ownerId, {});
    if (!person || person.ownerId !== ownerId || !owner) {
      if (context) throw new Error('Owner restore person unavailable');
      return null;
    }
    const [group] = await repositories.person.createGroups([{ id: personId, clusterGroupId: owner.clusterGroupId }]);
    await repositories.person.create({
      ownerId,
      personGroupId: group?.id ?? personId,
      name: person.name,
      birthDate: person.birthDate,
      isHidden: person.isHidden,
      isFavorite: person.isFavorite,
    });
    return personId;
  }

  private async buddyPersonFor(
    ownerId: string,
    personId: string,
    people: Record<string, CloudBackupPerson>,
    context: OwnerRestoreDetailsContext,
  ): Promise<string> {
    const owner = await context.db
      .selectFrom('user')
      .select('clusterGroupId')
      .where('id', '=', ownerId)
      .where('deletedAt', 'is', null)
      .forShare()
      .noWait()
      .executeTakeFirst();
    const group = await context.db
      .selectFrom('person_group')
      .select(['id', 'clusterGroupId'])
      .where('id', '=', personId)
      .forUpdate()
      .noWait()
      .executeTakeFirst();
    if (!owner || (group && group.clusterGroupId !== owner.clusterGroupId)) {
      throw new Error('Buddy restore person unavailable');
    }
    const existing = await context.db
      .selectFrom('person')
      .select('personGroupId')
      .where('ownerId', '=', ownerId)
      .where('personGroupId', '=', personId)
      .forUpdate()
      .noWait()
      .executeTakeFirst();
    const person = people[personId];
    if (existing && context.buddyPeopleMode !== 'replace') {
      return personId;
    }
    if (!person || person.ownerId !== ownerId) {
      if (existing) {
        return personId;
      }
      throw new Error('Buddy restore person unavailable');
    }
    const repositories = this.restoreRepositories(context);
    const values = {
      ownerId,
      personGroupId: personId,
      name: person.name,
      birthDate: person.birthDate,
      isHidden: person.isHidden,
      isFavorite: person.isFavorite,
    };
    if (existing) {
      await repositories.person.update(values);
    } else {
      if (!group) {
        await repositories.person.createGroups([{ id: personId, clusterGroupId: owner.clusterGroupId }]);
      }
      await repositories.person.create(values);
    }
    return personId;
  }
}
