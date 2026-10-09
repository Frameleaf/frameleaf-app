import { ConflictException, ForbiddenException } from '@nestjs/common';
import { type Transaction, sql } from 'kysely';
import type { TrashScopeOptions } from 'src/repositories/trash.repository.js';
import type { DB } from 'src/schema/index.js';
import {
  AssetStatus,
  AssetVisibility,
  DuplicateDecisionKind,
  MediaOperationBulkAction,
  MediaOperationKind,
  MediaOperationStatus,
  UserMetadataKey,
} from 'src/enum.js';
import { isGranted } from 'src/utils/access.js';
import { BULK_ACTION_PERMISSIONS, parseBulkSnapshot } from 'src/utils/bulk-operation.js';
import { withHiddenContentFilter } from 'src/utils/database.js';
import { parseDuplicateGroups } from 'src/utils/duplicate-review.js';
import { isLocked, isNotLocked } from 'src/utils/locked.js';
import { getPreferences } from 'src/utils/preferences.js';

/** Internal claim of one recorded Keepers undo; never accepted from a request or AuthDto. */
export type DuplicateUndoClaim = {
  operationId: string;
  claimToken: string;
  decisionId: string;
  duplicateId: string;
  memberIds: string[];
};

const sameSet = (left: readonly string[], right: readonly string[]) =>
  left.length === new Set(left).size && left.length === right.length && left.every((id) => right.includes(id));

/**
 * After config/item locks, acquire owner/policy -> operation -> decision, before asset locks.
 * Call again after every domain wait and at commit: row locks cannot keep a lease from expiring.
 */
