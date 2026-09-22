import { Injectable } from '@nestjs/common';
import { OnEvent } from 'src/decorators.js';
import { ArchiveOperationCreateDto } from 'src/dtos/archive-operation.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ImmichWorker } from 'src/enum.js';
import { ArchiveOperationRepository } from 'src/repositories/archive-operation.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { getConfig } from 'src/utils/config.js';
import { isNsfwHidingEnabled } from 'src/utils/misc.js';

@Injectable()
export class ArchiveOperationService {
  private started = false;
  private drain?: Promise<void>;
  constructor(
    private repository: ArchiveOperationRepository,
    private cron: CronRepository,
    private configRepo: ConfigRepository,
    private metadataRepo: SystemMetadataRepository,
    private forkSchemaRepo: ForkSchemaRepository,
    private logger: LoggingRepository,
  ) {}

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async bootstrap() {
    if (this.started) return;
    this.started = true;
    this.cron.create({
      name: 'archive-operations',
      expression: '* * * * * *',
      onTick: () => void this.dispatchPending(),
    });
    await this.dispatchPending();
  }

  @OnEvent({ name: 'AppShutdown', workers: [ImmichWorker.Microservices] })
  async shutdown() {
    if (!this.started) return;
    this.started = false;
    this.cron.update({ name: 'archive-operations', start: false });
    await this.drain;
  }

  async dispatchPending() {
    if (!this.started || this.drain) return;
    this.drain = this.processPending().catch(() => {
      this.logger.warn('Archive drain deferred; durable operations remain pending');
    });
    try {
      await this.drain;
    } finally {
      this.drain = undefined;
    }
  }

  private async processPending() {
    const ids = await this.repository.pending();
    // Round-robin at most 100 item transactions per tick, without overlapping local drains.
    // Other workers serialize each publication with the existing database operation lock.
    for (let attempts = 0; this.started && attempts < 100 && ids.length > 0; attempts++) {
      const id = ids.shift()!;
      try {
        const config = await getConfig(
          {
            configRepo: this.configRepo,
            metadataRepo: this.metadataRepo,
            forkSchemaRepo: this.forkSchemaRepo,
            logger: this.logger,
          },
          { withCache: false },
        );
        if (await this.repository.processNext(id, isNsfwHidingEnabled(config.machineLearning))) ids.push(id);
      } catch {
        // One failed operation must not starve other receipts. The next tick retries it.
        this.logger.warn(`Archive operation ${id} deferred; durable work remains pending`);
      }
    }
  }

  async create(auth: AuthDto, dto: ArchiveOperationCreateDto) {
    const id = await this.repository.create(auth, dto);
    // The committed operation/items are the work queue; the microservices drain owns execution.
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
    return this.repository.get(auth.user.id, id);
  }
}
