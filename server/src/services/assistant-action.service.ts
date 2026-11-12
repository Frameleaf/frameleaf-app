import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import {
  AssistantActionListResponseDto,
  AssistantActionProposeDto,
  AssistantActionResponseDto,
  AssistantActionSearchDto,
  AssistantActionSkipped,
  AssistantActionUndo,
} from 'src/dtos/assistant.dto.js';
import {
  AccountEventAction,
  AssetType,
  AssetVisibility,
  MediaOperationBulkAction,
  MediaOperationItemStatus,
  MediaOperationStatus,
  Permission,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AccountEventRepository } from 'src/repositories/account-event.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import {
  AssistantAction,
  AssistantActionItem,
  AssistantActionRepository,
} from 'src/repositories/assistant-action.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { AssistantService } from 'src/services/assistant.service.js';
import { MediaOperationService } from 'src/services/media-operation.service.js';
import { TagService } from 'src/services/tag.service.js';
import { checkAccess, isGranted } from 'src/utils/access.js';
import {
  ASSISTANT_ACTION_PROPOSAL_HOURS,
  ASSISTANT_ACTION_SAMPLE_SIZE,
  ASSISTANT_ACTION_UNDO_DAYS,
  ASSISTANT_REJECTED_RATING,
  AssistantActionStatus,
  AssistantActionTool,
  assistantActionToolArguments,
  assistantUndoExpiry,
  planCull,
} from 'src/utils/assistant-action.js';
import {
  BULK_BATCH_SIZE,
  type BulkOperationPayload,
  bulkResumeIds,
  chunkIds,
  parseBulkResult,
  parseBulkSnapshot,
} from 'src/utils/bulk-operation.js';
import { everyOwnersRules } from 'src/utils/hidden-content.js';
import { isActiveMediaOperation } from 'src/utils/media-operation.js';

/** The default page size of the action history. */
const PAGE_SIZE = 50;

type Skipped = AssistantActionSkipped;
type NamedTarget = { id: string | null; name: string };

/** What a proposal will change, as stored in `assistant_action.plan`. */
type ActionPlan = {
  tool: AssistantActionTool;
  /** The frozen items the change covers, in the order they were asked for. */
  assetIds: string[];
  skipped: Skipped[];
  album?: NamedTarget & { description?: string };
  tags?: NamedTarget[];
  /** `cull`: the frames kept, and how many bursts are thinned out. */
  keepIds?: string[];
  bursts?: number;
};

/** What the items were before the change, as stored in `assistant_action.before`. */
type ActionBefore = {
  /** The items the change was applied to. Each was not a favourite, not in the album, not archived. */
  assetIds: string[];
  /** Left out at confirmation because they had changed since the proposal. */
  skipped: Skipped[];
  /** `tag`: for each tag, the items that did not carry it. */
  tags?: Record<string, string[]>;
  /** `tag`: tags that did not exist and were made for this change. */
  createdTagIds?: string[];
  /** `cull`: the rating each rejected frame had. */
  ratings?: Record<string, number | null>;
};

/** What a write tool needs from an API key or a connected app, to propose and confirm it. */
const APPLY_PERMISSIONS: Record<AssistantActionTool, Permission[]> = {
  create_album: [Permission.AlbumCreate, Permission.AlbumAssetCreate, Permission.AssetShare],
  add_to_album: [Permission.AlbumAssetCreate, Permission.AssetShare],
  tag: [Permission.TagAsset, Permission.AssetUpdate],
  favourite: [Permission.AssetUpdate],
  cull: [Permission.AssetUpdate],
};

/** What undoing it needs. */
const UNDO_PERMISSIONS: Record<AssistantActionTool, Permission[]> = {
  create_album: [Permission.AlbumDelete, Permission.AlbumAssetDelete],
  add_to_album: [Permission.AlbumAssetDelete],
  tag: [Permission.TagAsset],
  favourite: [Permission.AssetUpdate],
  cull: [Permission.AssetUpdate],
};

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const toIso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

/** Counts why items were left out, keeping a few ids of each reason. */
class SkipList {
  private reasons = new Map<string, string[]>();

  add(reason: string, ids: Iterable<string>) {
    const list = this.reasons.get(reason) ?? [];
    for (const id of ids) {
      list.push(id);
    }
    if (list.length > 0) {
      this.reasons.set(reason, list);
    }
  }

  toJSON(): Skipped[] {
    return [...this.reasons].map(([reason, ids]) => ({
      reason,
      count: ids.length,
      sampleAssetIds: ids.slice(0, ASSISTANT_ACTION_SAMPLE_SIZE),
    }));
  }
}

