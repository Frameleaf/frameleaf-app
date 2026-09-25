import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { TrashScopeOptions } from 'src/repositories/trash.repository.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import {
  TrashApplyDto,
  TrashItemSort,
  TrashItemsDto,
  TrashItemsResponseDto,
  TrashResponseDto,
  TrashReviewDto,
  TrashReviewResponseDto,
  TrashSummaryResponseDto,
  UtilityActivityAction,
  UtilityActivityQueryDto,
  UtilityActivityResponseDto,
  UtilityActivityTool,
} from 'src/dtos/trash.dto.js';
import { AssetStatus, JobName, JobStatus, Permission, QueueName } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import { batched } from 'src/utils/misc.js';
import {
  TRASH_ACTIONS_WITH_IDS,
  TrashReviewAction,
  summarizeTrashReview,
  toByteCount,
  trashReviewToken,
  trashSearchTerms,
} from 'src/utils/trash-review.js';

const CHANGED_MESSAGE = 'Trash changed since this review. Review the current items before continuing.';
const UNAVAILABLE_MESSAGE = 'A chosen item changed or is no longer available. Refresh and review again.';

@Injectable()
export class TrashService extends BaseService {
  /**
   * What this session may see of the caller's own trash (FL-47): their Locked media only from their
   * elevated session, and nothing their privacy filters hide from an ordinary one. Everything the
   * trash lists, counts, reviews or changes goes through this one scope.
   */
  private scopeOf(auth: AuthDto): TrashScopeOptions {
    const lockedOwnerId = getLockedOwnerId(auth);
    return {
      ...(lockedOwnerId && { lockedOwnerId }),
      privacy: getHiddenContentQueryOptions(auth),
    };
  }

  async getSummary(auth: AuthDto): Promise<TrashSummaryResponseDto> {
    return this.trashRepository.getSummary(auth.user.id, this.scopeOf(auth));
  }

  async getItems(auth: AuthDto, dto: TrashItemsDto): Promise<TrashItemsResponseDto> {
    const page = dto.page ?? 1;
    const size = dto.size ?? 200;
    const { items, hasNextPage, total } = await this.trashRepository.getItems(auth.user.id, {
      ...this.scopeOf(auth),
      terms: trashSearchTerms(dto.query),
      type: dto.type,
      order: dto.sort ?? TrashItemSort.Recent,
      page,
      size,
    });

    return {
      items: items.map((item) => ({
        id: item.id,
        originalFileName: item.originalFileName,
        type: item.type,
        fileSizeInByte: item.fileSizeInByte === null ? null : toByteCount(item.fileSizeInByte),
        trashedAt: item.deletedAt ? new Date(item.deletedAt).toISOString() : null,
        isLocked: !!item.isLocked,
        // only the library scan's missing originals; one the owner trashed is an ordinary trash item
        isOffline: !!item.isOffline && item.status === AssetStatus.Active,
      })),
      total,
      nextPage: hasNextPage ? String(page + 1) : null,
    };
  }

  /**
   * The ids an action names, or undefined for the actions over the whole visible trash. Chosen ids
   * are checked like any other asset change: owned by the caller, Locked only when unlocked.
   */
  private async chosenIds(auth: AuthDto, action: TrashReviewAction, ids: string[] | undefined) {
    if (!TRASH_ACTIONS_WITH_IDS.has(action)) {
      return;
    }

    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      throw new BadRequestException('Choose at least one item');
    }

