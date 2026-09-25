import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import {
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
    };
    sdkMock.getMlCapabilities.mockResolvedValue({
      ...snapshot({ renderWorker: true }),
      studio: { ...snapshot({ renderWorker: true }).studio, render: [row] },
    } as never);
    await expect(probeStudioHost()).resolves.toMatchObject({ renderEvidence: [row] });

    expect(toStudioRenderEvidence({ render: [row, { ...row, hdr10: 'yes' }, null] as never })).toEqual([row]);
    expect(toStudioRenderEvidence({} as never)).toEqual([]);

    sdkMock.getMlCapabilities.mockRejectedValue(new Error('offline'));
    await expect(probeStudioHost()).resolves.toEqual({ capabilities: expect.any(Object), renderEvidence: [] });
  });
});