/**
 * FL-938: the assistant action journal. Frameleaf Assistant proposes a change to the library — make an
 * album, add to one, tag, favourite, cull bursts — and this service is the only way one happens.
 *
 * The rules it keeps:
 *
 * - **Nothing changes on a proposal.** `propose` reads, counts and stores a row. The frozen item set
 *   is the person's own, unlocked, visible items; anything else is counted as left out.
 * - **Only the same person's confirmation applies it.** `apply` needs `confirm: true` from the account
 *   that owns the row, re-reads every item, and records what each was in `before` ahead of any write.
 * - **Changes run on the durable bulk path** (`MediaOperationService.createBulk`), so progress,
 *   retries and Activity are the ones every other bulk change has. Two things are written directly,
 *   through the same services the bulk worker calls: the new album or tag, and a cull's Rejected rating.
 * - **Undo puts back only what the change did and nothing has touched since.** Whatever changed in
 *   between is left alone and reported. A new album is removed only when it holds nothing else.
 * - **Locked stays out.** Locked items, items hidden by a Locked rule, Locked albums and Locked tags
 *   are never proposed, applied or undone here. No tool deletes or trashes.
 */
@Injectable()
export class AssistantActionService {
  constructor(
    private logger: LoggingRepository,
    private actions: AssistantActionRepository,
    private assistant: AssistantService,
    private operations: MediaOperationService,
    private operationRepository: MediaOperationRepository,
    private assetRepository: AssetRepository,
    private tagRepository: TagRepository,
    private access: AccessRepository,
    private accountEvents: AccountEventRepository,
    private assets: AssetService,
    private albums: AlbumService,
    private tags: TagService,
  ) {
    this.logger.setContext(AssistantActionService.name);
  }

  /** Work out what a change would do and store it as a proposal. Changes nothing in the library. */
  async propose(auth: AuthDto, dto: AssistantActionProposeDto): Promise<AssistantActionResponseDto> {
    await this.assistant.requireAvailable(auth);
    this.requirePermissions(auth, APPLY_PERMISSIONS[dto.tool]);

    const target = await this.resolveTarget(auth, dto);
    const skipped = new SkipList();
    const items = await this.readItems(auth, [...new Set(dto.assetIds)], skipped);
    const change = await this.changeSet(dto.tool, target, items, skipped);
    const plan: ActionPlan = { tool: dto.tool, ...target, ...change, skipped: skipped.toJSON() };

    const action = await this.actions.create({
      userId: auth.user.id,
      question: dto.question ?? null,
      kind: dto.tool,
      status: AssistantActionStatus.Proposed,
      plan,
    });
    return this.present(action);
  }