    await this.requireAccess({ auth, permission: Permission.AssetDelete, ids: unique });
    return unique;
  }

  /**
   * Moving to the trash needs the trash. With it turned off a deletion is permanent, which is a
   * different decision with its own confirmation, so a large-file review refuses rather than hiding it.
   */
  private async requireTrashFor(action: TrashReviewAction) {
    if (action !== TrashReviewAction.Trash) {
      return;
    }
    const { trash } = await this.getConfig({ withCache: true });
    if (!trash.enabled) {
      throw new BadRequestException('Trash is turned off');
    }
  }

  /**
   * Resolve the set an action would change and fingerprint it. A chosen item that is not in the
   * state the action starts from (already restored, already deleted, locked or hidden since it was
   * shown) makes the review fail, so the person is never shown a count the apply would not match.
   */
  async review(auth: AuthDto, dto: TrashReviewDto): Promise<TrashReviewResponseDto> {
    await this.requireTrashFor(dto.action);
    const ids = await this.chosenIds(auth, dto.action, dto.ids);
    const rows = await this.trashRepository.getReviewRows(auth.user.id, dto.action, ids, this.scopeOf(auth));

    if (ids && rows.length !== ids.length) {
      throw new BadRequestException(UNAVAILABLE_MESSAGE);
    }
    if (rows.length === 0) {
      throw new BadRequestException('Your trash is already empty');
    }

    return {
      action: dto.action,
      ...summarizeTrashReview(rows),
      token: trashReviewToken(auth.user.id, dto.action, rows),
    };
  }

  /**
   * Apply a reviewed action to exactly the reviewed set, or refuse. The set is resolved again in the
   * same transaction that changes it, with the same scope; any difference from the review — an item
   * restored or deleted elsewhere, locked or unlocked, hidden or revealed by a privacy filter, or a
   * session that is no longer unlocked — is a conflict and nothing changes.
   */
  async apply(auth: AuthDto, dto: TrashApplyDto): Promise<TrashResponseDto> {
    await this.requireTrashFor(dto.action);
    const ids = await this.chosenIds(auth, dto.action, dto.ids);
    const changed = await this.trashRepository.applyReviewed(
      auth.user.id,
      dto.action,
      ids,
      this.scopeOf(auth),
      (rows) =>
        rows.length > 0 &&
        (!ids || rows.length === ids.length) &&
        trashReviewToken(auth.user.id, dto.action, rows) === dto.token,
    );

    if (changed === null) {
      throw new ConflictException(CHANGED_MESSAGE);
    }

    await this.afterChange(auth, dto.action, changed);
    await this.recordUtilityActivity(auth, dto, changed);
    return { count: changed.length };
  }

  /**
   * FL-47 (owner decision on FL-146): a move to the trash, or its undo, made from Large files is kept
   * in its persistent activity history. The change is already made, so a history that cannot be
   * written (a database handoff) is logged and never turns the change into a failure.
   */
  private async recordUtilityActivity(auth: AuthDto, dto: TrashApplyDto, changed: string[]) {
    const action =
      dto.action === TrashReviewAction.Trash
        ? UtilityActivityAction.Trash
        : dto.action === TrashReviewAction.Restore
          ? UtilityActivityAction.Restore
          : undefined;
    if (dto.source !== UtilityActivityTool.LargeFiles || !action || changed.length === 0) {
      return;
    }
    try {
      const items = await this.trashRepository.getActivityItems(auth.user.id, changed);
      const recorded = await this.trashRepository.addUtilityActivity({
        userId: auth.user.id,
        tool: dto.source,
        action,
        items,
      });
      if (!recorded) {
        this.logger.warn('Utility activity not recorded: the fork schema is not writable (database handoff)');
      }
    } catch (error) {
      this.logger.warn(`Utility activity not recorded: ${error}`);
    }
  }

  /**
   * The owner's activity history for a utility (FL-47), newest first. An item is listed with its name
   * and size only while this session may still see it (Locked media only in an unlocked session,
   * nothing the privacy filters hide, nothing permanently deleted); the others are only counted.
   */
  async getUtilityActivity(auth: AuthDto, dto: UtilityActivityQueryDto): Promise<UtilityActivityResponseDto> {
    const rows = await this.trashRepository.getUtilityActivity(auth.user.id, dto.tool);
    const ids = [...new Set(rows.flatMap((row) => row.items.map((item) => item.assetId)))];
    const visible = await this.trashRepository.getVisibleIds(auth.user.id, ids, this.scopeOf(auth));
    return {
      entries: rows.map((row) => {
        const items = row.items.filter((item) => visible.has(item.assetId));
        return {
          id: row.id,
          action: row.action,
          createdAt: new Date(row.createdAt).toISOString(),
          itemCount: items.length,
          bytes: items.reduce((sum, item) => sum + toByteCount(item.bytes), 0),
          items: items.map((item) => ({ ...item, bytes: toByteCount(item.bytes) })),
          unavailableCount: row.items.length - items.length,
        };
      }),
    };
  }

  /** Tell every open tab, and queue the removal of files for permanent deletions. */
  private async afterChange(auth: AuthDto, action: TrashReviewAction, assetIds: string[]) {
    if (assetIds.length === 0) {
      return;
    }

    switch (action) {
      case TrashReviewAction.Trash: {
        await this.eventRepository.emit('AssetTrashAll', { assetIds, userId: auth.user.id });
        this.logger.log(`Moved ${assetIds.length} asset(s) to the trash`);
        break;
      }
      case TrashReviewAction.Restore:
      case TrashReviewAction.RestoreAll: {
        await this.eventRepository.emit('AssetRestoreAll', { assetIds, userId: auth.user.id });
        this.logger.log(`Restored ${assetIds.length} asset(s) from trash`);
        break;
      }
      default: {
        // `AssetDeleteAll` queues the empty-trash job, which removes each asset and its files. A
        // file another asset still names is kept (StorageService.handleDeleteFiles).
        await this.eventRepository.emit('AssetDeleteAll', { assetIds, userId: auth.user.id });
        this.logger.log(`Permanently deleted ${assetIds.length} asset(s) from the trash`);
        break;
      }
    }
  }

  /**
   * Restores chosen items. Only items still in the trash are restored and reported, so a stale
   * restore (an item already restored or permanently deleted elsewhere) changes nothing. Albums,
   * favourites, archive, tags, the lock and every other property stay as they were: trashing never
   * removed them.
   */
  async restoreAssets(auth: AuthDto, dto: BulkIdsDto): Promise<TrashResponseDto> {
    const { ids } = dto;
    if (ids.length === 0) {
      return { count: 0 };
    }

    await this.requireAccess({ auth, permission: Permission.AssetDelete, ids });
    const restored = await this.trashRepository.restoreAll(ids);
    if (restored.length > 0) {
      await this.eventRepository.emit('AssetRestoreAll', { assetIds: restored, userId: auth.user.id });
      this.logger.log(`Restored ${restored.length} asset(s) from trash`);
    }

    return { count: restored.length };
  }

  /** Restores everything in the trash this session can see (FL-34, FL-47). */
  async restore(auth: AuthDto): Promise<TrashResponseDto> {
    return this.applyUnreviewed(auth, TrashReviewAction.RestoreAll);
  }

  /**
   * Empties the trash this session can see. Locked media and anything the privacy filters hide from
   * an ordinary session stay in the trash (FL-34, FL-47).
   */
  async empty(auth: AuthDto): Promise<TrashResponseDto> {
    return this.applyUnreviewed(auth, TrashReviewAction.Empty);
  }

  /** The whole-trash actions of the original API, over the same scope as a review, without one. */
  private async applyUnreviewed(auth: AuthDto, action: TrashReviewAction.RestoreAll | TrashReviewAction.Empty) {
    const changed =
      (await this.trashRepository.applyReviewed(auth.user.id, action, undefined, this.scopeOf(auth), () => true)) ?? [];
    await this.afterChange(auth, action, changed);
    return { count: changed.length };
  }

  @OnEvent({ name: 'AssetDeleteAll' })
  async onAssetsDelete() {
    await this.jobRepository.queue({ name: JobName.AssetEmptyTrash, data: {} });
  }

  @OnJob({ name: JobName.AssetEmptyTrash, queue: QueueName.BackgroundTask })
  async handleEmptyTrash() {
    let count = 0;
    for await (const assets of batched(this.trashRepository.getDeletedIds())) {
      await this.jobRepository.queueAll(
        assets.map(({ id }) => ({ name: JobName.AssetDelete, data: { id, deleteOnDisk: true } })),
      );
      count += assets.length;
    }

    this.logger.log(`Queued ${count} asset(s) for deletion from the trash`);

    return JobStatus.Success;
  }
}
