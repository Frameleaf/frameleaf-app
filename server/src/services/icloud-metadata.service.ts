import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ICloudMetadataRepository } from 'src/repositories/icloud-metadata.repository.js';

@Injectable()
export class ICloudMetadataService {
  constructor(
    private readonly repository: ICloudMetadataRepository,
    private readonly eventRepository: EventRepository,
  ) {}

  async reconcile(connectionId: string, ownerId: string): Promise<boolean> {
    const locked: string[] = [];
    const complete = await this.repository.reconcile(connectionId, ownerId, undefined, locked);
    await this.afterLocked(locked, ownerId);
    return complete;
  }

  @OnEvent({ name: 'AssetMetadataExtracted', priority: -100 })
  async onAssetMetadataExtracted({ assetId, userId }: ArgOf<'AssetMetadataExtracted'>): Promise<void> {
    await this.afterLocked(await this.repository.afterExtraction(assetId, userId), userId);
  }

  /**
   * An Apple Hidden photo is locked (FL-34) in the reconciler's transaction; once that commits, the
   * same follow-up as any other lock runs: new thumbnails for people whose featured face it was,
   * replaced profile pictures, and the update pushed to the owner's open sessions.
   */
  private async afterLocked(assetIds: string[], userId: string) {
    if (assetIds.length > 0) {
      await this.eventRepository.emit('AssetLockAll', { assetIds, userId });
    }
  }
}