  /** Carry out a proposal, for the person who owns it and only on their explicit confirmation. */
  async apply(auth: AuthDto, id: string): Promise<AssistantActionResponseDto> {
    await this.assistant.requireAvailable(auth);
    const action = await this.findOwned(auth, id);
    const plan = this.planOf(action);
    this.requirePermissions(auth, APPLY_PERMISSIONS[plan.tool]);
    if (action.status !== AssistantActionStatus.Proposed) {
      throw new BadRequestException('This change was already confirmed or has expired');
    }
    if (new Date(action.createdAt).getTime() < this.proposalCutoff().getTime()) {
      await this.actions.transition(id, auth.user.id, AssistantActionStatus.Proposed, {
        status: AssistantActionStatus.Expired,
      });
      throw new BadRequestException('This proposal has expired; ask again');
    }

    // Read first: the items as they are now, and what each was before anything is written.
    const skipped = new SkipList();
    const items = await this.readItems(auth, plan.assetIds, skipped);
    const target = await this.confirmTarget(auth, plan);
    const change =
      plan.tool === 'cull' ? this.confirmCull(items, skipped) : await this.changeSet(plan.tool, target, items, skipped);
    if (change.assetIds.length === 0) {
      throw new BadRequestException('Nothing is left to change; every item changed since this was proposed');
    }
    const before: ActionBefore = { assetIds: change.assetIds, skipped: skipped.toJSON() };
    if (plan.tool === 'cull') {
      before.ratings = Object.fromEntries(change.assetIds.map((assetId) => [assetId, items.get(assetId)!.rating]));
    }

    // The claim: a second confirmation finds the row no longer proposed and changes nothing.
    const appliedAt = new Date();
    const claimed = await this.actions.transition(id, auth.user.id, AssistantActionStatus.Proposed, {
      status: AssistantActionStatus.Applied,
      appliedAt,
    });
    if (!claimed) {
      throw new BadRequestException('This change was already confirmed or has expired');
    }

    let albumId = target.album?.id ?? null;
    let createdAlbumId: string | null = null;
    const createdTagIds: string[] = [];
    let mediaOperationId: string | null = null;
    try {
      if (plan.tool === 'create_album') {
        const album = await this.albums.create(auth, {
          albumName: target.album!.name,
          description: target.album!.description ?? null,
        });
        albumId = createdAlbumId = album.id;
      }
      const tags = target.tags ?? [];
      for (const tag of tags) {
        if (!tag.id) {
          const [created] = await this.tags.upsert(auth, { tags: [tag.name] });
          tag.id = created.id;
          createdTagIds.push(created.id);
        }
      }
      if (plan.tool === 'tag') {
        before.tags = {};
        for (const tag of tags) {
          const tagged = createdTagIds.includes(tag.id!)
            ? new Set<string>()
            : await this.actions.getTagMembers(tag.id!, change.assetIds);
          before.tags[tag.id!] = change.assetIds.filter((assetId) => !tagged.has(assetId));
        }
        before.createdTagIds = createdTagIds;
      }

      // What each item was is on the row before the first of them is changed.
      await this.actions.update(id, auth.user.id, {
        before,
        createdAlbumId,
        plan: {
          ...plan,
          ...(target.album && { album: { ...target.album, id: albumId } }),
          ...(tags.length > 0 && { tags }),
        },
      });

      const job = await this.queue(auth, id, this.applyAction(plan.tool), change.assetIds, {
        ...(albumId && { albumId }),
        ...(plan.tool === 'tag' && { tagIds: tags.map((tag) => tag.id!) }),
      });
      mediaOperationId = job;
      await this.actions.update(id, auth.user.id, { mediaOperationId });

      if (plan.tool === 'cull') {
        // Rejected is a rating, which no bulk action writes; it goes through the same asset update.
        for (const ids of chunkIds(change.assetIds, BULK_BATCH_SIZE)) {
          await this.assets.updateAll(auth, { ids, rating: ASSISTANT_REJECTED_RATING });
        }
      }
    } catch (error) {
      if (!mediaOperationId) {
        // Nothing was queued: take back what was made for it and leave the proposal as it was.
        await this.discardCreated(auth, createdAlbumId, createdTagIds);
        await this.actions.transition(id, auth.user.id, AssistantActionStatus.Applied, {
          status: AssistantActionStatus.Proposed,
          appliedAt: null,
          before: null,
          createdAlbumId: null,
          plan,
        });
      }
      throw error;
    }

    await this.record(auth, AccountEventAction.AssistantActionApplied, plan, target, change.assetIds.length);
    this.logger.log(`Assistant action ${id} (${plan.tool}) applied to ${change.assetIds.length} items`);
    return this.present((await this.actions.get(id, auth.user.id)) ?? claimed);
  }

