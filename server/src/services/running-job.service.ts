import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { mapMemoryExport } from 'src/dtos/memory.dto.js';
import { QueueRunDto, RunningJobsResponseDto } from 'src/dtos/running-job.dto.js';
import { MemoryExportStatus, Permission, QueueName } from 'src/enum.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MemoryRepository } from 'src/repositories/memory.repository.js';
import { mapOperation } from 'src/services/media-operation.service.js';
import { isGranted } from 'src/utils/access.js';
import { ACTIVE_MEDIA_OPERATION_STATUSES } from 'src/utils/media-operation.js';

/** The panel shows what is happening now; a longer backlog is on the Activity page. */
export const RUNNING_OPERATIONS_LIMIT = 50;

/** Highlight exports still being written, or still being asked to stop. */
const RUNNING_MEMORY_EXPORT_STATUSES = [
  MemoryExportStatus.Pending,
  MemoryExportStatus.Running,
  MemoryExportStatus.Cancelling,
];

/** Queues whose pause the queue service refuses; the panel shows their control disabled. */
const UNPAUSABLE_QUEUES: readonly QueueName[] = [QueueName.BackgroundTask];

/**
 * The one summary the notifications panel polls (FL-104, owner request September 23, 2026; FL-72).
 *
 * It exists so a panel open on every page makes one request every few seconds, not one per source:
 * the viewer's own media operations and highlight exports, and — for an administrator — every
 * server job queue that has work, with its run's progress.
 *
 * Privacy is decided here, not in the client. Operations and exports are read for the signed-in
 * account only. Queue counts are server-wide, so they are read only for an administrator whose
 * credentials may read queues; anybody else gets an empty list without the queues even being
 * looked at. None of it names an asset.
 */
@Injectable()
export class RunningJobService {
  constructor(
    private logger: LoggingRepository,
    private jobRepository: JobRepository,
    private mediaOperationRepository: MediaOperationRepository,
    private memoryRepository: MemoryRepository,
  ) {
    this.logger.setContext(RunningJobService.name);
  }

  async getRunning(auth: AuthDto): Promise<RunningJobsResponseDto> {
    const canManageQueues = this.canManageQueues(auth);
    const canReadMemoryExports = this.isGranted(auth, Permission.MemoryRead);

    const [operations, memoryExports, queues] = await Promise.all([
      this.mediaOperationRepository.list({
        ownerId: auth.user.id,
        statuses: ACTIVE_MEDIA_OPERATION_STATUSES,
        includeDismissed: false,
        take: RUNNING_OPERATIONS_LIMIT,
        skip: 0,
      }),
      canReadMemoryExports
        ? this.memoryRepository.searchExports(auth.user.id, { status: RUNNING_MEMORY_EXPORT_STATUSES })
        : Promise.resolve([]),
      canManageQueues ? this.getQueueRuns() : Promise.resolve([]),
    ]);

    return {
      operations: operations.items.map((operation) => mapOperation(operation)),
      memoryExports: memoryExports.map((run) => mapMemoryExport(run)),
      queues,
      canManageQueues,
    };
  }

  /**
   * Every queue with work in it, in the order the queues are declared.
   *
   * A queue that cannot be read is left out rather than failing the whole answer: the panel would
   * otherwise lose the viewer's own jobs over one unreachable queue.
   */
  private async getQueueRuns(): Promise<QueueRunDto[]> {
    const runs = await Promise.all(
      Object.values(QueueName).map(async (name): Promise<QueueRunDto | null> => {
        try {
          const [run, isPaused] = await Promise.all([
            this.jobRepository.observeQueueRun(name),
            this.jobRepository.isPaused(name),
          ]);
          if (run.active + run.waiting === 0) {
            return null;
          }

          return {
            name,
            isPaused,
            canPause: !UNPAUSABLE_QUEUES.includes(name),
            active: run.active,
            waiting: run.waiting,
            processed: run.processed,
            total: run.processed + run.active + run.waiting,
            startedAt: run.startedAt ? run.startedAt.toISOString() : null,
          };
        } catch (error) {
          this.logger.warn(`Unable to read the ${name} queue for the running-jobs summary: ${error}`);
          return null;
        }
      }),
    );

    return runs.filter((run): run is QueueRunDto => run !== null);
  }

  /** Server-wide queue counts: administrators whose credentials may read queues, and nobody else. */
  private canManageQueues(auth: AuthDto): boolean {
    return auth.user.isAdmin && this.isGranted(auth, Permission.QueueRead);
  }

  /** A session may do anything its account may; an API key only what it was granted. */
  private isGranted(auth: AuthDto, permission: Permission): boolean {
    return !auth.apiKey || isGranted({ requested: [permission], current: auth.apiKey.permissions });
  }
}
