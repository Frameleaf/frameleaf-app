import { Injectable } from '@nestjs/common';
import type { HiddenContentFilter } from 'src/utils/hidden-content.js';
import { AssetLockReason } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { PartnerLockedNoticeService } from 'src/services/partner-locked-notice.service.js';
import { getPreferences } from 'src/utils/preferences.js';

export type PartnerLockInput = {
  /** The item the copy was made from, owned by `sourceOwnerId` (the sharing partner). */
  sourceAssetId: string;
  sourceOwnerId: string;
  /** The recipient's copy. */
  targetAssetId: string;
  targetOwnerId: string;
};

/**
 * Locked sharing for partner copies (FL-326, spec §4.9). Replaces the FL-137 partner-sync path that sent
 * a partner's Locked items with their metadata blanked: the recipient now gets a real copy that is locked
 * in their own library, so only their own PIN (an elevated session) shows it, like any of their own
 * Locked items.
 *
 * A copy is locked when its source is:
 * - locked (an `asset_lock` record): the copy gets the same reason;
 * - hidden by the partner's Locked rules (suppressed people and tags): the copy is locked as `marked`,
 *   because the rule is the partner's preference and never becomes the recipient's.
 *
 * While the copy follows its source (its owner never changed its visibility), a later lock or unlock of
 * the source carries over (`mirrorLockedState` from propagation). A recipient without a PIN cannot open
 * the copy and gets the one-time notice (`PartnerLockedNoticeService`).
 */
@Injectable()
export class PartnerLockService extends BaseService {
  /**
   * The lock a copy of this source must carry, decided before the copy exists so it can be inserted
   * already locked (never visible without the recipient's PIN, even for a moment or after a failed step).
   */
  async getCopyLockReason(
    input: Pick<PartnerLockInput, 'sourceAssetId' | 'sourceOwnerId'>,
  ): Promise<AssetLockReason | undefined> {
    const [source] = await this.assetRepository.getLockReasons([input.sourceAssetId]);
    return source?.reason ?? ((await this.isHiddenByRules(input)) ? AssetLockReason.Marked : undefined);
  }

  /** Flag the recipient's one-time "set a PIN" notice for a copy that arrived locked. */
  async noteLockedCopy(targetOwnerId: string): Promise<void> {
    await BaseService.create(PartnerLockedNoticeService, this).noteLockedCopy(targetOwnerId);
  }

  async mirrorLockedState(input: PartnerLockInput): Promise<'locked' | 'unlocked' | 'unchanged'> {
    const { sourceAssetId, targetAssetId, targetOwnerId } = input;
    const reasons = await this.assetRepository.getLockReasons([sourceAssetId, targetAssetId]);
    const sourceReason = reasons.find(({ assetId }) => assetId === sourceAssetId)?.reason;
    const targetLocked = reasons.some(({ assetId }) => assetId === targetAssetId);

    const reason = sourceReason ?? ((await this.isHiddenByRules(input)) ? AssetLockReason.Marked : undefined);
    if (reason && !targetLocked) {
      await this.assetRepository.lock([targetAssetId], reason, null);
      await BaseService.create(PartnerLockedNoticeService, this).noteLockedCopy(targetOwnerId);
      return 'locked';
    }
    if (!reason && targetLocked) {
      await this.assetRepository.unlock([targetAssetId]);
      return 'unlocked';
    }
    return 'unchanged';
  }

  /** Whether the source owner's Locked rules hide the source item. */
  private async isHiddenByRules({
    sourceAssetId,
    sourceOwnerId,
  }: Pick<PartnerLockInput, 'sourceAssetId' | 'sourceOwnerId'>): Promise<boolean> {
    const metadata = (await this.userRepository.getMetadata(sourceOwnerId)) ?? [];
    const suppression = getPreferences(metadata).privacy.suppression;
    const filter: HiddenContentFilter = {
      userId: sourceOwnerId,
      includeNsfw: false,
      tagIds: suppression.tagIds,
      personIds: suppression.personIds,
      petIds: suppression.petIds,
      scope: suppression.scope,
    };
    const hidden = await this.assetRepository.getHiddenContentAssetIds([sourceAssetId], { hiddenContent: filter });
    return hidden.has(sourceAssetId);
  }
}