  /**
   * Put back what an applied change did. Each item is restored only if it is still as the change left
   * it; anything that changed since, was never reached, is Locked now or is gone is left alone and
   * reported. Works with the assistant turned off: a change made must stay undoable.
   */
  async undo(auth: AuthDto, id: string): Promise<AssistantActionResponseDto> {
    if (auth.sharedLink) {
      throw new ForbiddenException('Frameleaf Assistant is not available from a shared link');
    }
    const action = await this.findOwned(auth, id);
    const plan = this.planOf(action);
    this.requirePermissions(auth, UNDO_PERMISSIONS[plan.tool]);
    if (action.status !== AssistantActionStatus.Applied || !action.appliedAt || !isRecord(action.before)) {
      throw new BadRequestException('Only a change that was confirmed and not yet undone can be undone');
    }
    if (assistantUndoExpiry(new Date(action.appliedAt)).getTime() <= Date.now()) {
      await this.actions.transition(id, auth.user.id, AssistantActionStatus.Applied, {
        status: AssistantActionStatus.Expired,
      });
      throw new BadRequestException(`A change can be undone for ${ASSISTANT_ACTION_UNDO_DAYS} days`);
    }
    const before = action.before as ActionBefore;

    const skipped = new SkipList();
    const unreached = await this.unreachedBy(auth, action.mediaOperationId);
    skipped.add(
      'not_applied',
      before.assetIds.filter((assetId) => unreached.has(assetId)),
    );
    const reached = before.assetIds.filter((assetId) => !unreached.has(assetId));
    const items = await this.readItems(auth, reached, skipped);

    const claimed = await this.actions.transition(id, auth.user.id, AssistantActionStatus.Applied, {
      status: AssistantActionStatus.Undone,
      undoneAt: new Date(),
    });
    if (!claimed) {
      throw new BadRequestException('Only a change that was confirmed and not yet undone can be undone');
    }

    const undo: AssistantActionUndo = {
      restored: 0,
      skipped: [],
      albumRemoved: false,
      tagsRemoved: [],
      mediaOperationIds: [],
    };
    let wrote = false;
    const job = async (action: MediaOperationBulkAction, ids: string[], payload: BulkOperationPayload = {}) => {
      if (ids.length > 0) {
        undo.mediaOperationIds.push(await this.queue(auth, id, action, ids, payload, true));
        wrote = true;
      }
    };
    try {
      switch (plan.tool) {
        case 'favourite': {
          const restore = items
            .values()
            .filter((item) => item.isFavorite)
            .map((item) => item.id)
            .toArray();
          this.addChanged(skipped, items, restore);
          await job(MediaOperationBulkAction.Unfavorite, restore);
          undo.restored = restore.length;
          break;
        }

        case 'create_album':
        case 'add_to_album': {
          const albumId = plan.tool === 'create_album' ? action.createdAlbumId : plan.album?.id;
          const album = albumId ? await this.albums.get(auth, albumId).catch(() => null) : null;
          if (!albumId || !album) {
            skipped.add('album_gone', items.keys());
            break;
          }
          const members = await this.actions.getAlbumMembers(albumId, items.keys().toArray());
          const restore = items
            .keys()
            .filter((assetId) => members.has(assetId))
            .toArray();
          this.addChanged(skipped, items, restore);
          // An album this change made goes away whole only when it is still exactly what was made.
          const added = new Set(before.assetIds);
          const unchanged =
            plan.tool === 'create_album' &&
            album.albumName === plan.album?.name &&
            (await this.actions.getAlbumAssetIds(albumId)).every((assetId) => added.has(assetId));
          if (unchanged) {
            await this.albums.delete(auth, albumId);
            wrote = true;
            undo.albumRemoved = true;
          } else {
            await job(MediaOperationBulkAction.RemoveFromAlbum, restore, { albumId });
          }
          undo.restored = restore.length;
          break;
        }

        case 'tag': {
          const restored = new Set<string>();
          const changed = new Set<string>();
          const names = new Map((plan.tags ?? []).map((tag) => [tag.id, tag.name]));
          for (const [tagId, recorded] of Object.entries(before.tags ?? {})) {
            const candidates = recorded.filter((assetId) => items.has(assetId));
            const tagged = await this.actions.getTagMembers(tagId, candidates);
            const restore = candidates.filter((assetId) => tagged.has(assetId));
            for (const assetId of candidates) {
              (tagged.has(assetId) ? restored : changed).add(assetId);
            }
            if (restore.length === 0) {
              continue;
            }
            const mine = new Set(recorded);
            const unchanged =
              (before.createdTagIds ?? []).includes(tagId) &&
              (await this.actions.getTagAssetIds(tagId)).every((assetId) => mine.has(assetId));
            if (unchanged) {
              await this.tags.remove(auth, tagId);
              wrote = true;
              undo.tagsRemoved.push(names.get(tagId) ?? tagId);
            } else {
              await job(MediaOperationBulkAction.Untag, restore, { tagIds: [tagId] });
            }
          }
          skipped.add('changed_since', changed);
          undo.restored = [...restored].filter((assetId) => !changed.has(assetId)).length;
          break;
        }

        case 'cull': {
          const ratings = before.ratings ?? {};
          const unarchive: string[] = [];
          const byRating = new Map<number | null, string[]>();
          const changed: string[] = [];
          for (const item of items.values()) {
            const archived = item.visibility === AssetVisibility.Archive;
            const rejected = item.rating === ASSISTANT_REJECTED_RATING;
            const rating = ratings[item.id] ?? null;
            if (archived) {
              unarchive.push(item.id);
            }
            if (rejected && rating !== ASSISTANT_REJECTED_RATING) {
              byRating.set(rating, [...(byRating.get(rating) ?? []), item.id]);
            }
            if (archived && rejected) {
              undo.restored++;
            } else {
              changed.push(item.id);
            }
          }
          skipped.add('changed_since', changed);
          for (const [rating, ids] of byRating) {
            for (const chunk of chunkIds(ids, BULK_BATCH_SIZE)) {
              await this.assets.updateAll(auth, { ids: chunk, rating });
              wrote = true;
            }
          }
          await job(MediaOperationBulkAction.Unarchive, unarchive);
          break;
        }
      }
    } catch (error) {
      if (!wrote) {
        await this.actions.transition(id, auth.user.id, AssistantActionStatus.Undone, {
          status: AssistantActionStatus.Applied,
          undoneAt: null,
        });
      }
      throw error;
    }

    undo.skipped = skipped.toJSON();
    await this.actions.update(id, auth.user.id, { undo });
    await this.record(auth, AccountEventAction.AssistantActionUndone, plan, plan, undo.restored);
    this.logger.log(`Assistant action ${id} (${plan.tool}) undone for ${undo.restored} items`);
    return this.present({ ...claimed, undo });
  }

