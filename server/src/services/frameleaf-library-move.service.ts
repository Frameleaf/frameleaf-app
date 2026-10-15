import { ConflictException, Injectable } from '@nestjs/common';
import type { LibraryMovePauseStatusDto } from 'src/dtos/frameleaf-library-move.dto.js';
import type { LibraryMovePauseState } from 'src/types.js';
import { OnEvent } from 'src/decorators.js';
import { FrameleafWorker, QueueName, SystemMetadataKey } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { libraryMoveFence } from 'src/utils/frameleaf-library-move-fence.js';

/** How long a pause lasts without the Manager renewing it (every pause call and status poll renews). */
export const LIBRARY_MOVE_LEASE_MS = 2 * 60 * 60 * 1000;
/**
 * After a restart the Manager has this long to check the library and resume (or renew) before the
 * pause lifts by itself, so a Manager that crashed for good never leaves the server paused.
 */
export const LIBRARY_MOVE_RESTART_GRACE_MS = 30 * 60 * 1000;

/**
 * FL-360: the server side of the Frameleaf Manager library move. Before the Manager stops the stack
 * it pauses the server: every job queue is paused through the generic queue pause (backup and Studio
 * work included, without touching their services), and the API's write fence refuses uploads and
 * other changes. The Manager polls until nothing is in flight, stops the stack, copies, and resumes
 * once the library is back. The pause is stored in system metadata, so a crash or restart keeps it
 * (queue pauses are already durable in `job_queue`); a lease lifts it if the Manager never returns.
 *
 * Only queues this pause paused are resumed, so a queue an administrator paused stays paused.
 */
@Injectable()
export class FrameleafLibraryMoveService extends BaseService {
  private chain: Promise<unknown> = Promise.resolve();
  private expiryTimer?: NodeJS.Timeout;

  @OnEvent({ name: 'AppBootstrap' })
  async onBootstrap() {
    if (this.worker !== FrameleafWorker.Api) {
      return;
    }
    await this.serialized(async () => {
      const state = await this.read();
      if (!state) {
        return;
      }
      // A restart (the move's own, or a crash) keeps the pause, with time for the Manager to come back.
      // Time spent stopped (copying) never counts against the lease.
      const leaseExpiresAt = new Date(
        Math.max(Date.parse(state.leaseExpiresAt), Date.now() + LIBRARY_MOVE_RESTART_GRACE_MS),
      ).toISOString();
      const next = { ...state, leaseExpiresAt };
      await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafLibraryMovePause, next);
      await this.pauseQueues(next.queues);
      this.apply(next);
      this.logger.log(`Library move ${state.operationId}: pause kept across restart until ${leaseExpiresAt}`);
    });
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    clearTimeout(this.expiryTimer);
  }

  /** Start or renew the pause for one Manager operation. */
  pause(operationId: string): Promise<LibraryMovePauseStatusDto> {
    return this.serialized(async () => {
      const existing = await this.read();
      if (existing && existing.operationId !== operationId) {
        throw new ConflictException('Another library move holds the pause');
      }
      let queues = existing?.queues;
      if (!queues) {
        // Record only the queues this pause pauses, before pausing them, so a crash in between
        // never makes a resume unpause an administrator's own pause.
        queues = [];
        for (const name of Object.values(QueueName)) {
          if (!(await this.jobRepository.isPaused(name))) {
            queues.push(name);
          }
        }
      }
      const now = new Date();
      const state: LibraryMovePauseState = {
        operationId,
        pausedAt: existing?.pausedAt ?? now.toISOString(),
        leaseExpiresAt: new Date(now.getTime() + LIBRARY_MOVE_LEASE_MS).toISOString(),
        queues,
      };
      await this.systemMetadataRepository.set(SystemMetadataKey.FrameleafLibraryMovePause, state);
      this.apply(state);
      await this.pauseQueues(queues);
      if (!existing) {
        this.logger.log(`Library move ${operationId}: uploads, changes and ${queues.length} queues paused`);
      }
      return this.describe(state);
    });
  }

  /** Lift the pause. Resuming an operation that no longer holds it is a no-op; another holder is a conflict. */
  resume(operationId?: string): Promise<LibraryMovePauseStatusDto> {
    return this.serialized(async () => {
      const state = await this.read();
      if (state) {
        if (operationId !== undefined && state.operationId !== operationId) {
          throw new ConflictException('Another library move holds the pause');
        }
        await this.lift(state);
        this.logger.log(`Library move ${state.operationId}: uploads and jobs resumed`);
      }
      return this.describe(null);
    });
  }

  /** Report the pause and what is still in flight. A Manager poll (`renew`) also renews the lease. */
  async status(renewFor?: string): Promise<LibraryMovePauseStatusDto> {
    if (renewFor) {
      const state = await this.read();
      if (state?.operationId === renewFor) {
        return this.pause(renewFor);
      }
    }
    return this.describe(await this.read());
  }

  private async describe(state: LibraryMovePauseState | null): Promise<LibraryMovePauseStatusDto> {
    const activeQueues: string[] = [];
    let activeJobs = 0;
    if (state) {
      for (const name of Object.values(QueueName)) {
        const { active } = await this.jobRepository.getJobCounts(name);
        if (active > 0) {
          activeQueues.push(name);
          activeJobs += active;
        }
      }
    }
    const writesInFlight = state ? libraryMoveFence.writesInFlight : 0;
    return {
      paused: !!state,
      operationId: state?.operationId ?? null,
      pausedAt: state?.pausedAt ?? null,
      leaseExpiresAt: state?.leaseExpiresAt ?? null,
      writesInFlight,
      activeJobs,
      activeQueues,
      drained: !!state && libraryMoveFence.active && writesInFlight === 0 && activeJobs === 0,
    };
  }

  private async read() {
    return (await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafLibraryMovePause)) ?? null;
  }

  private async pauseQueues(queues: string[]) {
    for (const name of queues) {
      await this.jobRepository.pause(name as QueueName);
    }
  }

  private async lift(state: LibraryMovePauseState) {
    for (const name of state.queues) {
      await this.jobRepository.resume(name as QueueName);
    }
    await this.systemMetadataRepository.delete(SystemMetadataKey.FrameleafLibraryMovePause);
    libraryMoveFence.lower();
    clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private apply(state: LibraryMovePauseState) {
    libraryMoveFence.raise();
    clearTimeout(this.expiryTimer);
    const delay = Math.max(0, Date.parse(state.leaseExpiresAt) - Date.now()) + 1000;
    this.expiryTimer = setTimeout(() => void this.expire().catch(() => {}), delay);
    this.expiryTimer.unref?.();
  }

  private expire() {
    return this.serialized(async () => {
      const state = await this.read();
      if (!state) {
        libraryMoveFence.lower();
        return;
      }
      if (Date.parse(state.leaseExpiresAt) <= Date.now()) {
        this.logger.warn(`Library move ${state.operationId}: pause lease expired; resuming uploads and jobs`);
        await this.lift(state);
      } else {
        this.apply(state);
      }
    });
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    // Run after the previous step whether it succeeded or failed.
    const next = this.chain.catch(() => {}).then(action);
    this.chain = next.catch(() => {});
    return next;
  }
}
