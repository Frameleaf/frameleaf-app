import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Insertable } from 'kysely';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnJob } from 'src/decorators.js';
import { BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import {
  TagBulkAssetsDto,
  TagBulkAssetsResponseDto,
  TagCreateDto,
  TagResponseDto,
  TagStatisticsResponseDto,
  TagUpdateDto,
  TagUpsertDto,
  mapTag,
} from 'src/dtos/tag.dto.js';
import { AssetVisibility, JobName, JobStatus, Permission, QueueName } from 'src/enum.js';
import { AssetOriginField } from 'src/repositories/partner-origin.repository.js';
import { TagAssetTable } from 'src/schema/tables/tag-asset.table.js';
import { BaseService } from 'src/services/base.service.js';
import { recordAssetEdit } from 'src/services/partner-copy.service.js';
import { requireEntityAccess } from 'src/utils/access.js';
import { addAssets, removeAssets } from 'src/utils/asset.util.js';
import { updateLockedColumns } from 'src/utils/database.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import { upsertTags } from 'src/utils/tag.js';

@Injectable()
export class TagService extends BaseService {
  async getAll(auth: AuthDto) {
    const tags = await this.tagRepository.getAll(auth.user.id, {
      ...getHiddenContentQueryOptions(auth),
      hideLocked: !getLockedOwnerId(auth),
    });
    return tags.map((tag) => mapTag(tag));
  }

  /**
   * FL-46: per-tag counts for the Tags browser, in the scope its "Show all" opens: the owner's
   * Timeline items (tags only ever carry their owner's items), so nothing archived or Locked — except
   * (FL-195) the owner's own marks and detections in an unlocked session, which the Timeline shows too —
   * and never a hidden or suppressed item. A tag the session may not see
   * (suppressed, or nested under a suppressed tag, while locked) is left out entirely.
   */
  async getStatistics(auth: AuthDto): Promise<TagStatisticsResponseDto[]> {
    const rows = await this.searchRepository.searchTagStatistics(
      {
        ...getHiddenContentQueryOptions(auth),
        visibility: AssetVisibility.Timeline,
        lockedOwnerId: getLockedOwnerId(auth),
        hideLockedMotion: true,
        userIds: [auth.user.id],
        viewingUserId: auth.user.id,
      },
      { viewerId: auth.user.id, suppressedTagIds: auth.hiddenContent?.tagIds ?? [] },
    );
    return rows.map(({ tagId, count, total }) => ({ id: tagId, count, total }));
  }

  async get(auth: AuthDto, id: string): Promise<TagResponseDto> {
    await this.requireTag(auth, Permission.TagRead, id);
    const tag = await this.findOrFail(id);
    return mapTag(tag);
  }

  /**
   * Owner decision, September 27, 2026 ("use the existing tag regardless", FL-46): a name that is
   * already a tag of the owner's answers with that tag, unchanged, instead of an "already exists"
   * error, so a locked session cannot learn from the error that a tag it cannot see (a Locked-rule
   * tag, or one only on hidden items) exists. The answer is the tag alone, never its items or counts;
   * the tag keeps following the Locked rules.
   */
  async create(auth: AuthDto, dto: TagCreateDto) {
    let parent;
    if (dto.parentId) {
      await this.requireAccess({ auth, permission: Permission.TagRead, ids: [dto.parentId] });
      parent = await this.tagRepository.get(dto.parentId);
      if (!parent) {
        throw new BadRequestException('Tag not found');
      }
    }

    const userId = auth.user.id;
    const value = parent ? `${parent.value}/${dto.name}` : dto.name;
    const existing = await this.tagRepository.getByValue(userId, value);
    if (existing) {
      return mapTag(existing);
    }

    const { color } = dto;
    try {
      const tag = await this.tagRepository.create({ userId, value, color, parentId: parent?.id });
      return mapTag(tag);
    } catch (error) {
      // created by another request (or a metadata import) in the meantime: the same answer
      const raced = await this.tagRepository.getByValue(userId, value);
      if (raced) {
        return mapTag(raced);
      }
      throw error;
    }
  }

  async update(auth: AuthDto, id: string, dto: TagUpdateDto): Promise<TagResponseDto> {
    await this.requireTag(auth, Permission.TagUpdate, id);

    const { name, color, parentId } = dto;
    if (parentId) {
      // FL-46: moving a tag, like creating one, needs the new parent to be a tag this user can read
      await this.requireTag(auth, Permission.TagRead, parentId);
    }

    // the path, cycle and duplicate checks run with the owner's tags locked (see TagRepository.update)
    const tag = await this.tagRepository.update(id, { name, color, parentId });
    return mapTag(tag);
  }

  async upsert(auth: AuthDto, dto: TagUpsertDto) {
    const tags = await upsertTags(this.tagRepository, { userId: auth.user.id, tags: dto.tags });
    return tags.map((tag) => mapTag(tag));
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    await this.requireTag(auth, Permission.TagDelete, id);

    // TODO sync tag changes for affected assets

    await this.tagRepository.delete(id);
  }

  async bulkTagAssets(auth: AuthDto, dto: TagBulkAssetsDto): Promise<TagBulkAssetsResponseDto> {
    const [tagIds, assetIds] = await Promise.all([
      this.checkAccess({ auth, permission: Permission.TagAsset, ids: dto.tagIds }),
      this.checkAccess({ auth, permission: Permission.AssetUpdate, ids: dto.assetIds }),
    ]);

    const items: Insertable<TagAssetTable>[] = [];
    for (const tagId of tagIds) {
      for (const assetId of assetIds) {
        items.push({ tagId, assetId });
      }
    }

    const results = await this.tagRepository.upsertAssetIds(items);
    for (const assetId of new Set(results.map((item) => item.assetId))) {
      await this.updateTags(assetId);
      await this.eventRepository.emit('AssetTag', { assetId, userId: auth.user.id });
    }
    await this.recordTagEdit(auth, [...new Set(results.map((item) => item.assetId))]);

    return { count: results.length };
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireTag(auth, Permission.TagAsset, id);

    const results = await addAssets(
      auth,
      { access: this.accessRepository, bulk: this.tagRepository },
      { parentId: id, assetIds: dto.ids, permission: Permission.AssetUpdate },
    );

    for (const { id: assetId, success } of results) {
      if (!success) {
        continue;
      }

      await this.updateTags(assetId);
      await this.eventRepository.emit('AssetTag', { assetId, userId: auth.user.id });
    }
    await this.recordTagEdit(auth, getSucceededIds(results));

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireTag(auth, Permission.TagAsset, id);

    const results = await removeAssets(
      auth,
      { access: this.accessRepository, bulk: this.tagRepository },
      { parentId: id, assetIds: dto.ids, canAlwaysRemove: Permission.TagDelete },
    );

    for (const { id: assetId, success } of results) {
      if (!success) {
        continue;
      }

      await this.updateTags(assetId);
      await this.eventRepository.emit('AssetUntag', { assetId });
    }
    await this.recordTagEdit(auth, getSucceededIds(results));

    return results;
  }

  /** FL-326: a partner copy's tags are its owner's once they change them; copies of these follow. */
  private recordTagEdit(auth: AuthDto, assetIds: string[]) {
    return recordAssetEdit(
      { partnerOrigin: this.partnerOriginRepository, job: this.jobRepository },
      auth.user.id,
      assetIds,
      [AssetOriginField.Tags],
    );
  }

  @OnJob({ name: JobName.TagCleanup, queue: QueueName.BackgroundTask })
  async handleTagCleanup() {
    await this.tagRepository.deleteEmptyTags();
    return JobStatus.Success;
  }

  /**
   * The access check for a route that names one tag (FL-46). A missing tag, someone else's, and one
   * suppressed (or nested under a suppressed tag) while the session is not unlocked (owner decision,
   * September 22, 2026) all answer the same 404; the access query itself leaves the suppressed tag out.
   */
  private requireTag(auth: AuthDto, permission: Permission, id: string) {
    return requireEntityAccess(this.accessRepository, { auth, permission, ids: [id] }, 'Tag');
  }

  private async findOrFail(id: string) {
    // A 404 like the access check's, so a tag removed between the two reads looks missing too
    const tag = await this.tagRepository.get(id);
    if (!tag) {
      throw new NotFoundException('Tag not found');
    }
    return tag;
  }

  private async updateTags(assetId: string) {
    const { tags } = await this.assetRepository.getForUpdateTags(assetId);
    await this.assetRepository.upsertExif({
      exif: updateLockedColumns({ assetId, tags: tags.map(({ value }) => value) }),
      lockedPropertiesBehavior: 'append',
    });
  }
}

const getSucceededIds = (results: BulkIdResponseDto[]) => results.filter(({ success }) => success).map(({ id }) => id);
