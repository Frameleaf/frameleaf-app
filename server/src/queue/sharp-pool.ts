import { AsyncLocalStorage } from 'node:async_hooks';
import { type ChildProcess, fork } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { existsSync } from 'node:fs';
import type { SharpArguments, SharpOperation, SharpResponse, SharpResult } from 'src/queue/sharp-protocol.js';
import { trackQueueChild } from 'src/queue/child-process.js';
import { queueExecution } from 'src/queue/context.js';
import { deferJobUntilDependency } from 'src/queue/dependency.js';
import { superviseMediaProcess } from 'src/queue/process-lifetime.js';
import { sharpConfiguration } from 'src/queue/sharp-configuration.js';
import { SharpResourceLimitError, sharpPayloadBytes } from 'src/queue/sharp-protocol.js';
import { QUEUE_TIMING } from 'src/queue/types.js';
import { advanceExecutionProgress, executionSignal } from 'src/utils/execution-signal.js';

/** Only an image-operation failure is eligible for the existing LibRaw decode fallback. */
export class SharpOperationError extends Error {
  constructor(
    message: string,
    readonly decodeFailure = false,
  ) {
    super(message);
  }
}
export const imageWorkerDiagnostics = channel('frameleaf.image-worker');

type Lifetime = ReturnType<typeof superviseMediaProcess>;
type Task = {
  id: number;
  operation: SharpOperation;
  args: unknown[];
  bytes: number;
  signal?: AbortSignal;
  deadline: number;
  startedAt?: number;
  workerLifetimePeakRssBytes?: number;
  fallbackReason?: string;
  timer?: ReturnType<typeof setTimeout>;
  abort: () => void;
  progress: (units: number) => void;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
type Slot = {
  child: ChildProcess;
  ready: boolean;
  retiring: boolean;
  task?: Task;
  lifetime?: Lifetime;
  completed: number;
  idle?: ReturnType<typeof setTimeout>;
  closed: Promise<void>;
};
type PoolOptions = ReturnType<typeof sharpConfiguration> & {
  deadlineMs: number;
  idleMs: number;
  graceMs: number;
  idleChildMs: number;
  createChild: () => ChildProcess;
};

function createSharpChild() {
  const compiled = new URL('sharp-worker.js', import.meta.url);
  const source = new URL('sharp-worker.ts', import.meta.url);
  return fork(existsSync(compiled) ? compiled : source, [], {
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: existsSync(compiled) ? [] : ['--import', 'tsx'],
  });
}

/** One operation per child; cancellation owns the slot until actual close, never a Promise.race. */
export class SharpProcessPool {
  private readonly slots = new Set<Slot>();
  private readonly pending: Task[] = [];
  private pendingBytes = 0;
  private sequence = 0;
  private stopped = false;
  private readonly options: PoolOptions;

  constructor(options: Partial<PoolOptions> = {}) {
    this.options = {
      ...sharpConfiguration(),
      deadlineMs: QUEUE_TIMING.opaqueDeadline,
      idleMs: QUEUE_TIMING.noProgressDeadline,
      graceMs: QUEUE_TIMING.cancelGrace,
      idleChildMs: 30_000,
      createChild: createSharpChild,
      ...options,
    };
  }

  run<K extends SharpOperation>(
    operation: K,
    args: SharpArguments<K>,
    signal = executionSignal(),
  ): Promise<SharpResult<K>> {
    const admittedAt = performance.now();
    let task: Task | undefined;
    let observed = false;
    const report = (error?: unknown) => {
      if (observed) return;
      observed = true;
      imageWorkerDiagnostics.publish({
        operation,
        outcome: error
          ? signal?.aborted
            ? 'cancelled'
            : error instanceof SharpResourceLimitError
              ? 'resource-limit'
              : error instanceof SharpOperationError && error.decodeFailure
                ? 'decode-failure'
                : this.stopped
                  ? 'shutdown'
                  : error instanceof Error &&
                      /execution deadline|stopped making progress|admission deadline/.test(error.message)
                    ? 'timeout'
                    : 'worker-failure'
          : 'success',
        elapsedMs: performance.now() - admittedAt,
        queueMs: (task?.startedAt ?? performance.now()) - admittedAt,
        workerLifetimePeakRssBytes: task?.workerLifetimePeakRssBytes,
        renderMs: task?.startedAt === undefined ? 0 : performance.now() - task.startedAt,
        maxBytes: this.options.maxBytes,
        maxPixels: this.options.maxPixels,
        fallbackReason: task?.fallbackReason,
      });
    };
    const refused = (error: unknown) => {
      report(error);
      return Promise.reject(error);
    };
    if (this.stopped) {
      return refused(new Error('Sharp pool is closed'));
    }
    if (signal?.aborted) {
      return refused(signal.reason);
    }
    let bytes: number;
    try {
      bytes = sharpPayloadBytes(args);
    } catch (error) {
      return refused(error);
    }
    if (bytes > this.options.maxBytes) {
      return refused(new SharpResourceLimitError('input buffer is too large'));
    }
    const available =
      [...this.slots].some((slot) => !slot.task && !slot.retiring) || this.slots.size < this.options.workers;
    if (
      !available &&
      (this.pending.length >= this.options.pending || this.pendingBytes + bytes > this.options.pendingBytes)
    ) {
      return refused(this.admissionFailure('process pool admission is full'));
    }
    const restore = AsyncLocalStorage.snapshot();
    return new Promise<SharpResult<K>>((resolve, reject) => {
      const admittedTask: Task = {
        id: ++this.sequence,
        operation,
        args,
        bytes,
        signal,
        deadline: Date.now() + this.options.deadlineMs,
        abort: () =>
          this.cancelPending(
            admittedTask,
            signal?.reason instanceof Error ? signal.reason : new Error('Sharp operation cancelled'),
          ),
        progress: (units) => restore(advanceExecutionProgress, units),
        resolve: (value) => {
          if (operation === 'inspectImageEncoding' && value && typeof value === 'object' && 'fallbackReason' in value) {
            const reason = value.fallbackReason;
            if (
              typeof reason === 'string' &&
              [
                'iso-heif-gain-map-decoder-unavailable',
                'hdr-profile-unsupported',
                'apple-gain-map-interpretation-unqualified',
                'invalid-gain-map',
              ].includes(reason)
            ) {
              admittedTask.fallbackReason = reason;
            }
          }
          report();
          resolve(value as SharpResult<K>);
        },
        reject: (error) => {
          report(error);
          reject(error);
        },
      };
      task = admittedTask;
      admittedTask.timer = setTimeout(
        () =>
          this.cancelPending(
            admittedTask,
            restore(() => this.admissionFailure('process admission deadline exceeded')),
          ),
        this.options.deadlineMs,
      );
      admittedTask.timer.unref();
      signal?.addEventListener('abort', admittedTask.abort, { once: true });
      this.pending.push(admittedTask);
      this.pendingBytes += bytes;
      this.dispatch();
    });
  }

  async close() {
    this.stopped = true;
    while (this.pending.length > 0) {
      this.cancelPending(this.pending[0], new Error('Sharp pool is closed'));
    }
    const slots = [...this.slots];
    for (const slot of slots) {
      this.retire(slot, new Error('Sharp pool is closed'));
    }
    await Promise.all(slots.map((slot) => slot.closed));
  }

  private admissionFailure(message: string): Error {
    try {
      // Capacity is a temporary local dependency, never an additional item retry owner.
      if (queueExecution.getStore()?.claim.safeToRetry) {
        deferJobUntilDependency('local-capacity');
      }
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    return new SharpResourceLimitError(message);
  }

  private cancelPending(task: Task, error: Error) {
    const index = this.pending.indexOf(task);
    if (index === -1) {
      return;
    }
    this.pending.splice(index, 1);
    this.pendingBytes -= task.bytes;
    this.detachPending(task);
    task.reject(error);
  }

  private detachPending(task: Task) {
    clearTimeout(task.timer);
    task.signal?.removeEventListener('abort', task.abort);
  }

  private dispatch() {
    if (this.stopped) {
      return;
    }
    while (this.pending.length > 0) {
      let slot = [...this.slots].find((entry) => !entry.task && !entry.retiring);
      if (!slot) {
        if (this.slots.size >= this.options.workers) {
          return;
        }
        try {
          slot = this.spawn();
        } catch (error) {
          this.cancelPending(this.pending[0], error instanceof Error ? error : new Error(String(error)));
          continue;
        }
      }
      const task = this.pending.shift()!;
      this.pendingBytes -= task.bytes;
      this.detachPending(task);
      task.startedAt = performance.now();
      slot.task = task;
      slot.completed = 0;
      clearTimeout(slot.idle);
      slot.child.ref();
      slot.child.channel?.ref();
      slot.lifetime = superviseMediaProcess(slot.child, {
        trackChild: false,
        signal: task.signal,
        deadlineMs: Math.max(1, task.deadline - Date.now()),
        idleMs: this.options.idleMs,
        graceMs: this.options.graceMs,
        progress: task.progress,
      });
      if (slot.ready) {
        this.send(slot);
      }
    }
  }

  private spawn(): Slot {
    const child = this.options.createChild();
    trackQueueChild(child); // Remains registered during idle reuse; only child close unregisters it.
    const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
    const slot: Slot = {
      child,
      ready: false,
      retiring: false,
      completed: 0,
      closed,
    };
    this.slots.add(slot);
    child.on('message', (message: SharpResponse) => this.message(slot, message));
    child.on('error', (error) => this.retire(slot, error));
    child.once('close', (code, signal) => {
      clearTimeout(slot.idle);
      slot.task?.reject(slot.lifetime?.error() ?? new Error(`Sharp child closed (${code ?? signal})`));
      slot.lifetime?.release();
      this.slots.delete(slot);
      markClosed();
      this.dispatch();
    });
    return slot;
  }

  private send(slot: Slot) {
    const task = slot.task;
    if (!task || slot.retiring || slot.lifetime?.error()) {
      return;
    }
    try {
      slot.child.send(
        {
          id: task.id,
          operation: task.operation,
          args: task.args,
          maxPixels: this.options.maxPixels,
          maxBytes: this.options.maxBytes,
        },
        (error) => {
          if (error) {
            this.retire(slot, error);
          }
        },
      );
    } catch (error) {
      this.retire(slot, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private message(slot: Slot, message: SharpResponse) {
    if (message.type === 'ready') {
      if (slot.ready) {
        return this.retire(slot, new Error('Sharp child sent duplicate readiness'));
      }
      slot.ready = true;
      this.send(slot);
      return;
    }
    const task = slot.task;
    if (!task || message.id !== task.id || slot.retiring || slot.lifetime?.error()) {
      return;
    }
    if (message.type === 'progress') {
      if (Number.isSafeInteger(message.completed) && message.completed > slot.completed) {
        slot.lifetime?.progress(message.completed - slot.completed);
        slot.completed = message.completed;
      }
      return;
    }
    if (message.type !== 'result' && message.type !== 'failure') {
      return;
    }
    if (Number.isSafeInteger(message.workerLifetimePeakRssBytes) && message.workerLifetimePeakRssBytes! >= 0) {
      task.workerLifetimePeakRssBytes = message.workerLifetimePeakRssBytes;
    }
    slot.lifetime?.release();
    slot.lifetime = undefined;
    slot.task = undefined;
    if (message.type === 'failure') {
      task.reject(
        message.resourceLimit
          ? new SharpResourceLimitError(message.message)
          : new SharpOperationError(message.message, message.decodeFailure),
      );
    } else {
      task.progress(1); // A completed operation is advancing work, unlike an IPC keepalive.
      task.resolve(message.value);
    }
    slot.child.unref();
    slot.child.channel?.unref();
    slot.idle = setTimeout(() => this.retire(slot, new Error('Sharp idle child retired')), this.options.idleChildMs);
    slot.idle.unref();
    this.dispatch();
  }

  private retire(slot: Slot, reason: Error) {
    if (slot.retiring) {
      return;
    }
    slot.retiring = true;
    clearTimeout(slot.idle);
    slot.lifetime ??= superviseMediaProcess(slot.child, { trackChild: false, graceMs: this.options.graceMs });
    slot.lifetime.stop(reason);
  }
}

export const sharpProcessPool = new SharpProcessPool();
