import { Injectable } from '@nestjs/common';
import { OnEvent, OnJob } from 'src/decorators.js';
import { FrameleafWorker, JobName, JobStatus, QueueName, SystemMetadataKey } from 'src/enum.js';
import { afterJobCommit } from 'src/queue/context.js';
import { BaseService } from 'src/services/base.service.js';
import { DESCRIPTION_TAG_STOP_WORDS } from 'src/utils/description-tag-stop-words.js';

/** Assets read and cleaned per page. */
const PAGE_SIZE = 500;

/**
 * FL-667: AI description tagging made a tag of nearly every word before FL-659 gave it a stop list,
 * so libraries described earlier carry filler tags ("her", "behind", "four"). This runs once after
 * the upgrade and removes them.
 *
 * Only tags the description step applied are touched: the step records the tag values it added to an
 * asset in `ml-enrichment` → `description.appliedTagValues` (a tag the asset already had, such as one
 * a person added first, is not recorded there). A value is removed from an asset only when that
 * record holds it and it is on the stop list; a tag a person added stays. A tag is deleted only when
 * no asset carries it any more and no tag sits inside it.
 */
@Injectable()
export class DescriptionTagCleanupService extends BaseService {
  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  async onBootstrap() {
    if (await this.isComplete()) {
      return;
    }
    await this.jobRepository.queue({ name: JobName.DescriptionFillerTagCleanup, data: {} });
  }

  @OnJob({ name: JobName.DescriptionFillerTagCleanup, queue: QueueName.BackgroundTask })
  async handleDescriptionFillerTagCleanup(): Promise<JobStatus> {
    if (await this.isComplete()) {
      return JobStatus.Skipped;
    }

    const stopWords = [...DESCRIPTION_TAG_STOP_WORDS];
    const removedByOwner = new Map<string, Set<string>>();
    let assets = 0;
    let afterAssetId: string | undefined;

    for (;;) {
      const page = await this.tagRepository.getDescriptionTaggedAssets(stopWords, afterAssetId, PAGE_SIZE);
      if (page.length === 0) {
        break;
      }
      afterAssetId = page.at(-1)!.assetId;

      const changed: string[] = [];
      for (const { assetId, ownerId } of page) {
        const filler = await this.cleanAsset(assetId, ownerId);
        if (filler.length === 0) {
          continue;
        }
        changed.push(assetId);
        const removed = removedByOwner.get(ownerId) ?? new Set<string>();
        for (const tag of filler) {
          removed.add(tag);
        }
        removedByOwner.set(ownerId, removed);
      }

      if (changed.length > 0) {
        await this.assetRepository.updateTagsForAssets(changed);
        for (const assetId of changed) {
          await afterJobCommit(() => this.eventRepository.emit('AssetUntag', { assetId }));
        }
        assets += changed.length;
      }

      if (page.length < PAGE_SIZE) {
        break;
      }
    }

    let deletedTags = 0;
    for (const [ownerId, values] of removedByOwner) {
      deletedTags += await this.tagRepository.deleteUnusedTagValues(ownerId, [...values]);
    }

    await this.systemMetadataRepository.set(SystemMetadataKey.DescriptionFillerTagCleanup, {
      completedAt: new Date().toISOString(),
      assets,
      deletedTags,
    });
    this.logger.log(`Removed filler description tags from ${assets} assets and deleted ${deletedTags} unused tags`);
    return JobStatus.Success;
  }

  private async isComplete() {
    const state = await this.systemMetadataRepository.get(SystemMetadataKey.DescriptionFillerTagCleanup);
    return !!state?.completedAt;
  }

  /**
   * Removes the filler tags the description step applied to one asset and drops them from its
   * enrichment record, so a later re-apply of the stored description does not add them back. It holds
   * the asset's metadata lock, the one every enrichment read-modify-write of the record takes, so an
   * enrichment can neither write back a copy it read before the clean-up nor be overwritten by it; the
   * repository then edits only those two lists in place. Returns the tag values removed.
   */
  private cleanAsset(assetId: string, ownerId: string): Promise<string[]> {
    return this.databaseRepository.withAssetMetadataLock(assetId, (trx) =>
      this.tagRepository.removeDescriptionTagValues(
        assetId,
        ownerId,
        (applied) => applied.filter((tag) => DESCRIPTION_TAG_STOP_WORDS.has(tag)),
        trx,
      ),
    );
  }
}
