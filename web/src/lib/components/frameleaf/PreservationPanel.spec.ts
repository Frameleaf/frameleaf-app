import {
  MediaOperationStatus,
  PreservationPackageOrigin,
  PreservationPackageStatus,
  type PreservationPackageDto,
} from '@frameleaf/sdk';
import { render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import PreservationPanel from './PreservationPanel.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'me', isAdmin: false } } }));

/** A package whose export is still running, so the panel keeps reading the list. */
const exporting = {
  id: 'package-1',
  name: 'Family archive',
  origin: PreservationPackageOrigin.Export,
  status: PreservationPackageStatus.Exporting,
  sizeBytes: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  expiresAt: null,
  scopeDescription: null,
  counts: { copied: 1, total: 4, failed: 0, skipped: 0 },
  manifest: null,
  verification: null,
  downloadable: false,
  restorable: false,
  lockedContent: false,
  operation: {
    id: 'operation-1',
    status: MediaOperationStatus.Rendering,
    pauseRequestedAt: null,
    autoRetries: 0,
    totalUnits: '4',
    processedUnits: '1',
    progress: 25,
  },
} as unknown as PreservationPackageDto;

describe('PreservationPanel (FL-74)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getPreservationRestores.mockResolvedValue([]);
  });

  afterEach(() => vi.useRealTimers());

  it('stops reading the packages once the panel is gone, even with a read on its way', async () => {
    vi.useFakeTimers();
    let answer: (value: PreservationPackageDto[]) => void = () => {};
    sdkMock.getPreservationPackages
      .mockResolvedValueOnce([exporting])
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)) as never)
      .mockResolvedValue([exporting]);
    const { unmount } = render(PreservationPanel);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('Family archive')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(2500);
    expect(sdkMock.getPreservationPackages).toHaveBeenCalledTimes(2);

    unmount();
    answer([exporting]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sdkMock.getPreservationPackages).toHaveBeenCalledTimes(2);
  });
});
