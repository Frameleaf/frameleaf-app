import { Injectable } from '@nestjs/common';
import { setTimeout } from 'node:timers/promises';
import { afterJobCommit, deferJobAdoption, jobSignal } from 'src/queue/context.js';
import { DesktopMlRepository, DesktopMlRequest } from 'src/repositories/desktop-ml.repository.js';

@Injectable()
export class DesktopMlService {
  constructor(private repository: DesktopMlRepository) {}

  async dispatch<T>(options: {
    request: DesktopMlRequest;
    assertAuthority: () => Promise<void>;
    decodeResult: (value: unknown) => T;
    signal?: AbortSignal;
  }): Promise<T> {
    const remaining = options.request.deadlineAt.getTime() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 600_000)
      throw new Error('desktop_deadline_invalid');
    const parent = jobSignal();
    const signal = AbortSignal.any([
      AbortSignal.timeout(remaining),
      ...(parent ? [parent] : []),
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    await options.assertAuthority();
    signal.throwIfAborted();
    const task = await this.repository.create(options.request);
    let deferred = false;
    try {
      while (true) {
        signal.throwIfAborted();
        const row = await this.repository.result(task.id);
        signal.throwIfAborted();
        if (!row || row.state === 'cancelled') throw new Error('desktop_inference_cancelled');
        if (row.state === 'failed') throw new Error('desktop_inference_failed');
        if (row.state === 'completed') {
          if (row.authorityKey !== options.request.authorityKey || row.modelKey !== options.request.modelKey)
            throw new Error('desktop_result_identity_changed');
          const result = options.decodeResult(row.result);
          await options.assertAuthority();
          signal.throwIfAborted();
          deferred = deferJobAdoption((tx) => this.repository.assertAdoption(task.id, task, tx));
          if (deferred) await afterJobCommit(() => this.repository.discard(task.id));
          else await this.repository.assertAdoption(task.id, task);
          signal.throwIfAborted();
          return result;
        }
        await setTimeout(1000, undefined, { signal });
      }
    } finally {
      // No cleanup uses the cancelled parent signal: fencing the worker must still finish.
      if (!deferred) {
        await this.repository.cancel(task.id);
        await this.repository.discard(task.id);
      }
    }
  }
}