  /** The person's own actions, newest first. */
  async getAll(auth: AuthDto, dto: AssistantActionSearchDto): Promise<AssistantActionListResponseDto> {
    if (auth.sharedLink) {
      throw new ForbiddenException('Frameleaf Assistant is not available from a shared link');
    }
    const take = dto.take ?? PAGE_SIZE;
    // one extra row says whether an older page exists
    const rows = await this.actions.getAll(auth.user.id, { before: dto.before, take: take + 1 });
    return { actions: rows.slice(0, take).map((row) => this.present(row)), hasMore: rows.length > take };
  }

  @OnEvent({ name: 'NightlyDatabaseCleanup' })
  async onNightlyDatabaseCleanup(): Promise<void> {
    const appliedBefore = new Date(Date.now() - ASSISTANT_ACTION_UNDO_DAYS * 24 * 60 * 60 * 1000);
    const expired = await this.actions.expire({ proposedBefore: this.proposalCutoff(), appliedBefore });
    if (expired > 0) {
      this.logger.log(`Expired ${expired} assistant actions`);
    }
  }

  private proposalCutoff() {
    return new Date(Date.now() - ASSISTANT_ACTION_PROPOSAL_HOURS * 60 * 60 * 1000);
  }

  /** Somebody else's action and one that never existed give the same answer on purpose. */
  private async findOwned(auth: AuthDto, id: string): Promise<AssistantAction> {
    const action = await this.actions.get(id, auth.user.id);
    if (!action) {
      throw new NotFoundException('Assistant action not found');
    }
    return action;
  }

  private planOf(action: AssistantAction): ActionPlan {
    const plan = action.plan as Partial<ActionPlan>;
    if (!isRecord(plan) || !Array.isArray(plan.assetIds) || !(action.kind in APPLY_PERMISSIONS)) {
      throw new BadRequestException('This change can no longer be read');
    }
    return { ...plan, tool: action.kind as AssistantActionTool } as ActionPlan;
  }

  /** An API key or a connected app proposes, confirms and undoes only what its permissions allow. */
  private requirePermissions(auth: AuthDto, requested: Permission[]) {
    if (auth.apiKey && !isGranted({ requested, current: auth.apiKey.permissions })) {
      throw new ForbiddenException(`Missing required permission: ${requested.join(', ')}`);
    }
  }

