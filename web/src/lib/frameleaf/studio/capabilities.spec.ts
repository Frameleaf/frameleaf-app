import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import {
  createStudioHostRefresh,
  probeStudioCapabilities,
  probeStudioHost,
  toStudioCapabilities,
  toStudioRenderEvidence,
} from '$lib/frameleaf/studio/capabilities';
import { emptyStudioCapabilities } from '$lib/frameleaf/studio/host-contract';

const snapshot = (studio: Record<string, boolean>) => ({
  workloads: [],
  studio: {
    gpuWorker: false,
    renderWorker: false,
    restorationWorker: false,
    transcriptionWorker: false,
    render: [],
    ...studio,
  },
  probedAt: '2026-09-22T12:00:00.000Z',
});

describe('probeStudioCapabilities (FL-110)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the Studio row of the server capability snapshot', async () => {
    sdkMock.getMlCapabilities.mockResolvedValue(snapshot({ restorationWorker: true, transcriptionWorker: true }));

    await expect(probeStudioCapabilities()).resolves.toEqual({
      analysisWorker: false,
      generationWorker: false,
      gpuWorker: false,
      renderWorker: false,
      restorationWorker: true,
      transcriptionWorker: true,
    });
  });

  it('reports every capability absent when the server cannot be asked', async () => {
    sdkMock.getMlCapabilities.mockRejectedValue(new Error('offline'));

    await expect(probeStudioCapabilities()).resolves.toEqual(emptyStudioCapabilities());
  });

  it('never promotes a missing or non-boolean field to available', () => {
    expect(
      toStudioCapabilities({
        gpuWorker: 'yes' as unknown as boolean,
        renderWorker: undefined as unknown as boolean,
        restorationWorker: true,
        transcriptionWorker: false,
        render: [],
      }),
    ).toEqual({
      analysisWorker: false,
      generationWorker: false,
      gpuWorker: false,
      renderWorker: false,
      restorationWorker: true,
      transcriptionWorker: false,
    });
  });

  it('passes on the render evidence of the same snapshot and drops malformed rows (FL-42)', async () => {
    const row = {
      destination: 'lan',
      sessions: 1,
      gpuMemoryBytes: 8_589_934_592,
      codecs: ['hevc_nvenc'],
      maxBitDepth: 10,
      hdr10: true,
      dolbyVision: false,
      candidates: [
        {
          gpuMemoryBytes: 8_589_934_592,
          outputFormats: ['mp4-hevc-main10'],
          maxBitDepth: 10,
          hdr10: true,
          dolbyVision: false,
        },
      ],
    };
    sdkMock.getMlCapabilities.mockResolvedValue({
      ...snapshot({ renderWorker: true }),
      studio: { ...snapshot({ renderWorker: true }).studio, render: [row] },
    } as never);
    await expect(probeStudioHost()).resolves.toMatchObject({ renderEvidence: [row] });

    expect(toStudioRenderEvidence({ render: [row, { ...row, hdr10: 'yes' }, null] as never })).toEqual([row]);
    for (const candidate of [
      null,
      { ...row.candidates[0], gpuMemoryBytes: NaN },
      { ...row.candidates[0], outputFormats: 'mp4' },
      { ...row.candidates[0], hdr10: 'yes' },
    ]) {
      expect(toStudioRenderEvidence({ render: [{ ...row, candidates: [candidate] }] } as never)).toEqual([]);
    }
    expect(toStudioRenderEvidence({} as never)).toEqual([]);

    sdkMock.getMlCapabilities.mockRejectedValue(new Error('offline'));
    await expect(probeStudioHost()).resolves.toEqual({ capabilities: expect.any(Object), renderEvidence: [] });
  });
});

const deferredSnapshot = () => {
  let resolve!: (value: never) => void;
  const done = new Promise<never>((finish) => {
    resolve = finish;
  });
  return { done, resolve };
};
const healthySnapshot = { ...snapshot({ gpuWorker: true, renderWorker: true }) };

