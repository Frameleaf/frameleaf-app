import { describe, expect, it, vi } from 'vitest';
import { createStudioBridge, type StudioBridgeContext } from './bridge';
import { createStudioCommandEnvelope } from './commands';
import { emptyStudioCapabilities } from './host-contract';
import { rational } from './rational-time';

const context = (overrides: Partial<StudioBridgeContext> = {}): StudioBridgeContext => ({
  revision: 4,
  hasLease: true,
  hasAccess: true,
  online: true,
  capabilities: { ...emptyStudioCapabilities(), gpuWorker: true, renderWorker: true },
  ...overrides,
});

describe('studio command bridge', () => {
  it('lets a review-only session ask for a preview, because reviewing needs a picture (FL-96)', async () => {
    const request = vi.fn().mockResolvedValue(4);
    const bridge = createStudioBridge({
      context: () => context({ hasLease: false }),
      handlers: { 'preview.request': request },
    });

    const [result] = await bridge.submit([
      createStudioCommandEnvelope(
        'preview.request',
        { at: rational(1001, 30_000), quality: 'standard', viewportWidth: 960, viewportHeight: 540 },
        4,
      ),
    ]);

    expect(result.status).toBe('accepted');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('lets a reviewer comment without the lease or the head revision, because comments sit beside the graph (FL-89)', async () => {
    const add = vi.fn().mockResolvedValue(4);
    const bridge = createStudioBridge({
      context: () => context({ hasLease: false, revision: 4 }),
      handlers: { 'review.add': add },
    });

    // The reviewer is looking at revision 3 while the owner has saved revision 4.
    const [result] = await bridge.submit([
      createStudioCommandEnvelope('review.add', { time: rational(2), text: 'Hold this shot longer' }, 3),
    ]);

    expect(result.status).toBe('accepted');
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('refuses a preview on a deployment with no GPU worker rather than showing nothing', async () => {
    const bridge = createStudioBridge({
      context: () => context({ capabilities: { ...emptyStudioCapabilities(), renderWorker: true } }),
      handlers: { 'preview.request': vi.fn().mockResolvedValue(4) },
    });

    const [result] = await bridge.submit([
      createStudioCommandEnvelope(
        'preview.request',
        { at: rational(0), quality: 'draft', viewportWidth: 960, viewportHeight: 540 },
        4,
      ),
    ]);

    expect(result).toMatchObject({ status: 'rejected', reason: 'capability-missing' });
  });

  it('rejects a command nobody implements yet instead of pretending it worked', async () => {
    const bridge = createStudioBridge({ context: () => context() });

    const [result] = await bridge.submit([createStudioCommandEnvelope('clip.split', { at: rational(2) }, 4)]);

    expect(result).toMatchObject({ status: 'rejected', reason: 'not-implemented' });
  });

  it('reports access loss ahead of every other reason', async () => {
    const bridge = createStudioBridge({
      context: () => context({ hasAccess: false, online: false, hasLease: false, revision: 99 }),
    });

    const [result] = await bridge.submit([createStudioCommandEnvelope('clip.split', { at: rational(2) }, 4)]);

    expect(result).toMatchObject({ status: 'rejected', reason: 'forbidden' });
  });

  it('reports offline ahead of a stale revision, because offline proves nothing about it', async () => {
    const bridge = createStudioBridge({ context: () => context({ online: false, revision: 99 }) });

    const [result] = await bridge.submit([createStudioCommandEnvelope('clip.split', { at: rational(2) }, 4)]);

    expect(result).toMatchObject({ status: 'rejected', reason: 'offline' });
  });

  it('refuses graph changes without the lease, ahead of the revision check', async () => {
    const bridge = createStudioBridge({ context: () => context({ hasLease: false, revision: 99 }) });

    const [result] = await bridge.submit([createStudioCommandEnvelope('clip.split', { at: rational(2) }, 4)]);

    // A review-only session is told it cannot write, not that it is out of date.
    expect(result).toMatchObject({ status: 'rejected', reason: 'lease-lost' });
  });

  it('hands back the current revision when the editor is behind', async () => {
    const bridge = createStudioBridge({ context: () => context({ revision: 6 }) });

    const [result] = await bridge.submit([createStudioCommandEnvelope('clip.split', { at: rational(2) }, 4)]);

    expect(result).toMatchObject({ status: 'rejected', reason: 'stale-revision', revision: 6 });
  });

  it('refuses a command whose worker is missing, naming the capability reason', async () => {
    const bridge = createStudioBridge({
      context: () => context({ capabilities: { ...emptyStudioCapabilities(), gpuWorker: true } }),
      handlers: { 'job.enqueueExport': async () => 4 },
    });

    const [result] = await bridge.submit([
      createStudioCommandEnvelope(
        'job.enqueueExport',
        { sequenceId: 'seq-1', format: 'MP4', colour: 'HDR10', resolution: '2160p', destinationId: 'local' },
        4,
      ),
    ]);

    expect(result).toMatchObject({ reason: 'capability-missing' });
  });

  it('applies an implemented command through its handler and returns the new revision', async () => {
    const handler = vi.fn().mockResolvedValue(5);
    const bridge = createStudioBridge({ context: () => context(), handlers: { 'clip.split': handler } });

    const [result] = await bridge.submit([createStudioCommandEnvelope('clip.split', { at: rational(2) }, 4)]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ status: 'accepted', idempotencyKey: expect.any(String), revision: 5 });
  });

  it('answers a repeated key from the record instead of applying it twice', async () => {
    const handler = vi.fn().mockResolvedValue(5);
    const bridge = createStudioBridge({ context: () => context(), handlers: { 'clip.split': handler } });
    const envelope = createStudioCommandEnvelope('clip.split', { at: rational(2) }, 4, { idempotencyKey: 'once' });

    const first = await bridge.submit([envelope]);
    const retry = await bridge.submit([envelope]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(retry[0]).toEqual(first[0]);
  });

  it('lets a retry through when the first attempt never reached a verdict', async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(5);
    const bridge = createStudioBridge({ context: () => context(), handlers: { 'clip.split': handler } });
    const envelope = createStudioCommandEnvelope('clip.split', { at: rational(2) }, 4, {
      idempotencyKey: 'unknown-outcome',
    });

    const [failed] = await bridge.submit([envelope]);
    const [retried] = await bridge.submit([envelope]);

    expect(failed).toMatchObject({ reason: 'failed' });
    expect(retried).toMatchObject({ status: 'accepted', revision: 5 });
  });

  it('evaluates a batch in order and reports one result per envelope', async () => {
    let revision = 4;
    const bridge = createStudioBridge({
      context: () => context({ revision }),
      handlers: {
        'clip.split': async () => {
          revision += 1;
          return revision;
        },
      },
    });

    const results = await bridge.submit([
      createStudioCommandEnvelope('clip.split', { at: rational(1) }, 4),
      // Issued against the revision the first one produced.
      createStudioCommandEnvelope('clip.split', { at: rational(2) }, 5),
      // Still on the original revision, so it is stale by the time it is evaluated.
      createStudioCommandEnvelope('clip.split', { at: rational(3) }, 4),
    ]);

    expect(results.map((result) => result.status)).toEqual(['accepted', 'accepted', 'rejected']);
    expect(results[2]).toMatchObject({ reason: 'stale-revision', revision: 6 });
  });

  it('rejects a message that is not an envelope without recording it as settled', async () => {
    const bridge = createStudioBridge({ context: () => context() });

    const [result] = await bridge.submit([{ id: 'clip.explode' } as never]);

    expect(result).toMatchObject({ status: 'rejected', reason: 'invalid', idempotencyKey: 'unknown' });
  });
});
