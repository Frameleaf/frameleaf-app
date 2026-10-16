import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { QueueExecution } from 'src/queue/types.js';
import * as context from 'src/queue/context.js';
import { JobDependencyUnavailable } from 'src/queue/dependency.js';
import { DesktopMlService } from 'src/services/desktop-ml.service.js';

const repository = { create: vi.fn(), result: vi.fn(), cancel: vi.fn(), assertAdoption: vi.fn(), discard: vi.fn() };
const request = () => ({
  ownerId: 'owner',
  modelKey: 'model',
  authorityKey: 'authority',
  config: {},
  input: Buffer.from('fixture'),
  inputKind: 'text' as const,
  deadlineAt: new Date(Date.now() + 60_000),
});
let service: DesktopMlService;
beforeEach(() => {
  vi.resetAllMocks();
  repository.create.mockResolvedValue({ id: 'task' });
  repository.cancel.mockResolvedValue(true);
  service = new DesktopMlService(repository as never, {} as never);
});
afterEach(() => vi.restoreAllMocks());
const options = () => ({
  request: request(),
  assertAuthority: vi.fn().mockResolvedValue(undefined),
  decodeResult: (value: unknown) => value,
});

it('revalidates NAS authority before submission and result adoption', async () => {
  const input = options();
  repository.result.mockResolvedValue({
    state: 'completed',
    result: { clip: [1, 2] },
    authorityKey: 'authority',
    modelKey: 'model',
  });
  expect(await service.dispatch(input)).toEqual({ clip: [1, 2] });
  expect(input.assertAuthority).toHaveBeenCalledTimes(2);
  expect(repository.cancel).toHaveBeenCalledWith('task');
});
it('does not submit a task under stale NAS authority', async () => {
  const input = options();
  input.assertAuthority.mockRejectedValue(new Error('route changed'));
  await expect(service.dispatch(input)).rejects.toThrow('route changed');
  expect(repository.create).not.toHaveBeenCalled();
});
it('rejects results when the source or selected destination changed', async () => {
  const input = options();
  input.assertAuthority.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('source changed'));
  repository.result.mockResolvedValue({ state: 'completed', result: {}, authorityKey: 'authority', modelKey: 'model' });
  await expect(service.dispatch(input)).rejects.toThrow('source changed');
  expect(repository.cancel).toHaveBeenCalledWith('task');
});
it('rejects a mismatched task identity before decoding it', async () => {
  const input = { ...options(), decodeResult: vi.fn() };
  repository.result.mockResolvedValue({ state: 'completed', result: {}, authorityKey: 'different', modelKey: 'model' });
  await expect(service.dispatch(input)).rejects.toThrow('desktop_result_identity_changed');
  expect(input.decodeResult).not.toHaveBeenCalled();
});
it('cancellation fences the task while waiting for a worker', async () => {
  const controller = new AbortController();
  repository.result.mockImplementation(() => {
    controller.abort(new Error('NAS job cancelled'));
    return Promise.resolve({ state: 'running' });
  });
  await expect(service.dispatch({ ...options(), signal: controller.signal })).rejects.toThrow('NAS job cancelled');
  expect(repository.cancel).toHaveBeenCalledWith('task');
});
it('refuses invalid output and terminal worker failure', async () => {
  repository.result.mockResolvedValueOnce({
    state: 'completed',
    result: {},
    authorityKey: 'authority',
    modelKey: 'model',
  });
  await expect(
    service.dispatch({
      ...options(),
      decodeResult: () => {
        throw new Error('invalid vector');
      },
    }),
  ).rejects.toThrow('invalid vector');
  repository.result.mockResolvedValueOnce({ state: 'failed' });
  await expect(service.dispatch(options())).rejects.toThrow('desktop_inference_failed');
});

it('defers the device fence into the NAS queue publication transaction', async () => {
  let adoption: ((tx: never) => Promise<void>) | undefined;
  vi.spyOn(context, 'deferJobAdoption').mockImplementation((callback) => {
    adoption = callback;
    return true;
  });
  vi.spyOn(context, 'afterJobCommit').mockResolvedValue(undefined);
  repository.result.mockResolvedValue({ state: 'completed', result: {}, authorityKey: 'authority', modelKey: 'model' });
  await service.dispatch(options());
  expect(repository.assertAdoption).not.toHaveBeenCalled();
  await adoption!('publication-transaction' as never);
  expect(repository.assertAdoption).toHaveBeenCalledWith('task', { id: 'task' }, 'publication-transaction');
  expect(repository.cancel).not.toHaveBeenCalled();
});