describe('event-driven Studio host refresh authority', () => {
  beforeEach(() => sdkMock.getMlCapabilities.mockReset());

  it('coalesces overlapping events and publishes matching capabilities/evidence together', async () => {
    const response = deferredSnapshot();
    const row = {
      destination: 'owned-worker',
      sessions: 1,
      gpuMemoryBytes: null,
      codecs: ['h264'],
      maxBitDepth: 8,
      hdr10: false,
      dolbyVision: false,
      candidates: [],
    };
    sdkMock.getMlCapabilities.mockReturnValueOnce(response.done);
    const published: unknown[] = [];
    const gate = createStudioHostRefresh({
      hasAccess: () => true,
      onChange: (next) => {
        published.push(next);
      },
    });
    const first = gate.refresh();
    const second = gate.refresh();
    const third = gate.refresh();
    expect(published).toEqual([]);
    response.resolve({ ...healthySnapshot, studio: { ...healthySnapshot.studio, render: [row] } } as never);
    expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
    expect(published).toEqual([
      { capabilities: { ...emptyStudioCapabilities(), gpuWorker: true, renderWorker: true }, renderEvidence: [row] },
    ]);
    expect(sdkMock.getMlCapabilities).toHaveBeenCalledTimes(1);
    gate.dispose();
  });

  it('fences out-of-order responses after offline invalidation even if transport ignores cancellation', async () => {
    const older = deferredSnapshot();
    const newer = deferredSnapshot();
    sdkMock.getMlCapabilities.mockReturnValueOnce(older.done).mockReturnValueOnce(newer.done);
    const published: unknown[] = [];
    const gate = createStudioHostRefresh({
      hasAccess: () => true,
      onChange: (next) => {
        published.push(next);
      },
    });
    const stale = gate.refresh();
    const signal = sdkMock.getMlCapabilities.mock.calls[0][0]?.signal;
    gate.invalidate();
    expect(signal?.aborted).toBe(true);
    const current = gate.refresh();
    newer.resolve(snapshot({}) as never);
    expect(await current).toBe(true);
    older.resolve(healthySnapshot as never);
    expect(await stale).toBe(false);
    expect(published).toEqual([{ capabilities: emptyStudioCapabilities(), renderEvidence: [] }]);
    gate.dispose();
  });

  it('retains the last confirmed snapshot when a reconnect probe fails', async () => {
    sdkMock.getMlCapabilities
      .mockResolvedValueOnce(healthySnapshot as never)
      .mockRejectedValueOnce(new Error('offline'));
    const onChange = vi.fn();
    const gate = createStudioHostRefresh({ hasAccess: () => true, onChange });
    await gate.refresh();
    const confirmed = onChange.mock.calls[0][0];
    await gate.refresh();
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual(confirmed);
    expect(confirmed.capabilities.renderWorker).toBe(true);
    gate.dispose();
  });

  it('keeps continued refusal truthful and clears render evidence on a fresh request failure', async () => {
    sdkMock.getMlCapabilities.mockRejectedValueOnce(new Error('still refused'));
    const published: unknown[] = [];
    const gate = createStudioHostRefresh({
      hasAccess: () => true,
      onChange: (next) => {
        published.push(next);
      },
    });
    expect(await gate.refresh()).toBe(true);
    expect(published).toEqual([{ capabilities: emptyStudioCapabilities(), renderEvidence: [] }]);
    gate.dispose();
  });

  it.each(['access-loss', 'dispose'] as const)('never publishes or revives after pending %s', async (reason) => {
    const response = deferredSnapshot();
    sdkMock.getMlCapabilities.mockReturnValueOnce(response.done);
    let access = true;
    const published: unknown[] = [];
    const gate = createStudioHostRefresh({
      hasAccess: () => access,
      onChange: (next) => {
        published.push(next);
      },
    });
    const pending = gate.refresh();
    if (reason === 'dispose') {
      gate.dispose();
    } else {
      access = false;
    }
    response.resolve(healthySnapshot as never);
    expect(await pending).toBe(false);
    expect(published).toEqual([]);
    expect(await gate.refresh()).toBe(false);
    expect(sdkMock.getMlCapabilities).toHaveBeenCalledTimes(1);
    gate.dispose();
  });
});