export async function requireDuplicateUndoClaim(
  tx: Transaction<DB>,
  ownerId: string,
  claim: DuplicateUndoClaim,
): Promise<TrashScopeOptions> {
  const owner = await tx
    .selectFrom('user')
    .select('id')
    .where('id', '=', ownerId)
    .where('deletedAt', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (!owner) throw new ForbiddenException('duplicate_undo_owner_required');
  // Read the immutable snapshot hint only to acquire credential locks in owner/key/operation order.
  const hint = await tx
    .selectFrom('media_operation')
    .select('snapshot')
    .where('id', '=', claim.operationId)
    .executeTakeFirst();
  const snapshot = hint ? parseBulkSnapshot(hint.snapshot) : undefined;
  const key = snapshot?.apiKeyId
    ? await tx
        .selectFrom('api_key')
        .select(['id', 'userId', 'permissions'])
        .where('id', '=', snapshot.apiKeyId)
        .where('userId', '=', ownerId)
        .forShare()
        .executeTakeFirst()
    : undefined;
  if (
    snapshot?.apiKeyId &&
    (!key ||
      !isGranted({
        requested: [...BULK_ACTION_PERMISSIONS[MediaOperationBulkAction.UndoDuplicates]],
        current: key.permissions,
      }))
  )
    throw new ForbiddenException('duplicate_undo_credentials_revoked');
  const metadata = await tx
    .selectFrom('user_metadata')
    .selectAll()
    .where('userId', '=', ownerId)
    .where('key', '=', UserMetadataKey.Preferences)
    .forShare()
    .execute();
  const operation = await tx
    .selectFrom('media_operation')
    .selectAll()
    .where('id', '=', claim.operationId)
    // Block cancellation/token replacement while allowing beginUndo's FK key-share check.
    .forNoKeyUpdate()
    .executeTakeFirst();
  const live = await tx
    .selectFrom('media_operation')
    .select('id')
    .where('id', '=', claim.operationId)
    .where('ownerId', '=', ownerId)
    .where('kind', '=', MediaOperationKind.Bulk)
    .where('status', '=', MediaOperationStatus.Rendering)
    .where('claimToken', '=', claim.claimToken)
    .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
    .where('cancelRequestedAt', 'is', null)
    .where('pauseRequestedAt', 'is', null)
    .executeTakeFirst();
  if (
    !operation ||
    !live ||
    !snapshot ||
    operation.ownerId !== ownerId ||
    JSON.stringify(operation.snapshot) !== JSON.stringify(hint!.snapshot) ||
    snapshot.action !== MediaOperationBulkAction.UndoDuplicates
  )
    throw new ForbiddenException('duplicate_undo_claim_required');
  const group = parseDuplicateGroups(snapshot.payload.duplicateGroups).find(
    (group) => group.decisionId === claim.decisionId && group.duplicateId === claim.duplicateId,
  );
  const decision = await tx
    .selectFrom('duplicate_decision')
    .selectAll()
    .where('id', '=', claim.decisionId)
    .forUpdate()
    .executeTakeFirst();
  if (
    claim.memberIds.length < 2 ||
    !group ||
    group.decision !== DuplicateDecisionKind.Keepers ||
    !sameSet(group.memberIds, claim.memberIds) ||
    claim.memberIds.some((id) => !snapshot.assetIds.includes(id)) ||
    !decision ||
    decision.ownerId !== ownerId ||
    decision.duplicateId !== claim.duplicateId ||
    decision.decision !== DuplicateDecisionKind.Keepers ||
    !sameSet(decision.memberIds, claim.memberIds) ||
    !sameSet(decision.keepAssetIds, group.keepAssetIds) ||
    decision.keepAssetIds.length === 0 ||
    decision.trashAssetIds.length === 0 ||
    decision.keepAssetIds.some((id) => !claim.memberIds.includes(id)) ||
    !sameSet(
      decision.trashAssetIds,
      claim.memberIds.filter((id) => !decision.keepAssetIds.includes(id)),
    ) ||
    !decision.appliedAt ||
    decision.undoneAt ||
    decision.undoOperationId !== claim.operationId ||
    decision.state.permanent === true
  )
    throw new ConflictException('duplicate_undo_selection_changed');
  const suppression = getPreferences(metadata).privacy.suppression;
  return snapshot.elevated
    ? { lockedOwnerId: ownerId, privacy: { revealLockedOwnerId: ownerId } }
    : { privacy: { hiddenContent: { userId: ownerId, includeNsfw: false, ...suppression } } };
}

/** Re-read complete original membership under asset locks, including keepers and already restored copies. */
export async function requireDuplicateUndoSelection(
  tx: Transaction<DB>,
  ownerId: string,
  claim: DuplicateUndoClaim,
  restoreIds: string[],
  options: TrashScopeOptions,
  restored = false,
): Promise<void> {
  const decision = await tx
    .selectFrom('duplicate_decision')
    .select(['trashAssetIds'])
    .where('id', '=', claim.decisionId)
    .executeTakeFirstOrThrow();
  const members = await tx
    .selectFrom('asset')
    .select(['id', 'ownerId', 'status', 'deletedAt', 'duplicateId'])
    .select(isLocked('asset').as('locked'))
    .where('id', 'in', claim.memberIds)
    .execute();
  const visible = await tx
    .selectFrom('asset')
    .select('id')
    .where('id', 'in', claim.memberIds)
    .where('ownerId', '=', ownerId)
    .where('visibility', '!=', AssetVisibility.Hidden)
    .$if(options.lockedOwnerId !== ownerId, (qb) => qb.where(isNotLocked('asset')))
    .$call((qb) => withHiddenContentFilter(qb, options.privacy))
    .execute();
  if (
    visible.length !== claim.memberIds.length ||
    members.length !== claim.memberIds.length ||
    members.some(
      (asset) =>
        asset.ownerId !== ownerId ||
        asset.status === AssetStatus.Deleted ||
        (asset.duplicateId !== null && asset.duplicateId !== claim.duplicateId) ||
        (!decision.trashAssetIds.includes(asset.id) && asset.deletedAt !== null) ||
        (options.lockedOwnerId !== ownerId && asset.locked),
    ) ||
    restoreIds.some((id) => !decision.trashAssetIds.includes(id)) ||
    (!restored &&
      !sameSet(
        members.filter((asset) => asset.status === AssetStatus.Trashed).map((asset) => asset.id),
        restoreIds,
      )) ||
    (restored && members.some((asset) => asset.status !== AssetStatus.Active || asset.deletedAt !== null))
  )
    throw new ConflictException('duplicate_undo_selection_changed');
}
