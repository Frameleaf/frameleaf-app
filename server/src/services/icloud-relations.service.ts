import { Injectable, Optional } from '@nestjs/common';
import { OnEvent, OnJob } from 'src/decorators.js';
import { ImmichWorker, JobName, JobStatus, QueueName } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { ICloudRelationsRepository } from 'src/repositories/icloud-relations.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

@Injectable()
export class ICloudRelationsService {
  private dispatch?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly repository: ICloudRelationsRepository,
    private readonly events: EventRepository,
    @Optional() private readonly cron?: CronRepository,
    @Optional() private readonly logger?: LoggingRepository,
  ) {}

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    this.stopped = false;
    await this.enqueue();
    this.cron?.create({
      name: 'icloud-local-relations',
      expression: '* * * * *',
      // Cron's legacy adapter types callbacks as void; enqueue tracks the promise and shutdown awaits it.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      onTick: async () => {
        try {
          await this.enqueue();
        } catch {
          this.logger?.warn('Local edit relations dispatch failed; durable decisions remain pending');
        }
      },
    });
  }
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopped = true;
    await this.dispatch;
  }

  /** Awaited wake; retries/bootstrap also recover the persisted marker if the process stops here. */
  async enqueue() {
    if (this.stopped) return;
    this.dispatch ??= this.repository
      .enqueuePending()
      .then(() => {})
      .finally(() => {
        this.dispatch = undefined;
      });
    await this.dispatch;
  }

  @OnJob({ name: JobName.ICloudRelations, queue: QueueName.BackgroundTask })
  async handleLocalRelations(data: { id: string; ownerId: string }): Promise<JobStatus> {
    if (queueExecution.getStore()) {
      const ownerId = await this.repository.resolveEffectOwner();
      if (ownerId) {
        // Only the accepted actual queue claim determines this private target, never the payload hint.
        for (let count = 0; count < 25; count++)
          if (
            !(await this.repository.dispatchOwnerEffects(ownerId, (bundle) =>
              this.events.emit('AssetLocalEffects', bundle),
            ))
          )
            return JobStatus.Success;
        return JobStatus.Failed;
      }
    }
    const target = queueExecution.getStore() ? await this.repository.resolveLocalTarget() : data;
    for (let count = 0; count < 25; count++)
      if (await this.reconcile(target.id, target.ownerId)) return JobStatus.Success;
    return JobStatus.Failed;
  }

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
