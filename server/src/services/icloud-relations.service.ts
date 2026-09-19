import { Injectable } from '@nestjs/common';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ICloudRelationsRepository } from 'src/repositories/icloud-relations.repository.js';

@Injectable()
export class ICloudRelationsService {
  constructor(
    private readonly repository: ICloudRelationsRepository,
    private readonly events: EventRepository,
  ) {}

  async reconcile(connectionId: string, ownerId: string): Promise<boolean> {
    if (!(await this.flush(connectionId, ownerId))) {
      return false;
    }
    const complete = await this.repository.reconcile(connectionId, ownerId);
    return (await this.flush(connectionId, ownerId)) && complete;
  }

  private async flush(connectionId: string, ownerId: string): Promise<boolean> {
    for (let count = 0; count < 25; count++) {
      const delivered = await this.repository.dispatchEvent(connectionId, ownerId, async (event) => {
        if (event.name === 'AssetHide') {
          await this.events.emit(event.name, { assetId: event.assetId, userId: ownerId });
        } else {
          await this.events.emit(event.name, { stackId: event.stackId, userId: ownerId });
        }
      });
      if (!delivered) {
        return true;
      }
    }
    return false;
  }
}
