import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureFailure } from './api';
import { connectionStatus, credentialFor } from './settings';
import { hasServerAccess } from './platform';
import { listCaptures } from './queue';
vi.mock('./queue', async (original) => ({
  ...(await original<typeof import('./queue')>()),
  listCaptures: vi.fn(),
  pruneCaptureHistory: vi.fn().mockResolvedValue(undefined),
}));
import { resumeQueue } from './runner';
import { deliveryError, stopDelivery, wakeDelivery } from './delivery';
vi.mock('./settings', () => ({
  connectionStatus: vi.fn(),
  credentialFor: vi.fn(),
}));
vi.mock('./platform', () => ({ hasServerAccess: vi.fn() }));
vi.mock('./runner', () => ({ resumeQueue: vi.fn() }));
const binding = {
  serverId: 'one',
  userId: '11111111-1111-4111-8111-111111111111',
  credentialId: '22222222-2222-4222-8222-222222222222',
  origin: 'https://frameleaf.example/path',
};
const current = { binding, status: 'connected' as const, catalog: null };
beforeEach(() => {
  stopDelivery();
  vi.clearAllMocks();
  vi.mocked(connectionStatus).mockResolvedValue(current);
  vi.mocked(credentialFor).mockResolvedValue('private-key');
  vi.mocked(hasServerAccess).mockResolvedValue(true);
  vi.mocked(resumeQueue).mockResolvedValue(undefined);
  vi.mocked(listCaptures).mockResolvedValue([]);
});
afterEach(() => {
  stopDelivery();
  vi.useRealTimers();
});
describe('background delivery coordinator', () => {
  it('does no delivery or credential lookup while disconnected/paused', async () => {
    for (const value of [
      null,
      { ...current, status: 'needs-attention' as const },
    ]) {
      vi.mocked(connectionStatus).mockResolvedValue(value);
      await wakeDelivery(vi.fn());
    }
    expect(resumeQueue).not.toHaveBeenCalled();
    expect(credentialFor).not.toHaveBeenCalled();
  });
  it('uses the selected binding, key and an abortable runner without returning credentials', async () => {
    const fatal = vi.fn();
    await wakeDelivery(fatal);
    expect(resumeQueue).toHaveBeenCalledWith(
      binding,
      'private-key',
      expect.any(AbortSignal),
    );
    expect(fatal).not.toHaveBeenCalled();
    expect(deliveryError(binding)).toBeNull();
  });
  it('requests a serialized pause callback on permission/auth loss', async () => {
    const fatal = vi.fn().mockResolvedValue(undefined);
    vi.mocked(hasServerAccess).mockResolvedValue(false);
    await wakeDelivery(fatal);
    expect(resumeQueue).not.toHaveBeenCalled();
    expect(fatal).toHaveBeenCalledWith(
      binding,
      expect.objectContaining({ code: 'permission' }),
    );
    vi.mocked(hasServerAccess).mockResolvedValue(true);
    vi.mocked(resumeQueue).mockRejectedValueOnce(
      new CaptureFailure('authorization'),
    );
    await wakeDelivery(fatal);
    expect(fatal).toHaveBeenLastCalledWith(
      binding,
      expect.objectContaining({ code: 'authorization' }),
    );
  });
  it('stops active requests immediately and a wake during shutdown uses the new connection', async () => {
    vi.mocked(resumeQueue).mockImplementationOnce(
      async (_binding, _key, signal) =>
        new Promise<void>((resolve) =>
          signal!.addEventListener('abort', () => resolve(), { once: true }),
        ),
    );
    const fatal = vi.fn();
    const first = wakeDelivery(fatal);
    await vi.waitFor(() => expect(resumeQueue).toHaveBeenCalledOnce());
    const previous = vi.mocked(resumeQueue).mock.calls[0][2]!;
    stopDelivery();
    expect(previous.aborted).toBe(true);
    const next = {
      ...binding,
      origin: 'https://other.example',
      credentialId: '33333333-3333-4333-8333-333333333333',
    };
    vi.mocked(connectionStatus).mockResolvedValue({
      ...current,
      binding: next,
    });
    vi.mocked(credentialFor).mockResolvedValue('new-key');
    const second = wakeDelivery(fatal);
    await Promise.all([first, second]);
    expect(resumeQueue).toHaveBeenLastCalledWith(
      next,
      'new-key',
      expect.any(AbortSignal),
    );
    expect(fatal).not.toHaveBeenCalled();
  });
  it('wakes at a due retry while the worker is still alive', async () => {
    vi.useFakeTimers();
    vi.mocked(listCaptures).mockResolvedValueOnce([
      { state: 'uploading', retryAt: Date.now() + 10000 },
    ] as import('./queue').CaptureTask[]);
    await wakeDelivery(vi.fn());
    expect(resumeQueue).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9999);
    expect(resumeQueue).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(resumeQueue).toHaveBeenCalledTimes(2);
  });
  it('does not recreate a retry timer after a stop during a metadata read', async () => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<import('./queue').CaptureTask[]>();
    vi.mocked(listCaptures).mockReturnValueOnce(gate.promise);
    const work = wakeDelivery(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(listCaptures).toHaveBeenCalledOnce();
    stopDelivery();
    gate.resolve([
      { state: 'uploading', retryAt: Date.now() + 10000 },
    ] as import('./queue').CaptureTask[]);
    await work;
    await vi.advanceTimersByTimeAsync(15000);
    expect(resumeQueue).toHaveBeenCalledOnce();
  });
  it('keeps safe errors scoped to the exact credential generation', async () => {
    vi.mocked(resumeQueue).mockRejectedValueOnce(
      new Error('private server diagnostic'),
    );
    await wakeDelivery(vi.fn());
    expect(deliveryError(binding)).toBeTruthy();
    expect(deliveryError(binding)).not.toContain('private');
    expect(deliveryError({ ...binding, credentialId: 'other' })).toBeNull();
  });
});