it('rechecks selected NAS authority inside deferred publication before adopting worker output', async () => {
  let adoption: ((tx: never) => Promise<void>) | undefined;
  vi.spyOn(context, 'deferJobAdoption').mockImplementation((callback) => {
    adoption = callback;
    return true;
  });
  vi.spyOn(context, 'afterJobCommit').mockResolvedValue(undefined);
  repository.result.mockResolvedValue({ state: 'completed', result: {}, authorityKey: 'authority', modelKey: 'model' });
  const input = options();
  await service.dispatch(input);
  input.assertAuthority.mockRejectedValue(new Error('policy revoked before publication'));
  await expect(adoption!('transaction' as never)).rejects.toThrow('policy revoked before publication');
  expect(repository.assertAdoption).not.toHaveBeenCalled();
});

const queued = (signal = new AbortController().signal): QueueExecution => ({
  claim: { data: {}, safeToRetry: true } as never,
  signal,
  progress: vi.fn(),
  progressUnits: 0,
  buffering: false,
  adoptions: [],
  followups: [],
});
it('defers an unclaimed helper task and cleans private input before returning to the NAS queue', async () => {
  const controller = new AbortController();
  const execution = queued(controller.signal);
  const began = performance.now();
  repository.result.mockImplementation(() => {
    vi.spyOn(performance, 'now').mockReturnValue(began + 6000);
    return Promise.resolve({ state: 'pending', generation: 0 });
  });
  const fallback = setTimeout(() => controller.abort(new Error('test cleanup')), 30);
  try {
    await expect(context.queueExecution.run(execution, () => service.dispatch(options()))).rejects.toBeInstanceOf(
      JobDependencyUnavailable,
    );
    expect(execution.dependencyReason).toBe('destination-unavailable');
    expect(repository.cancel).toHaveBeenCalledWith('task');
    expect(repository.discard).toHaveBeenCalledWith('task');
  } finally {
    clearTimeout(fallback);
    controller.abort();
  }
});
it('treats bounded broker saturation as queue capacity, without inventing a task to clean', async () => {
  const execution = queued();
  repository.create.mockRejectedValue(new Error('desktop_broker_busy'));
  await expect(context.queueExecution.run(execution, () => service.dispatch(options()))).rejects.toBeInstanceOf(
    JobDependencyUnavailable,
  );
  expect(execution.dependencyReason).toBe('destination-unavailable');
  expect(repository.cancel).not.toHaveBeenCalled();
});
it('leaves cleanup time in a nearly exhausted NAS claim instead of starting more private work', async () => {
  const execution = queued();
  const input = options();
  input.request.deadlineAt = new Date(Date.now() + 1000);
  await expect(context.queueExecution.run(execution, () => service.dispatch(input))).rejects.toBeInstanceOf(
    JobDependencyUnavailable,
  );
  expect(repository.create).not.toHaveBeenCalled();
});
it('does not turn an actual terminal worker failure into a dependency wait', async () => {
  const execution = queued();
  repository.result.mockResolvedValue({ state: 'failed', generation: 3 });
  await expect(context.queueExecution.run(execution, () => service.dispatch(options()))).rejects.toThrow(
    'desktop_inference_failed',
  );
  expect(execution.dependencyReason).toBeUndefined();
});

it('lets a claimed worker finish after the unclaimed-helper window', async () => {
  const execution = queued();
  const began = performance.now();
  repository.result
    .mockImplementationOnce(() => {
      vi.spyOn(performance, 'now').mockReturnValue(began + 6000);
      return Promise.resolve({ state: 'running', generation: 1 });
    })
    .mockResolvedValueOnce({
      state: 'completed',
      result: { clip: [1, 2] },
      authorityKey: 'authority',
      modelKey: 'model',
    });
  await expect(context.queueExecution.run(execution, () => service.dispatch(options()))).resolves.toEqual({
    clip: [1, 2],
  });
  expect(execution.dependencyReason).toBeUndefined();
  expect(repository.cancel).not.toHaveBeenCalled();
});

it('preserves operation-owned execution instead of inventing a library dependency wait', async () => {
  const execution = queued();
  execution.claim.data.operationId = 'synthetic-operation';
  const began = performance.now();
  repository.result
    .mockImplementationOnce(() => {
      vi.spyOn(performance, 'now').mockReturnValue(began + 6000);
      return Promise.resolve({ state: 'pending', generation: 0 });
    })
    .mockResolvedValueOnce({
      state: 'completed',
      result: { clip: [1, 2] },
      authorityKey: 'authority',
      modelKey: 'model',
    });
  await expect(context.queueExecution.run(execution, () => service.dispatch(options()))).resolves.toEqual({
    clip: [1, 2],
  });
  expect(execution.dependencyReason).toBeUndefined();
});
