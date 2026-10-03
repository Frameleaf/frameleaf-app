import { Injectable } from '@nestjs/common';
import { ICloudWeeklyRepository } from 'src/repositories/icloud-weekly.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';

/** Explicit internal producer only. No bootstrap/tick registration and no provider/byte access. */
@Injectable()
export class ICloudWeeklyService {
  constructor(private weekly: ICloudWeeklyRepository, private operations: MediaOperationRepository) {}

  async freeze(ownerId: string, connectionId: string) {
    return this.weekly.freezeCohort(ownerId, connectionId);
  }

  async produce(cohortId: string) {
    return this.weekly.createNextBatch(cohortId, this.operations);
  }
}
