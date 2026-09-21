import { Injectable } from '@nestjs/common';
import { OnEvent, OnJob } from 'src/decorators.js';
import { ArchiveOperationCreateDto } from 'src/dtos/archive-operation.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ImmichWorker, JobName, JobStatus, QueueName } from 'src/enum.js';
import { ArchiveOperationRepository } from 'src/repositories/archive-operation.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { getConfig } from 'src/utils/config.js';
import { handlePromiseError, isNsfwHidingEnabled } from 'src/utils/misc.js';

@Injectable()
export class ArchiveOperationService {
  constructor(
    private repository: ArchiveOperationRepository,
    private jobs: JobRepository,
    private cron: CronRepository,
    private configRepo: ConfigRepository,
    private metadataRepo: SystemMetadataRepository,
    private forkSchemaRepo: ForkSchemaRepository,
    private logger: LoggingRepository,
  ) {}

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async bootstrap() {
    this.cron.create({
      name: 'archive-operations',
      expression: '* * * * *',
      onTick: () => handlePromiseError(this.dispatchPending(), this.logger),
    });
    await this.dispatchPending();
  }

  async dispatchPending() {
    const ids = await this.repository.pending();
    await this.jobs.queueAll(ids.map((id) => ({ name: JobName.ArchiveOperation, data: { id } })));
  }

  async create(auth: AuthDto, dto: ArchiveOperationCreateDto) {
    const id = await this.repository.create(auth, dto);
    // The durable pending rows are the outbox. A failed dispatch is recovered by the scheduled drain.
    try {
      await this.jobs.queue({ name: JobName.ArchiveOperation, data: { id } });
    } catch {
      this.logger.warn('Archive dispatch deferred; durable operation remains pending');
    }
    return this.repository.get(auth.user.id, id);
  }

  list(auth: AuthDto) {
    return this.repository.list(auth.user.id);
  }
  get(auth: AuthDto, id: string) {
    return this.repository.get(auth.user.id, id);
  }

  async command(auth: AuthDto, id: string, command: 'cancel' | 'retry' | 'undo') {
    await this.repository.command(auth, id, command);
    if (command !== 'cancel') {
      try {
        await this.jobs.queue({ name: JobName.ArchiveOperation, data: { id } });
      } catch {
        this.logger.warn('Archive dispatch deferred; durable operation remains pending');
      }
    }
    return this.repository.get(auth.user.id, id);
  }

  @OnJob({ name: JobName.ArchiveOperation, queue: QueueName.BackgroundTask })
  async run({ id }: { id: string }): Promise<JobStatus> {
    // Bound each delivery; the durable drain resumes remaining items after crashes or this limit.
    for (let processed = 0; processed < 100; processed++) {
      const config = await getConfig(
        {
          configRepo: this.configRepo,
          metadataRepo: this.metadataRepo,
          forkSchemaRepo: this.forkSchemaRepo,
          logger: this.logger,
        },
        { withCache: false },
      );
      if (!(await this.repository.processNext(id, isNsfwHidingEnabled(config.machineLearning)))) break;
    }
    return JobStatus.Success;
  }
}
