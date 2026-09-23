import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetBulkUpdateDto } from 'src/dtos/asset.dto.js';
import {
  DuplicateActiveOperationDto,
  DuplicateDecisionBatchDto,
  DuplicateDecisionGroupDto,
  DuplicateDecisionHistoryDto,
  DuplicateReviewGroupDto,
} from 'src/dtos/duplicate-review.dto.js';
import {
  AssetStatus,
  DuplicateDecisionKind,
  DuplicateGroupBlock,
  DuplicateGroupKind,
  MediaOperationItemStatus,
  MediaOperationStatus,
  Permission,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import {
  DuplicateAssetState,
  DuplicateDecision,
  DuplicateDecisionRepository,
  DuplicateKeeperState,
} from 'src/repositories/duplicate-decision.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { DuplicateService } from 'src/services/duplicate.service.js';
import { StackService } from 'src/services/stack.service.js';
import { TagService } from 'src/services/tag.service.js';
import { TrashService } from 'src/services/trash.service.js';
import { checkAccess } from 'src/utils/access.js';
import { BulkOperationItem, bulkErrorMessage, classifyBulkError } from 'src/utils/bulk-operation.js';
import {
  DuplicateGroupDecision,
  classifyDuplicateGroup,
  duplicateQualityReasons,
  duplicateStackPrimary,
  duplicateTrashIds,
  parseDuplicateGroups,
} from 'src/utils/duplicate-review.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import { isActiveMediaOperation } from 'src/utils/media-operation.js';

/** How many recent decision jobs the review keeps undoable across a reload. */
export const DUPLICATE_DECISION_HISTORY = 10;

/** Stable reasons the client translates. Never a raw server message. */
export const DuplicateDecisionReason = {
  /** The group's photos changed after the owner reviewed it: review it again. */
  Changed: 'frameleaf_bulk_reason_group_changed',
  /** Something changed after the decision, so undoing it would overwrite a newer change. */
  UndoChanged: 'frameleaf_bulk_reason_group_undo_changed',
  /** A trashed copy has since been deleted permanently; the decision can no longer be undone. */
  Deleted: 'frameleaf_bulk_reason_group_deleted',
  /** The decision is already undone, or another undo is working on it. */
  Undone: 'frameleaf_bulk_reason_group_undone',
  NotOwner: 'frameleaf_bulk_reason_not_owner',
  NoPermission: 'frameleaf_bulk_reason_no_permission',
  NotFound: 'frameleaf_bulk_reason_not_found',
  Failed: 'frameleaf_bulk_reason_failed',
} as const;

type KeeperStates = Record<string, DuplicateKeeperState>;
type DecisionState = { before?: KeeperStates; after?: KeeperStates; permanent?: boolean };

const sameSet = (left: readonly string[], right: readonly string[]) => {
  const a = new Set(left);
  return a.size === new Set(right).size && [...a].every((id) => right.includes(id));
};

const answer = (ids: readonly string[], status: MediaOperationItemStatus, reasonKey?: string, message?: string) =>
  ids.map((id): BulkOperationItem => ({
    id,
    status,
    ...(reasonKey && { reasonKey }),
    ...(message && { message }),
  }));

const ok = (ids: readonly string[]) => answer(ids, MediaOperationItemStatus.Ok);
const skipped = (ids: readonly string[], reasonKey: string) => answer(ids, MediaOperationItemStatus.Skipped, reasonKey);
const failed = (ids: readonly string[], message: string) =>
  answer(ids, MediaOperationItemStatus.Failed, DuplicateDecisionReason.Failed, message);
const refusedAll = (ids: readonly string[], error: unknown) => {
  const { status, reasonKey } = classifyBulkError(error);
  return answer(ids, status, reasonKey, bulkErrorMessage(error));
};

const keeperStatesOf = (map: Map<string, DuplicateKeeperState>): KeeperStates => Object.fromEntries(map);

const readState = (decision: DuplicateDecision): DecisionState => {
  const state = (decision.state ?? {}) as DecisionState;
  return { before: state.before ?? {}, after: state.after ?? {}, permanent: state.permanent === true };
};

/** How far a job's retry lineage is followed back when deciding whether it may carry on a decision. */
const LINEAGE_DEPTH = 10;

/**
 * Duplicate review decisions (FL-61): the review list, the history an undo is made from, and the
 * worker side of the two durable actions that apply and reverse decisions.
 *
 * The rules it keeps:
 *
 * - **Actor only.** A group is decided by the owner of every photo in it, as that owner, and only
 *   when the owner saw all of it. A group with a photo the session may not see, or another account's
 *   photo, is never decided on the part that was shown.
 * - **A group is decided whole, as it was reviewed.** When the job reaches a group it compares the
 *   group's current photos with the ones the owner reviewed; a group that changed in between is
 *   skipped for the owner to review again, never decided on a guess.
 * - **Existing behaviour does the work.** Keeping chosen photos is `DuplicateService.resolve` (its
 *   album, tag, favourite and metadata merge included), keeping all is dismissing the group, stacking
 *   is `StackService.create`. Nothing here writes a photo's state itself except putting a group's id
 *   back on an undo.
 * - **Originals are never touched.** A decision trashes, stacks or dismisses; storage is released only
 *   when the trash is emptied, and a trashed copy can be restored by the undo until then.
 * - **Idempotent.** Every decision is recorded before anything changes. A batch applied again — a
 *   worker that died, the automatic retry — finds its record and finishes the group instead of
 *   deciding it twice.
 * - **Undo never overwrites newer work.** It reverses a decision only while its photos are where the
 *   decision left them, restores keeper fields only where nothing has changed them since, and never
 *   unlocks anything.
 */
@Injectable()
export class DuplicateDecisionService {
  constructor(
    private logger: LoggingRepository,
    private repository: DuplicateDecisionRepository,
    private access: AccessRepository,
    private duplicates: DuplicateService,
    private assets: AssetService,
    private albums: AlbumService,
    private tags: TagService,
    private stacks: StackService,
    private trash: TrashService,
  ) {
    this.logger.setContext(DuplicateDecisionService.name);
  }

  /* ------------------------------------------------------------------------ */
  /* Reads                                                                      */
  /* ------------------------------------------------------------------------ */

  /**
   * The owner's duplicate groups, each read as a whole. Built on `DuplicateService.getDuplicates`, so
   * the list, its session filters and its keeper suggestion are exactly the existing ones; this adds
   * how the group reads (copies or burst), the evidence behind the suggestion and whether the session
   * may decide it.
   */
  async getReview(auth: AuthDto): Promise<DuplicateReviewGroupDto[]> {
    const groups = await this.duplicates.getDuplicates(auth);
    const members = await this.repository.getGroupMembers(groups.map(({ duplicateId }) => duplicateId));
    const byGroup = new Map<string, typeof members>();
    for (const member of members) {
      const list = byGroup.get(member.duplicateId);
      if (list) {
        list.push(member);
      } else {
        byGroup.set(member.duplicateId, [member]);
      }
    }

    return groups.map((group) => {
      const all = byGroup.get(group.duplicateId) ?? [];
      const shown = new Set(group.assets.map(({ id }) => id));
      const otherOwner = all.some((member) => member.ownerId !== auth.user.id);
      const hiddenMemberCount = all.filter((member) => member.ownerId === auth.user.id && !shown.has(member.id)).length;
      const blockedReason = otherOwner
        ? DuplicateGroupBlock.OtherOwner
        : hiddenMemberCount > 0
          ? DuplicateGroupBlock.HiddenMembers
          : null;
      const kind = classifyDuplicateGroup(group.assets);
      const reasons = duplicateQualityReasons(group.assets);

      return {
        duplicateId: group.duplicateId,
        assets: group.assets,
        // related burst frames are different moments, never disposable copies (FL-61)
        suggestedKeepAssetIds: kind === DuplicateGroupKind.Burst ? [] : group.suggestedKeepAssetIds,
        kind,
        editable: blockedReason === null,
        blockedReason,
        hiddenMemberCount,
        totalBytes: group.assets.reduce((sum, asset) => sum + (asset.exifInfo?.fileSizeInByte ?? 0), 0),
        qualities: group.assets.map((asset) => ({ assetId: asset.id, reasons: reasons.get(asset.id) ?? [] })),
      };
    });
  }

  /**
   * What the review needs after a reload: the recent decision jobs it can offer to undo, and the jobs
   * still running, so their groups keep their loaders.
   *
   * A session that has not unlocked Locked items is never told a Locked photo's id: a decision whose
   * photos include one that has been locked since is left out (its undo needs the unlocked session
   * anyway), and so is a running job's group that holds one.
   */
  async getHistory(auth: AuthDto): Promise<DuplicateDecisionHistoryDto> {
    const [decisions, operations] = await Promise.all([
      this.repository.listRecent(auth.user.id, DUPLICATE_DECISION_HISTORY),
      this.repository.listActiveOperations(auth.user.id),
    ]);

    const activeGroups = operations.map((operation) => ({
      operation,
      groups: parseDuplicateGroups(operation.duplicateGroups),
    }));

    const ids = new Set<string>();
    for (const decision of decisions) {
      for (const id of decision.memberIds) ids.add(id);
    }
    for (const { groups } of activeGroups) {
      for (const group of groups) for (const id of group.memberIds) ids.add(id);
    }
    const locked = getLockedOwnerId(auth) ? new Set<string>() : await this.repository.getLockedIds([...ids]);
    const visible = (memberIds: readonly string[]) => memberIds.every((id) => !locked.has(id));

    const running = new Set(operations.map(({ id }) => id));
    const batches = new Map<string, DuplicateDecisionBatchDto>();
    for (const decision of decisions) {
      // a decision its job closed without applying never happened as far as the owner is concerned
      const closed = !decision.appliedAt && !!decision.undoneAt;
      if (!decision.operationId || closed || !visible(decision.memberIds)) {
        continue;
      }
      const createdAt = new Date(decision.createdAt as unknown as string | Date).toISOString();
      const batch = batches.get(decision.operationId) ?? {
        operationId: decision.operationId,
        createdAt,
        groups: [],
        undoable: true,
      };
      const group: DuplicateDecisionGroupDto = {
        decisionId: decision.id,
        duplicateId: decision.duplicateId,
        decision: decision.decision,
        memberIds: decision.memberIds,
        keepAssetIds: decision.keepAssetIds,
        trashAssetIds: decision.trashAssetIds,
        applied: !!decision.appliedAt,
        undone: !!decision.undoneAt,
        // an undo whose job ended without finishing no longer holds the decision (`beginUndo`)
        undoing: !!decision.undoOperationId && !decision.undoneAt && running.has(decision.undoOperationId),
      };
      batch.groups.push(group);
      // with the trash off the removed copies were deleted for good: nothing to bring back
      const permanent = readState(decision).permanent === true;
      batch.undoable &&= group.applied && !group.undone && !group.undoing && !permanent;
      if (createdAt > batch.createdAt) {
        batch.createdAt = createdAt;
      }
      batches.set(decision.operationId, batch);
    }

    const active: DuplicateActiveOperationDto[] = activeGroups.map(({ operation, groups }) => ({
      operationId: operation.id,
      action: operation.action,
      groups: groups
        .filter((group) => visible(group.memberIds))
        .map(({ duplicateId, memberIds }) => ({ duplicateId, memberIds })),
    }));

    return {
      recent: batches
        .values()
        .toArray()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      active: active.filter(({ groups }) => groups.length > 0),
    };
  }

  /** Which of these photos are Locked now (FL-34: the lock record). */
  getLockedIds(assetIds: string[]): Promise<Set<string>> {
    return this.repository.getLockedIds(assetIds);
  }

  /* ------------------------------------------------------------------------ */
  /* The worker: apply                                                          */
  /* ------------------------------------------------------------------------ */

  /**
   * Apply one group's decision for the job `operationId`, as the owner (`auth` is the bulk worker's
   * owner session). Answers for every member of the group, all the same way.
   */
  async applyGroup(auth: AuthDto, operationId: string, group: DuplicateGroupDecision): Promise<BulkOperationItem[]> {
    const ownerId = auth.user.id;
    const ids = group.memberIds;

    let decision = await this.repository.getForOperation(ownerId, operationId, group.duplicateId);
    if (decision?.appliedAt) {
      // this batch was applied before the worker could record it: nothing to do twice
      return ok(ids);
    }

    if (!decision) {
      // Another job started this group and did not finish it. A retry of that job finishes it — the
      // same decision only; a job still running elsewhere keeps it; and a job that ended with nobody
      // retrying it gives it up, so the group can be decided again (from what it is now: whatever
      // that job did change is caught by the membership check below).
      const unfinished = await this.repository.getUnfinished(ownerId, group.duplicateId);
      if (unfinished) {
        const claim = await this.claimOf(unfinished, operationId);
        if (claim === 'running') {
          return skipped(ids, DuplicateDecisionReason.Changed);
        }
        if (claim === 'retry') {
          if (!this.samePlan(unfinished, group)) {
            return skipped(ids, DuplicateDecisionReason.Changed);
          }
          await this.repository.adopt(unfinished.id, operationId);
          decision = { ...unfinished, operationId };
        } else {
          await this.repository.close(unfinished.id);
        }
      }
    }

    if (!decision) {
      const refusal = await this.checkGroup(auth, group);
      if (refusal) {
        return skipped(ids, refusal);
      }

      const trashAssetIds = duplicateTrashIds(group);
      const before =
        group.decision === DuplicateDecisionKind.Keepers
          ? keeperStatesOf(await this.repository.getKeeperStates(group.keepAssetIds))
          : {};
      decision = await this.repository.create({
        ownerId,
        duplicateId: group.duplicateId,
        operationId,
        decision: group.decision,
        memberIds: group.memberIds,
        keepAssetIds: group.decision === DuplicateDecisionKind.KeepAll ? group.memberIds : group.keepAssetIds,
        trashAssetIds,
        state: { before },
      });
    }

    try {
      const outcome = await this.applyRecorded(auth, decision);
      if (outcome) {
        return failed(ids, outcome);
      }
    } catch (error) {
      this.logger.warn(`Duplicate decision ${decision.id} did not finish: ${bulkErrorMessage(error)}`);
      return refusedAll(ids, error);
    }

    return ok(ids);
  }

  /**
   * Who may carry on a decision another job started: a retry of that job (`retry`), nobody while that
   * job is still running (`running`), or anybody once it has ended with no retry (`abandoned`).
   */
  private async claimOf(decision: DuplicateDecision, operationId: string): Promise<'retry' | 'running' | 'abandoned'> {
    if (!decision.operationId) {
      return 'abandoned';
    }

    let current = await this.repository.getOperation(operationId);
    for (let depth = 0; current?.retryOfId && depth < LINEAGE_DEPTH; depth++) {
      if (current.retryOfId === decision.operationId) {
        return 'retry';
      }
      current = await this.repository.getOperation(current.retryOfId);
    }

    return (await this.isRunning(decision.operationId)) ? 'running' : 'abandoned';
  }

  /** Whether a durable job is still queued, running, paused or waiting for its automatic retry. */
  private async isRunning(operationId: string): Promise<boolean> {
    const operation = await this.repository.getOperation(operationId);
    return !!operation && isActiveMediaOperation(operation.status as MediaOperationStatus);
  }

  /** Whether a recorded decision is the same one this group asks for. */
  private samePlan(decision: DuplicateDecision, group: DuplicateGroupDecision): boolean {
    const keep = group.decision === DuplicateDecisionKind.KeepAll ? group.memberIds : group.keepAssetIds;
    return (
      decision.decision === group.decision &&
      sameSet(decision.memberIds, group.memberIds) &&
      sameSet(decision.keepAssetIds, keep) &&
      (group.decision !== DuplicateDecisionKind.Stack ||
        duplicateStackPrimary(decision) === duplicateStackPrimary(group))
    );
  }

  /**
   * Why this group may not be decided now, or null. Checked once, before the decision is recorded:
   * every photo is the owner's, the group is exactly the photos they reviewed, and they may change
   * (and, for `keepers`, trash) every one of them.
   */
  private async checkGroup(auth: AuthDto, group: DuplicateGroupDecision): Promise<string | null> {
    const members = await this.repository.getGroupMembers([group.duplicateId]);
    // a group that does not exist and one holding another account's photo answer the same way, so a
    // crafted group id tells nobody anything
    if (members.length === 0 || members.some((member) => member.ownerId !== auth.user.id)) {
      return DuplicateDecisionReason.NotFound;
    }
    const memberIds = members.map(({ id }) => id);
    if (!sameSet(memberIds, group.memberIds)) {
      return DuplicateDecisionReason.Changed;
    }

    const updatable = await checkAccess(this.access, {
      auth,
      permission: Permission.AssetUpdate,
      ids: group.memberIds,
    });
    if (updatable.size !== group.memberIds.length) {
      return DuplicateDecisionReason.NoPermission;
    }

    const trashAssetIds = duplicateTrashIds(group);
    if (trashAssetIds.length > 0) {
      const deletable = await checkAccess(this.access, {
        auth,
        permission: Permission.AssetDelete,
        ids: trashAssetIds,
      });
      if (deletable.size !== trashAssetIds.length) {
        return DuplicateDecisionReason.NoPermission;
      }
    }

    return null;
  }

  /**
   * Carry out a recorded decision from wherever it stands, then complete it. Returns a message when
   * it could not be completed (the batch reports the group as failed, and the retry tries again).
   */
  private async applyRecorded(auth: AuthDto, decision: DuplicateDecision): Promise<string | null> {
    let stackId: string | null = decision.stackId;
    let permanent = false;

    // Whatever is resumed, the group may hold nothing the owner did not review: a photo that joined
    // it since, or one the review never showed, is never kept, stacked or trashed on their behalf.
    const current = (await this.repository.getGroupMembers([decision.duplicateId])).map(({ id }) => id);
    if (current.some((id) => !decision.memberIds.includes(id))) {
      return 'A photo joined this duplicate group while the decision was being applied';
    }

    switch (decision.decision) {
      case DuplicateDecisionKind.Keepers: {
        const problem = await this.applyKeepers(auth, decision, current);
        if (problem) {
          return problem;
        }
        // with the trash off, resolve deletes for good; such a decision can never be undone
        const trashed = await this.repository.getAssetStates(decision.trashAssetIds);
        permanent =
          trashed.length < decision.trashAssetIds.length ||
          trashed.some((state) => state.status === AssetStatus.Deleted);
        break;
      }

      case DuplicateDecisionKind.KeepAll: {
        // dismiss exactly the reviewed photos; `DuplicateService.delete` would take the whole group
        await this.repository.unlink(auth.user.id, decision.memberIds, decision.duplicateId);
        break;
      }

      case DuplicateDecisionKind.Stack: {
        stackId = await this.applyStack(auth, decision);
        break;
      }
    }

    const { before } = readState(decision);
    const after =
      decision.decision === DuplicateDecisionKind.Keepers
        ? keeperStatesOf(await this.repository.getKeeperStates(decision.keepAssetIds))
        : {};
    await this.repository.markApplied(decision.id, { stackId, state: { before, after, permanent } });
    return null;
  }

  /**
   * Keep the chosen photos and trash the rest through `DuplicateService.resolve`, which merges the
   * group's albums, tags, favourite, rating, description and location into a single keeper.
   *
   * On a replay only the photos still in the group are sent: a keeper the first attempt already
   * released is not sent again, so its metadata is not merged twice.
   */
  private async applyKeepers(
    auth: AuthDto,
    decision: DuplicateDecision,
    current: readonly string[],
  ): Promise<string | null> {
    if (current.length > 0) {
      const keepAssetIds = decision.keepAssetIds.filter((id) => current.includes(id));
      const trashAssetIds = decision.trashAssetIds.filter((id) => current.includes(id));
      const [result] = await this.duplicates.resolve(auth, {
        groups: [{ duplicateId: decision.duplicateId, keepAssetIds, trashAssetIds }],
      });
      if (!result?.success) {
        return result?.errorMessage ?? result?.error ?? 'The duplicate group could not be resolved';
      }
    }

    // where every photo stands now is what counts: keepers kept, every other copy out of the library
    const found = await this.repository.getAssetStates(decision.memberIds);
    const states = new Map(found.map((state) => [state.id, state]));
    const keptOut = decision.keepAssetIds.some((id) => !states.get(id) || states.get(id)?.deletedAt);
    const notTrashed = decision.trashAssetIds.some((id) => {
      const state = states.get(id);
      return !!state && !state.deletedAt;
    });
    if (keptOut || notTrashed) {
      return 'The duplicate group did not end up as decided';
    }
    return null;
  }

  /** Stack the whole group with its cover on top, then dismiss the group. Returns the stack id. */
  private async applyStack(auth: AuthDto, decision: DuplicateDecision): Promise<string> {
    const states = await this.repository.getAssetStates(decision.memberIds);
    const stackIds = new Set(states.map((state) => state.stackId));
    let stackId = stackIds.size === 1 ? [...stackIds][0] : null;

    // a replay finds the stack its first attempt made: every reviewed photo, and nothing else
    const made = stackId ? sameSet(await this.repository.getStackAssetIds(stackId), decision.memberIds) : false;
    if (!stackId || !made || states.length !== decision.memberIds.length) {
      const primary = duplicateStackPrimary(decision);
      const stack = await this.stacks.create(auth, {
        assetIds: [primary, ...decision.memberIds.filter((id) => id !== primary)],
      });
      stackId = stack.id;
    }

    // dismiss exactly the reviewed photos from the group
    await this.repository.unlink(auth.user.id, decision.memberIds, decision.duplicateId);
    return stackId;
  }

  /* ------------------------------------------------------------------------ */
  /* The worker: undo                                                           */
  /* ------------------------------------------------------------------------ */

  /**
   * Reverse one recorded decision for the undo job `operationId`, as the owner. Answers for every
   * member of the group, all the same way.
   */
  async undoGroup(auth: AuthDto, operationId: string, group: DuplicateGroupDecision): Promise<BulkOperationItem[]> {
    const ids = group.memberIds;
    const decision = group.decisionId ? await this.repository.getById(auth.user.id, group.decisionId) : undefined;
    if (!decision || decision.duplicateId !== group.duplicateId || !sameSet(decision.memberIds, group.memberIds)) {
      return skipped(ids, DuplicateDecisionReason.NotFound);
    }

    if (decision.undoneAt) {
      return decision.undoOperationId === operationId ? ok(ids) : skipped(ids, DuplicateDecisionReason.Undone);
    }
    if (readState(decision).permanent) {
      return skipped(ids, DuplicateDecisionReason.Deleted);
    }
    if (!decision.appliedAt) {
      return skipped(ids, DuplicateDecisionReason.Changed);
    }

    // A replayed batch carries on with the undo it started. So does a new undo when the one that
    // started it has ended without finishing: that undo was checked, and every step is safe to repeat,
    // while checking again would read its half-done work as a change. A new undo checks and claims.
    if (decision.undoOperationId !== operationId) {
      const stalled = !!decision.undoOperationId && !(await this.isRunning(decision.undoOperationId));
      if (decision.undoOperationId && !stalled) {
        return skipped(ids, DuplicateDecisionReason.Undone);
      }
      if (!stalled) {
        const refusal = await this.checkUndo(auth, decision);
        if (refusal) {
          return skipped(ids, refusal);
        }
      }
      if (!(await this.repository.beginUndo(decision.id, operationId, decision.undoOperationId ?? undefined))) {
        return skipped(ids, DuplicateDecisionReason.Undone);
      }
    }

    try {
      await this.undoRecorded(auth, decision);
    } catch (error) {
      this.logger.warn(`Undo of duplicate decision ${decision.id} did not finish: ${bulkErrorMessage(error)}`);
      return refusedAll(ids, error);
    }

    await this.repository.markUndone(decision.id);
    return ok(ids);
  }

  /**
   * Why this decision cannot be undone now, or null. Its photos must still be the owner's and where
   * it left them: kept photos in the library, trashed ones still in the trash (not deleted for good),
   * none of them in another group since, and a stack it made still exactly the group.
   */
  private async checkUndo(auth: AuthDto, decision: DuplicateDecision): Promise<string | null> {
    const found = await this.repository.getAssetStates(decision.memberIds);
    const states = new Map(found.map((state) => [state.id, state]));
    const trashed = new Set(decision.trashAssetIds);

    for (const id of decision.memberIds) {
      const state = states.get(id);
      if (!state || state.status === AssetStatus.Deleted) {
        return trashed.has(id) ? DuplicateDecisionReason.Deleted : DuplicateDecisionReason.UndoChanged;
      }
      if (state.ownerId !== auth.user.id) {
        return DuplicateDecisionReason.NotFound;
      }
      if (state.duplicateId && state.duplicateId !== decision.duplicateId) {
        return DuplicateDecisionReason.UndoChanged;
      }
      if (!trashed.has(id) && state.deletedAt) {
        return DuplicateDecisionReason.UndoChanged;
      }
    }

    if (decision.decision === DuplicateDecisionKind.Stack && decision.stackId) {
      const stacked = await this.repository.getStackAssetIds(decision.stackId);
      if (stacked.length > 0 && !sameSet(stacked, decision.memberIds)) {
        return DuplicateDecisionReason.UndoChanged;
      }
    }

    const updatable = await checkAccess(this.access, {
      auth,
      permission: Permission.AssetUpdate,
      ids: decision.memberIds,
    });
    if (updatable.size !== decision.memberIds.length) {
      return DuplicateDecisionReason.NoPermission;
    }
    return null;
  }

  /** The reversal itself. Every step is safe to repeat, so a replayed batch simply runs it again. */
  private async undoRecorded(auth: AuthDto, decision: DuplicateDecision): Promise<void> {
    if (decision.decision === DuplicateDecisionKind.Stack && decision.stackId) {
      const stacked = await this.repository.getStackAssetIds(decision.stackId);
      if (stacked.length > 0) {
        await this.stacks.delete(auth, decision.stackId);
      }
    }

    if (decision.decision === DuplicateDecisionKind.Keepers) {
      const states = await this.repository.getAssetStates(decision.trashAssetIds);
      const inTrash = states.filter((state: DuplicateAssetState) => state.status === AssetStatus.Trashed);
      if (inTrash.length > 0) {
        await this.trash.restoreAssets(auth, { ids: inTrash.map(({ id }) => id) });
      }
      await this.restoreKeepers(auth, decision);
    }

    await this.repository.relink(auth.user.id, decision.memberIds, decision.duplicateId);
  }

  /**
   * Put back what the decision's metadata merge changed on each keeper, field by field, only where
   * the field still holds what the decision left: a newer edit always wins. Albums and tags the merge
   * added are taken off again; ones the keeper had before stay. A keeper's visibility is never changed
   * while it is Locked, so an undo can never unlock anything.
   */
  private async restoreKeepers(auth: AuthDto, decision: DuplicateDecision): Promise<void> {
    const { before = {}, after = {} } = readState(decision);
    const keepers = decision.keepAssetIds.filter((id) => before[id] && after[id]);
    if (keepers.length === 0) {
      return;
    }

    const current = await this.repository.getKeeperStates(keepers);
    const locked = await this.repository.getLockedIds(keepers);

    for (const id of keepers) {
      const was = before[id];
      const left = after[id];
      const now = current.get(id);
      if (!now) {
        continue;
      }

      const update: Omit<AssetBulkUpdateDto, 'ids'> = {};
      if (now.isFavorite === left.isFavorite && was.isFavorite !== left.isFavorite) {
        update.isFavorite = was.isFavorite;
      }
      if (!locked.has(id) && now.visibility === left.visibility && was.visibility !== left.visibility) {
        update.visibility = was.visibility;
      }
      if (now.rating === left.rating && was.rating !== left.rating) {
        update.rating = was.rating;
      }
      if (now.description === left.description && was.description !== left.description) {
        update.description = was.description;
      }
      const locationKept = now.latitude === left.latitude && now.longitude === left.longitude;
      if (
        locationKept &&
        (was.latitude !== left.latitude || was.longitude !== left.longitude) &&
        was.latitude !== null &&
        was.longitude !== null
      ) {
        update.latitude = was.latitude;
        update.longitude = was.longitude;
      }
      if (Object.keys(update).length > 0) {
        await this.assets.updateAll(auth, { ids: [id], ...update } as AssetBulkUpdateDto);
      }

      for (const albumId of left.albumIds) {
        if (!was.albumIds.includes(albumId) && now.albumIds.includes(albumId)) {
          await this.albums.removeAssets(auth, albumId, { ids: [id] });
        }
      }
      for (const tagId of left.tagIds) {
        if (!was.tagIds.includes(tagId) && now.tagIds.includes(tagId)) {
          await this.tags.removeAssets(auth, tagId, { ids: [id] });
        }
      }
    }
  }
}
