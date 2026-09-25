import { Injectable } from '@nestjs/common';
import { OnEvent } from 'src/decorators.js';
import { ImmichWorker } from 'src/enum.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRecovery, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { EditOperationTracker } from 'src/utils/edit-operation-tracker.js';

/** How often lapsed claims are recovered. */
export const MEDIA_OPERATION_SWEEP_MS = 60_000;

/** What a job whose worker vanished and that has no retry left is reported with. */
export const MEDIA_OPERATION_LEASE_EXPIRED = {
  errorCode: 'lease_expired',
  error: 'The worker stopped responding before the job finished and it ran out of attempts',
} as const;

/**
 * The one recovery pass for media operations (FL-104).
 *
 * A claim whose lease lapsed — the worker died, the server restarted, the network went — is judged
 * here and nowhere else, for every kind: bulk, render worker jobs (Studio exports and previews,
 * quick edits), restorations and Studio bundles. It returns to the queue while it has attempts
 * left, gets its one automatic retry when it has not, and fails only after that; see
 * `MediaOperationRepository.recoverExpiredClaims`.
 *
 * No worker owns this, on purpose. When each runner swept its own kinds, two passes could judge
 * the same lapsed claim by different rules; a single neutral owner means one answer. Several
 * microservices processes may each run the pass: every write is a guarded UPDATE, so a row is
 * recovered once whichever process gets to it first.
 */
@Injectable()
export class MediaOperationSweepService {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<MediaOperationRecovery | undefined>;

  private edits: EditOperationTracker;

  constructor(
    private logger: LoggingRepository,
    private operations: MediaOperationRepository,
    jobs: JobRepository,
  ) {
    this.logger.setContext(MediaOperationSweepService.name);
    this.edits = new EditOperationTracker(operations, jobs, logger);
  }

  /** Starts at once as well as on the interval, so a restart settles what it left behind promptly. */
  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.timer ??= setInterval(() => void this.tick(), MEDIA_OPERATION_SWEEP_MS);
    void this.tick();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.active;
  }

  /** Never overlaps itself: a tick while a pass is running waits for the next interval. */
  tick(): Promise<MediaOperationRecovery | undefined> {
    return (this.active ??= this.sweep()
      .catch((error) => {
        this.logger.warn(`Media operation recovery failed: ${error}`);
        // eslint-disable-next-line unicorn/no-useless-undefined -- preserve the Promise result type
        return undefined;
      })
      .finally(() => {
        this.active = undefined;
      }));
  }

  async sweep(): Promise<MediaOperationRecovery> {
    const recovered = await this.operations.recoverExpiredClaims(MEDIA_OPERATION_LEASE_EXPIRED);
    const { requeued, retried, failed, abandonedCancels, paused } = recovered;
    if (requeued || retried || failed || abandonedCancels || paused) {
      this.logger.log(
        `Recovered media operations: ${requeued} requeued, ${retried} retrying, ${failed} failed, ${abandonedCancels} cancelled, ${paused} paused`,
      );
    }

    // FL-43: an edit the job queue runs has no worker polling for it. Recovery above, a failure's
    // automatic retry and a manual retry leave its row queued without a job; this puts one back.
    const dispatched = await this.edits.dispatch();
    if (dispatched > 0) {
      this.logger.log(`Dispatched ${dispatched} edit render(s) to the job queue`);
    }
    return recovered;
  }
}
