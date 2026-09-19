import { Injectable } from '@nestjs/common';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { ICloudMetadataRepository } from 'src/repositories/icloud-metadata.repository.js';

@Injectable()
export class ICloudMetadataService {
  constructor(private readonly repository: ICloudMetadataRepository) {}

  reconcile(connectionId: string, ownerId: string): Promise<boolean> {
    return this.repository.reconcile(connectionId, ownerId);
  }

  @OnEvent({ name: 'AssetMetadataExtracted', priority: -100 })
  async onAssetMetadataExtracted({ assetId, userId }: ArgOf<'AssetMetadataExtracted'>): Promise<void> {
    await this.repository.afterExtraction(assetId, userId);
  }
}
