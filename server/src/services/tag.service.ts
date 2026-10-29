import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Insertable } from 'kysely';
import { isEqual } from 'lodash-es';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { TagMergeResult } from 'src/repositories/tag.repository.js';
import type { SavedSearch } from 'src/types.js';
import { OnJob } from 'src/decorators.js';
import { BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import {
  TagBulkAssetsDto,
  TagBulkAssetsResponseDto,
  TagCreateDto,
  TagMergeDto,
  TagResponseDto,
  TagStatisticsResponseDto,
  TagUpdateDto,
  TagUpsertDto,
  mapTag,
} from 'src/dtos/tag.dto.js';
import { AssetVisibility, JobName, JobStatus, Permission, QueueName, UserMetadataKey } from 'src/enum.js';
import { AssetOriginField } from 'src/repositories/partner-origin.repository.js';
import { TagAssetTable } from 'src/schema/tables/tag-asset.table.js';
import { BaseService } from 'src/services/base.service.js';
import { recordAssetEdit } from 'src/services/partner-copy.service.js';
import { isGranted, requireEntityAccess } from 'src/utils/access.js';
import { addAssets, removeAssets } from 'src/utils/asset.util.js';
import { asDateTimeString } from 'src/utils/date.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import {
  type FrameleafUserPreferences,
  changesSyncVisibility,
  getPreferences,
  getPreferencesPartial,
} from 'src/utils/preferences.js';
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
   * (suppressed, or nested under a suppressed tag, while locked) is left out entirely. A tag's cover
   * and dates come from the same items as its total.
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
    return rows.map(({ tagId, startDate, endDate, ...row }) => ({
      id: tagId,
      ...row,
      startDate: asDateTimeString(startDate),
      endDate: asDateTimeString(endDate),
    }));
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

    if (name === undefined && parentId === undefined) {
      return mapTag(await this.tagRepository.update(id, { name, color, parentId }));
    }
    const { tag, assetIds } = await this.partnerOriginRepository.withOwnerTagEdit(auth.user.id, async () => {
      // The repository holds tag rows until this transaction commits, pinning the affected memberships.
      const tag = await this.tagRepository.update(id, { name, color, parentId });
      const assetIds = await this.tagRepository.getSubtreeAssetIds(id);
      await this.updateTags(assetIds);
      await this.partnerOriginRepository.markOverridden('asset', assetIds, [AssetOriginField.Tags], auth.user.id);
      return { tag, assetIds };
    });
    await this.recordTagEdit(auth, assetIds);
    return mapTag(tag);
  }

  async upsert(auth: AuthDto, dto: TagUpsertDto) {
    const tags = await upsertTags(this.tagRepository, { userId: auth.user.id, tags: dto.tags });
    return tags.map((tag) => mapTag(tag));
  }

  async remove(auth: AuthDto, id: string): Promise<void> {
    await this.requireTag(auth, Permission.TagDelete, id);

    const assetIds = await this.partnerOriginRepository.withOwnerTagEdit(auth.user.id, async () => {
      const assetIds = await this.tagRepository.delete(id);
      await this.updateTags(assetIds);
      await this.partnerOriginRepository.markOverridden('asset', assetIds, [AssetOriginField.Tags], auth.user.id);
      return assetIds;
    });
    for (const assetId of assetIds) await this.eventRepository.emit('AssetUntag', { assetId });
    await this.recordTagEdit(auth, assetIds);
  }

  /**
   * Merges a tag into another of the caller's tags and answers the tag that stays.
   *
   * The tags, their items, the smart album rules and the account's preferences change in one
   * transaction, under the lock a preferences save takes: nothing is left naming the tag that went.
   * A Locked rule on it moves to the tag it was merged into, so nothing the rule hid is shown because
   * of the merge, and a saved search for it searches for that tag instead.
   *
   * Every item involved then gets what tagging and untagging give it: its tag list (kept locked, so
   * the next metadata read cannot bring the old tag back), its sidecar written again, the "tagged"
   * workflows for an item that gained a tag, and its partner copies told.
   */
  async merge(auth: AuthDto, id: string, dto: TagMergeDto): Promise<TagResponseDto> {
    // The route asks an API key for the permission to delete, for the tag that goes; the tag it goes
    // into changes too.
    if (auth.apiKey && !isGranted({ requested: [Permission.TagUpdate], current: auth.apiKey.permissions })) {
      throw new ForbiddenException(`Missing required permission: ${Permission.TagUpdate}`);
    }
    await this.requireTag(auth, Permission.TagDelete, id);
    await this.requireTag(auth, Permission.TagUpdate, dto.targetId);

    const userId = auth.user.id;
    const { result, rulesChanged } = await this.partnerOriginRepository.withOwnerTagEdit(userId, async () => {
      const outcome = await this.databaseRepository.withUserPreferencesLock(userId, async (tx) => {
        // the self, descendant and owner checks run with the owner's tags locked (see TagRepository.merge)
        const result = await this.tagRepository.merge(tx, id, dto.targetId);
        const previous = getPreferences(await this.userRepository.getMetadata(userId, tx));
        const updated = followMergedTags(previous, result.merged);
        if (!updated) {
          return { result, rulesChanged: false };
        }
        await this.userRepository.upsertMetadata(
          userId,
          { key: UserMetadataKey.Preferences, value: getPreferencesPartial(updated) },
          tx,
        );
        return { result, rulesChanged: changesSyncVisibility(previous, updated) };
      });
      await this.updateTags(outcome.result.assetIds);
      await this.partnerOriginRepository.markOverridden(
        'asset',
        outcome.result.assetIds,
        [AssetOriginField.Tags],
        userId,
      );
      return outcome;
    });
    if (rulesChanged) {
      // FL-218: the Locked rules filter the whole sync stream, so every session reads it again
      await this.sessionRepository.requestSyncResetForUser(userId);
    }

    const tagged = new Set(result.taggedAssetIds);
    for (const assetId of result.assetIds) {
      // An item that gained no tag lost one or carries one under a new path: only its sidecar follows.
      await (tagged.has(assetId)
        ? this.eventRepository.emit('AssetTag', { assetId, userId })
        : this.eventRepository.emit('AssetUntag', { assetId }));
    }
    await this.recordTagEdit(auth, result.assetIds);

    return mapTag(result.tag);
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

    const results = await this.partnerOriginRepository.withOriginEdit('asset', [...assetIds], [], async () => {
      const results = await this.tagRepository.upsertAssetIds(items);
      const changed = [...new Set(results.map((item) => item.assetId))];
      await this.updateTags(changed);
      await this.partnerOriginRepository.markOverridden('asset', changed, [AssetOriginField.Tags], auth.user.id);
      return results;
    });
    for (const assetId of new Set(results.map((item) => item.assetId))) {
      await this.eventRepository.emit('AssetTag', { assetId, userId: auth.user.id });
    }
    await this.recordTagEdit(auth, [...new Set(results.map((item) => item.assetId))]);

    return { count: results.length };
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireTag(auth, Permission.TagAsset, id);

    const results = await this.partnerOriginRepository.withOriginEdit('asset', dto.ids, [], async () => {
      const results = await addAssets(
        auth,
        { access: this.accessRepository, bulk: this.tagRepository },
        { parentId: id, assetIds: dto.ids, permission: Permission.AssetUpdate },
      );
      const changed = getSucceededIds(results);
      await this.updateTags(changed);
      await this.partnerOriginRepository.markOverridden('asset', changed, [AssetOriginField.Tags], auth.user.id);
      return results;
    });

    for (const { id: assetId, success } of results) {
      if (!success) {
        continue;
      }

      await this.eventRepository.emit('AssetTag', { assetId, userId: auth.user.id });
    }
    await this.recordTagEdit(auth, getSucceededIds(results));

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireTag(auth, Permission.TagAsset, id);

    const results = await this.partnerOriginRepository.withOriginEdit('asset', dto.ids, [], async () => {
      const results = await removeAssets(
        auth,
        { access: this.accessRepository, bulk: this.tagRepository },
        { parentId: id, assetIds: dto.ids, canAlwaysRemove: Permission.TagDelete },
      );
      const changed = getSucceededIds(results);
      await this.updateTags(changed);
      await this.partnerOriginRepository.markOverridden('asset', changed, [AssetOriginField.Tags], auth.user.id);
      return results;
    });

    for (const { id: assetId, success } of results) {
      if (!success) {
        continue;
      }

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

  /** Each item's tag list (kept locked, so the next metadata read cannot change it), in one statement. */
  private async updateTags(assetIds: string[]) {
    await this.assetRepository.updateTagsForAssets(assetIds);
  }
}

const getSucceededIds = (results: BulkIdResponseDto[]) => results.filter(({ success }) => success).map(({ id }) => id);

/**
 * The account's preferences with every merged tag replaced by the tag it was merged into, in the
 * Locked rules and in saved searches; undefined when neither names one.
 *
 * A saved search is the client's own search body, so a merged tag is looked for anywhere in it, as
 * `withoutLockedSavedSearches` does when it hides one. A list never names the same tag twice.
 */
export const followMergedTags = (
  preferences: FrameleafUserPreferences,
  merged: TagMergeResult['merged'],
): FrameleafUserPreferences | undefined => {
  const targets = new Map(merged.map(({ id, targetId }) => [id.toLowerCase(), targetId]));
  const targetOf = (value: unknown) => (typeof value === 'string' ? targets.get(value.toLowerCase()) : undefined);
  const follow = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const followed = value.map((item) => follow(item));
      return value.some((item) => targetOf(item)) ? [...new Set(followed)] : followed;
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, follow(item)]));
    }
    return targetOf(value) ?? value;
  };

  const { suppression } = preferences.privacy;
  const tagIds = follow(suppression.tagIds) as string[];
  const savedSearches = preferences.savedSearches.map(({ name, query }) => ({
    name,
    query: follow(query) as SavedSearch['query'],
  }));
  if (isEqual(tagIds, suppression.tagIds) && isEqual(savedSearches, preferences.savedSearches)) {
    return;
  }

  return {
    ...preferences,
    privacy: { ...preferences.privacy, suppression: { ...suppression, tagIds } },
    savedSearches,
  };
};
