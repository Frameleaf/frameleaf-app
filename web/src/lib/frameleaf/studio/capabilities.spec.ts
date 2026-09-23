import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { probeStudioCapabilities, toStudioCapabilities } from '$lib/frameleaf/studio/capabilities';
import { emptyStudioCapabilities } from '$lib/frameleaf/studio/host-contract';

const snapshot = (studio: Record<string, boolean>) => ({
  workloads: [],
  studio: { gpuWorker: false, renderWorker: false, restorationWorker: false, transcriptionWorker: false, ...studio },
  probedAt: '2026-09-22T12:00:00.000Z',
});

describe('probeStudioCapabilities (FL-110)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the Studio row of the server capability snapshot', async () => {
    sdkMock.getMlCapabilities.mockResolvedValue(snapshot({ restorationWorker: true, transcriptionWorker: true }));

    await expect(probeStudioCapabilities()).resolves.toEqual({
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
      }),
    ).toEqual({ gpuWorker: false, renderWorker: false, restorationWorker: true, transcriptionWorker: false });
  });
});
