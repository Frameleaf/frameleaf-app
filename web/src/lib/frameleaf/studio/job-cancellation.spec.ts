import { MediaOperationStatus, type MediaOperationDto } from '@frameleaf/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { ActivitySession } from '$lib/frameleaf/activity-session.svelte';
import { createStudioBridge, type StudioBridgeContext } from './bridge';
import { createStudioCommandEnvelope } from './commands';
import { emptyStudioCapabilities } from './host-contract';
import { createStudioRestorationHandlers } from './restoration-jobs';

const operation = {
  id: '0195e2a0-0000-7000-8000-000000000001',
  status: MediaOperationStatus.Rendering,
} as MediaOperationDto;

const setup = (overrides: Partial<StudioBridgeContext> = {}) => {
  const session = new ActivitySession();
  session.operations = [operation];
  const graph = { tracks: [] };
  let revision = 7;
  const handlers = createStudioRestorationHandlers({
    graph: () => graph,
    revision: () => revision,
    cancel: (id: string) => session.cancel(id),
    onQueued: vi.fn(),
    onRefused: vi.fn(),
    onConfirmOnCloud: vi.fn(),
  });
  const bridge = createStudioBridge({
    context: () => ({
      revision,
      hasAccess: true,
      online: true,
      hasLease: false,
      capabilities: emptyStudioCapabilities(),
      ...overrides,
    }),
    handlers,
  });
  const envelope = createStudioCommandEnvelope('job.cancel', { jobId: operation.id }, 6);
  return { session, graph, bridge, envelope, setRevision: (value: number) => (revision = value) };
};

describe('Studio durable job cancellation', () => {
  beforeEach(() => vi.resetAllMocks());

  it('keeps the worker cancellation acknowledgment pending in Activity and leaves the graph alone', async () => {
    sdkMock.cancelMediaOperation.mockImplementation(async ({ id }) => {
      if (id !== operation.id) {
        throw new Error('unknown operation');
      }
      return { ...operation, status: MediaOperationStatus.Cancelling };
    });
    const { session, graph, bridge, envelope } = setup();

    const [result] = await bridge.submit([envelope]);

    expect(result).toMatchObject({ status: 'accepted', revision: 7 });
    expect(session.operations[0].status).toBe(MediaOperationStatus.Cancelling);
    expect(session.runningCount).toBe(1);
    expect(graph).toEqual({ tracks: [] });
  });

  it('settles a repeated command once even when its response is retried', async () => {
    let requests = 0;
    sdkMock.cancelMediaOperation.mockImplementation(async () => {
      if (++requests > 1) {
        throw new Error('already cancelling');
      }
      return { ...operation, status: MediaOperationStatus.Cancelling };
    });
    const { bridge, envelope } = setup();

    const first = await bridge.submit([envelope]);
    const retry = await bridge.submit([envelope]);

    expect(first[0]).toMatchObject({ status: 'accepted', revision: 7 });
    expect(retry).toEqual(first);
    expect(requests).toBe(1);
  });

  it.each(['operation belongs to another user', 'job already finished', 'connection lost'])(
    'reports a cancellation failure (%s) without inventing a stopped Activity row',
    async (message) => {
      sdkMock.cancelMediaOperation.mockRejectedValue(new Error(message));
      const { session, bridge, envelope } = setup();

      const [result] = await bridge.submit([envelope]);

      expect(result).toMatchObject({ status: 'rejected', reason: 'failed' });
      expect(session.operations[0].status).toBe(MediaOperationStatus.Rendering);
    },
  );

  it.each([
    [{ hasAccess: false, online: false }, 'forbidden'],
    [{ online: false }, 'offline'],
  ] as const)('refuses cancellation in context %j before reaching the API', async (context, reason) => {
    const { session, bridge, envelope } = setup(context);

    const [result] = await bridge.submit([envelope]);

    expect(result).toMatchObject({ status: 'rejected', reason });
    expect(sdkMock.cancelMediaOperation).not.toHaveBeenCalled();
    expect(session.operations[0].status).toBe(MediaOperationStatus.Rendering);
  });

  it('answers with the current graph revision only after the cancellation request succeeds', async () => {
    let acknowledge!: (value: MediaOperationDto) => void;
    sdkMock.cancelMediaOperation.mockImplementation(
      () => new Promise<MediaOperationDto>((resolve) => (acknowledge = resolve)),
    );
    const { session, bridge, envelope, setRevision } = setup();
    const submission = bridge.submit([envelope]);
    await Promise.resolve();
    expect(acknowledge).toBeTypeOf('function');
    setRevision(8);
    acknowledge({ ...operation, status: MediaOperationStatus.Cancelling });

    const [result] = await submission;

    expect(result).toMatchObject({ status: 'accepted', revision: 8 });
    expect(session.operations[0].status).toBe(MediaOperationStatus.Cancelling);
  });
});