  /**
   * These items as they are now, keyed by id: the person's own, on the timeline or archived, not in
   * the trash, not Locked and not hidden by a Locked rule (whether or not this session is unlocked).
   * Everything else is added to `skipped`. A partner's item is never the person's own.
   */
  private async readItems(auth: AuthDto, ids: string[], skipped: SkipList): Promise<Map<string, AssistantActionItem>> {
    const rows = await this.actions.getItems(auth.user.id, ids);
    const found = rows.map(({ id }) => id);
    const [locked, hidden] = await Promise.all([
      this.assetRepository.getLockedAssetIds(found),
      this.assetRepository.getHiddenContentAssetIds(found, {
        hiddenContent: auth.suppressedContent,
        ...everyOwnersRules,
      }),
    ]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items = new Map<string, AssistantActionItem>();
    const missing: string[] = [];
    const withheld: string[] = [];
    for (const id of ids) {
      const item = byId.get(id);
      if (!item) {
        missing.push(id);
      } else if (locked.has(id) || hidden.has(id)) {
        withheld.push(id);
      } else {
        items.set(id, item);
      }
    }
    skipped.add('not_found', missing);
    skipped.add('locked', withheld);
    return items;
  }

  /** The album or tags a proposal names, resolved against what this person may see and write to. */
  private async resolveTarget(
    auth: AuthDto,
    dto: AssistantActionProposeDto,
  ): Promise<Pick<ActionPlan, 'album' | 'tags'>> {
    const { albumId, ...raw } = dto.arguments ?? {};
    const parsed = assistantActionToolArguments[dto.tool].safeParse(
      dto.tool === 'add_to_album' && albumId && !raw.album ? { album: albumId } : raw,
    );
    if (!parsed.success) {
      throw new BadRequestException(`These are not the arguments of ${dto.tool}`);
    }

    switch (dto.tool) {
      case 'create_album': {
        const { name, description } = parsed.data as { name: string; description?: string };
        return { album: { id: null, name, ...(description && { description }) } };
      }

      case 'add_to_album': {
        const { album: name } = parsed.data as { album: string };
        const albums = await this.albums.getAll(auth, {});
        const matches = albumId
          ? albums.filter((album) => album.id === albumId)
          : albums.filter((album) => fold(album.albumName) === fold(name));
        if (matches.length === 0) {
          throw new BadRequestException('No album of yours has that name');
        }
        if (matches.length > 1) {
          throw new BadRequestException('More than one album has that name; choose the album');
        }
        const [album] = matches;
        await this.requireWritableAlbum(auth, album);
        return { album: { id: album.id, name: album.albumName } };
      }

      case 'tag': {
        const { tags: names } = parsed.data as { tags: string[] };
        const visible = await this.tags.getAll(auth);
        const lockedTagIds = new Set(auth.suppressedContent?.tagIds);
        const tags: NamedTarget[] = [];
        for (const name of names) {
          const byPath = visible.filter((tag) => fold(tag.value) === fold(name));
          const matches = byPath.length > 0 ? byPath : visible.filter((tag) => fold(tag.name) === fold(name));
          if (matches.length > 1) {
            throw new BadRequestException(`More than one tag is called ${name}; use its full path`);
          }
          const [tag] = matches;
          if (tag) {
            if (lockedTagIds.has(tag.id)) {
              throw new BadRequestException('A Locked tag cannot be used here');
            }
            if (tags.every(({ id }) => id !== tag.id)) {
              tags.push({ id: tag.id, name: tag.value });
            }
            continue;
          }
          // A tag this session cannot see (a Locked one) is never written to, and never made twice.
          if (name.includes('/') || (await this.tagRepository.getByValue(auth.user.id, name))) {
            throw new BadRequestException(`No tag called ${name} can be used here`);
          }
          this.requirePermissions(auth, [Permission.TagCreate]);
          if (tags.every((existing) => existing.name !== name)) {
            tags.push({ id: null, name });
          }
        }
        return { tags };
      }

      default: {
        return {};
      }
    }
  }

  /** At confirmation: the album or tags of the plan are still there and still writable. */
  private async confirmTarget(auth: AuthDto, plan: ActionPlan): Promise<Pick<ActionPlan, 'album' | 'tags'>> {
    if (plan.tool === 'add_to_album') {
      const album = plan.album?.id ? await this.albums.get(auth, plan.album.id).catch(() => null) : null;
      if (!album) {
        throw new BadRequestException('The album is gone or no longer yours to add to');
      }
      await this.requireWritableAlbum(auth, album);
    }
    const tags = (plan.tags ?? []).map((tag) => ({ ...tag }));
    if (plan.tool === 'tag') {
      const lockedTagIds = new Set(auth.suppressedContent?.tagIds);
      const ids = tags.flatMap(({ id }) => (id ? [id] : []));
      const allowed =
        ids.length > 0
          ? await checkAccess(this.access, { auth, permission: Permission.TagAsset, ids })
          : new Set<string>();
      if (ids.some((tagId) => !allowed.has(tagId) || lockedTagIds.has(tagId))) {
        throw new BadRequestException('A tag is gone or can no longer be used here');
      }
      for (const tag of tags) {
        if (!tag.id && (await this.tagRepository.getByValue(auth.user.id, tag.name))) {
          throw new BadRequestException(`A tag called ${tag.name} was made since; propose the change again`);
        }
      }
    }
    return { ...(plan.album && { album: { ...plan.album } }), ...(tags.length > 0 && { tags }) };
  }

  /** A Locked album locks what is added to it and a smart album fills itself: neither is written to here. */
  private async requireWritableAlbum(auth: AuthDto, album: { id: string; isSmart?: boolean; isLocked?: boolean }) {
    if (album.isLocked) {
      throw new BadRequestException('A Locked album cannot be added to here');
    }
    if (album.isSmart) {
      throw new BadRequestException('A smart album fills itself and cannot be added to');
    }
    const allowed = await checkAccess(this.access, {
      auth,
      permission: Permission.AlbumAssetCreate,
      ids: [album.id],
    });
    if (!allowed.has(album.id)) {
      throw new BadRequestException('The album is gone or no longer yours to add to');
    }
  }

  /** Which of the readable items the change would actually change; the rest are added to `skipped`. */
  private async changeSet(
    tool: AssistantActionTool,
    target: Pick<ActionPlan, 'album' | 'tags'>,
    items: Map<string, AssistantActionItem>,
    skipped: SkipList,
  ): Promise<Pick<ActionPlan, 'assetIds' | 'keepIds' | 'bursts'>> {
    const ids = items.keys().toArray();
    let change: Set<string>;
    switch (tool) {
      case 'create_album': {
        return { assetIds: ids };
      }

      case 'favourite': {
        change = new Set(ids.filter((id) => !items.get(id)!.isFavorite));
        break;
      }

      case 'add_to_album': {
        const members = await this.actions.getAlbumMembers(target.album!.id!, ids);
        change = new Set(ids.filter((id) => !members.has(id)));
        break;
      }

      case 'tag': {
        // an item changes when it lacks any of the tags; a tag still to be made is on nothing
        change = new Set<string>();
        for (const tag of target.tags ?? []) {
          const tagged = tag.id ? await this.actions.getTagMembers(tag.id, ids) : new Set<string>();
          for (const id of ids) {
            if (!tagged.has(id)) {
              change.add(id);
            }
          }
        }
        break;
      }

      case 'cull': {
        // only photos still on the timeline take part: a video or an archived frame is not culled
        const frames = ids
          .map((id) => items.get(id)!)
          .filter((item) => item.type === AssetType.Image && item.visibility === AssetVisibility.Timeline);
        const frameIds = new Set(frames.map(({ id }) => id));
        const cull = planCull(
          frames.map((item) => ({
            id: item.id,
            takenAt: item.fileCreatedAt.getTime(),
            burstId: item.burstId,
            score: item.score,
            isFavorite: item.isFavorite,
            rating: item.rating,
          })),
        );
        skipped.add('kept', cull.keepIds);
        skipped.add('not_scored', cull.unscoredIds);
        skipped.add('not_in_burst', [...cull.singleIds, ...ids.filter((id) => !frameIds.has(id))]);
        const rejected = new Set(cull.rejectIds);
        return { assetIds: ids.filter((id) => rejected.has(id)), keepIds: cull.keepIds, bursts: cull.bursts };
      }
    }
    skipped.add(
      'already_done',
      ids.filter((id) => !change.has(id)),
    );
    return { assetIds: ids.filter((id) => change.has(id)) };
  }

  /**
   * At confirmation a cull is not planned again: the frames the person saw proposed are the ones
   * rejected. One they have since archived, favourited or starred is left alone.
   */
  private confirmCull(items: Map<string, AssistantActionItem>, skipped: SkipList): Pick<ActionPlan, 'assetIds'> {
    const reject = items
      .values()
      .filter(
        (item) =>
          item.visibility === AssetVisibility.Timeline &&
          !item.isFavorite &&
          (item.rating === null || !(item.rating > 0)),
      )
      .map(({ id }) => id)
      .toArray();
    this.addChanged(skipped, items, reject);
    return { assetIds: reject };
  }

  private applyAction(tool: AssistantActionTool): MediaOperationBulkAction {
    switch (tool) {
      case 'create_album':
      case 'add_to_album': {
        return MediaOperationBulkAction.AddToAlbum;
      }
      case 'tag': {
        return MediaOperationBulkAction.Tag;
      }
      case 'favourite': {
        return MediaOperationBulkAction.Favorite;
      }
      case 'cull': {
        return MediaOperationBulkAction.Archive;
      }
    }
  }

  /** Queue one durable bulk job for the action and answer its id. */
  private async queue(
    auth: AuthDto,
    actionId: string,
    action: MediaOperationBulkAction,
    assetIds: string[],
    payload: BulkOperationPayload,
    undo = false,
  ): Promise<string> {
    const operation = await this.operations.createBulk(auth, {
      action,
      assetIds,
      payload,
      scope: { assistantActionId: actionId, undo },
    });
    return operation.id;
  }

  /**
   * The items the apply job never changed: the ones it failed on, was refused for, or did not reach
   * before it was cancelled. Undo must not "restore" those. The job has to have stopped first.
   */
  private async unreachedBy(auth: AuthDto, mediaOperationId: string | null): Promise<Set<string>> {
    const operation = mediaOperationId
      ? await this.operationRepository.getForOwner(mediaOperationId, auth.user.id)
      : undefined;
    if (!operation) {
      return new Set();
    }
    if (isActiveMediaOperation(operation.status as MediaOperationStatus)) {
      throw new BadRequestException('This change is still being applied; wait for it to finish or cancel it first');
    }
    const snapshot = parseBulkSnapshot(operation.snapshot);
    const result = parseBulkResult(operation.result, snapshot.assetIds.length);
    return new Set([
      ...bulkResumeIds(snapshot, result, Number(operation.processedUnits ?? 0)),
      ...result.items.filter((item) => item.status !== MediaOperationItemStatus.Ok).map((item) => item.id),
    ]);
  }

  private addChanged(skipped: SkipList, items: Map<string, AssistantActionItem>, restore: string[]) {
    const restored = new Set(restore);
    skipped.add(
      'changed_since',
      items
        .keys()
        .filter((assetId) => !restored.has(assetId))
        .toArray(),
    );
  }

  /** Best effort: an album or tag made for a change that then could not be queued is taken away again. */
  private async discardCreated(auth: AuthDto, albumId: string | null, tagIds: string[]) {
    try {
      if (albumId) {
        await this.albums.delete(auth, albumId);
      }
      for (const tagId of tagIds) {
        await this.tags.remove(auth, tagId);
      }
    } catch (error) {
      this.logger.warn(`Unable to remove what an assistant action made before it failed: ${error}`);
    }
  }

  /** E16: the account activity log. A failure to record never fails the change itself. */
  private async record(
    auth: AuthDto,
    action: AccountEventAction,
    plan: ActionPlan,
    target: Pick<ActionPlan, 'album' | 'tags'>,
    count: number,
  ) {
    const subject =
      target.album?.name ?? (target.tags?.length ? target.tags.map(({ name }) => name).join(', ') : auth.user.name);
    try {
      await this.accountEvents.create({
        userId: auth.user.id,
        sessionId: auth.session?.id ?? null,
        action,
        subject,
        detail: `${plan.tool}: ${count}`,
      });
    } catch (error) {
      this.logger.error(`Unable to record account activity (${action}): ${error}`);
    }
  }

  private present(action: AssistantAction): AssistantActionResponseDto {
    const plan = (isRecord(action.plan) ? action.plan : {}) as Partial<ActionPlan>;
    const before = (isRecord(action.before) ? action.before : undefined) as Partial<ActionBefore> | undefined;
    const undo = (isRecord(action.undo) ? action.undo : undefined) as AssistantActionUndo | undefined;
    const assetIds = before?.assetIds ?? plan.assetIds ?? [];
    const appliedAt = action.appliedAt ? new Date(action.appliedAt) : null;
    const undoExpiresAt = appliedAt ? assistantUndoExpiry(appliedAt) : null;
    const now = Date.now();
    // the nightly pass writes `expired`; until it runs, a lapsed row already reads as expired
    const lapsed =
      (action.status === AssistantActionStatus.Applied && undoExpiresAt !== null && undoExpiresAt.getTime() <= now) ||
      (action.status === AssistantActionStatus.Proposed &&
        new Date(action.createdAt).getTime() < this.proposalCutoff().getTime());
    const status = lapsed ? AssistantActionStatus.Expired : action.status;
    return {
      id: action.id,
      kind: action.kind,
      status,
      question: action.question,
      total: assetIds.length,
      sampleAssetIds: assetIds.slice(0, ASSISTANT_ACTION_SAMPLE_SIZE),
      skipped: before?.skipped ?? plan.skipped ?? [],
      albumId: action.createdAlbumId ?? plan.album?.id ?? null,
      albumName: plan.album?.name ?? null,
      tags: (plan.tags ?? []).map(({ name }) => name),
      bursts: plan.bursts ?? null,
      keptAssetIds: (plan.keepIds ?? []).slice(0, ASSISTANT_ACTION_SAMPLE_SIZE),
      mediaOperationId: action.mediaOperationId,
      createdAt: new Date(action.createdAt).toISOString(),
      appliedAt: toIso(action.appliedAt),
      undoneAt: toIso(action.undoneAt),
      undoExpiresAt: toIso(undoExpiresAt),
      canUndo: status === AssistantActionStatus.Applied,
      undo: undo ?? null,
    };
  }
}
