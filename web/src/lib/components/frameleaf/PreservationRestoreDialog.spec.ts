import {
  MediaOperationStatus,
  PreservationDecision,
  PreservationRestoreStatus,
  type PreservationRestoreDto,
} from '@frameleaf/sdk';
import { render } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import PreservationRestoreDialog from './PreservationRestoreDialog.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

/** A restoration whose check is still running, so the dialog keeps reading it while open. */
const reviewing = {
  id: 'restore-1',
  name: 'Family archive',
  packageId: 'package-1',
  status: PreservationRestoreStatus.Reviewing,
  conflictDefault: PreservationDecision.Keep,
  restoreEditRecipes: true,
  albums: 0,
  people: 0,
  reasonKey: null,
  support: [],
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  counts: {
    conflicts: 0,
    existing: 0,
    failed: 0,
    findings: 0,
    locked: 0,
    matched: 0,
    new: 0,
    pending: 4,
    ready: 0,
    restored: 0,
  },
  operation: {
    id: 'operation-1',
    status: MediaOperationStatus.Rendering,
    pauseRequestedAt: null,
    autoRetries: 0,
    totalUnits: '4',
    processedUnits: '1',
    progress: 25,
  },
} as unknown as PreservationRestoreDto;

describe('PreservationRestoreDialog (FL-74)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  it('stops reading the restoration once the dialog is gone, even with a read on its way', async () => {
    vi.useFakeTimers();
    let answer: (value: PreservationRestoreDto) => void = () => {};
    sdkMock.getPreservationRestore
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)) as never)
      .mockResolvedValue(reviewing);
    // Unmounted while still open: its owner (the preservation panel) went away.
    const { unmount } = render(PreservationRestoreDialog, { open: true, restore: reviewing, packages: [] });

    await vi.advanceTimersByTimeAsync(2500);
    expect(sdkMock.getPreservationRestore).toHaveBeenCalledTimes(1);

    unmount();
    answer(reviewing);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sdkMock.getPreservationRestore).toHaveBeenCalledTimes(1);
  });
});
