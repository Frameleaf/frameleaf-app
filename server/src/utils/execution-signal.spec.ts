import type { QueueExecution } from 'src/queue/types.js';
import { queueExecution } from 'src/queue/context.js';
import {
  executionSignal,
  operationExecution,
  withExecutionCleanup,
  withExecutionSignal,
} from 'src/utils/execution-signal.js';

it('keeps queue cancellation effective inside a borrowed input scope', async () => {
  const queue = new AbortController();
  const input = new AbortController();
  const reason = new Error('queue cancelled');
  await queueExecution.run({ signal: queue.signal } as QueueExecution, () =>
    withExecutionSignal(input.signal, async () => {
      queue.abort(reason);
      expect(input.signal.aborted).toBe(false);
      expect(executionSignal()?.reason).toBe(reason);
      await Promise.resolve();
      expect(executionSignal()?.aborted).toBe(true);
    }),
  );
  expect(executionSignal()).toBeUndefined();
});

it('scopes input cancellation without replacing an operation or its cleanup lifetime', async () => {
  const input = new AbortController();
  const operation = {
    signal: new AbortController().signal,
    settled: false,
    completed: new Map(),
    progress: vi.fn(),
    settle: vi.fn().mockResolvedValue(undefined),
  };
  await operationExecution.run(operation, () =>
    withExecutionSignal(input.signal, async () => {
      expect(operationExecution.getStore()).toBe(operation);
      expect(executionSignal()?.aborted).toBe(false);
      input.abort();
      expect(executionSignal()?.aborted).toBe(true);
      await withExecutionCleanup(async () => {
        expect(executionSignal()?.aborted).toBe(false);
        await Promise.resolve();
      });
      expect(executionSignal()?.aborted).toBe(true);
    }),
  );
  expect(executionSignal()).toBeUndefined();
  expect(operation.settle).not.toHaveBeenCalled();
});
