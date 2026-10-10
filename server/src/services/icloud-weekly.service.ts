import { Injectable } from '@nestjs/common';
import { weeklyIdentityAdoptionActive } from 'src/repositories/icloud-weekly-adoption-authority.js';
import { ICloudWeeklyRepository } from 'src/repositories/icloud-weekly.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';

/** The existing iCloud schedule drives this producer; it has no timer or provider/byte access. */
@Injectable()
export class ICloudWeeklyService {
  private active?: Promise<void>;

  constructor(
    private weekly: ICloudWeeklyRepository,
    private operations: MediaOperationRepository,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(ICloudWeeklyService.name);
  }

  schedule(): Promise<void> {
    return (this.active ??= this.runSchedule()
      .catch(() => this.logger.warn('iCloud weekly schedule failed'))
      .finally(() => {
        this.active = undefined;
      }));
  }

  private async runSchedule(): Promise<void> {
    if (!weeklyIdentityAdoptionActive()) {
      return;
    }
    for (const candidate of await this.weekly.scheduleCandidates()) {
      if (!weeklyIdentityAdoptionActive()) {
        return;
      }
      try {
        const cohortId =
          candidate.cohortId ?? (await this.weekly.freezeCohort(candidate.ownerId, candidate.connectionId, true)).id;
        await this.produce(cohortId);
      } catch {
        this.logger.warn('iCloud weekly production failed');
      }
    }
  }

  async freeze(ownerId: string, connectionId: string) {
    return this.weekly.freezeCohort(ownerId, connectionId);
  }

  async produce(cohortId: string) {
    return this.weekly.createNextBatch(cohortId, this.operations);
  }
}
