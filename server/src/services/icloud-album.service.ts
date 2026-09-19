import { Injectable } from '@nestjs/common';
import { ICloudAlbumRepository } from 'src/repositories/icloud-album.repository.js';

@Injectable()
export class ICloudAlbumService {
  constructor(private readonly repository: ICloudAlbumRepository) {}

  /** Returns false when another bounded page is required. */
  reconcile(connectionId: string, ownerId: string): Promise<boolean> {
    return this.repository.reconcile(connectionId, ownerId);
  }
}
