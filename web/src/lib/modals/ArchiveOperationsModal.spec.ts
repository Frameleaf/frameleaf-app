import { type ArchiveOperationResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import en from '../../../../i18n/en.json';
import ArchiveOperationsModal from './ArchiveOperationsModal.svelte';

const receipt = {
  id: 'operation',
  scope: 'selected-owned-assets',
  count: 1,
  cancelled: false,
  undo: false,
  succeeded: 0,
  pending: 1,
  skipped: 0,
  revoked: 0,
  error: 0,
  undone: 0,
  conflict: 0,
} as ArchiveOperationResponseDto;
beforeEach(() => {
  vi.resetAllMocks();
  addMessages('dev', { archive_operations: en.archive_operations });
  vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
  vi.stubGlobal('visualViewport', getVisualViewportMock());
  Element.prototype.animate = getAnimateMock();
  sdkMock.getArchiveOperations.mockResolvedValue([]);
});

it('captures selection before filter/selection replacement and retains the request key after a failed submission', async () => {
  sdkMock.createArchiveOperation.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(receipt);
  const view = render(ArchiveOperationsModal, { ids: ['first', 'first'], onClose: vi.fn() });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Archive 1 selected assets' })).not.toBeDisabled());
  await view.rerender({ ids: ['replacement'], onClose: vi.fn() });
  await fireEvent.click(screen.getByRole('button', { name: 'Archive 1 selected assets' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be completed');
  await fireEvent.click(screen.getByRole('button', { name: 'Archive 1 selected assets' }));
  await waitFor(() => expect(sdkMock.createArchiveOperation).toHaveBeenCalledTimes(2));
  const requests = sdkMock.createArchiveOperation.mock.calls.map(([request]) => request.archiveOperationCreateDto);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0].ids).toEqual(['first']);
});

it('restores durable partial results and sends cancellation/retry to the recorded operation', async () => {
  sdkMock.getArchiveOperations.mockResolvedValue([{ ...receipt, count: 3, succeeded: 1, pending: 1, revoked: 1 }]);
  sdkMock.commandArchiveOperation.mockResolvedValue({ ...receipt, cancelled: true });
  render(ArchiveOperationsModal, { onClose: vi.fn() });
  const cancel = await screen.findByRole('button', { name: 'Cancel remaining' });
  await waitFor(() => expect(cancel).not.toBeDisabled());
  await fireEvent.click(cancel);
  await waitFor(() =>
    expect(sdkMock.commandArchiveOperation).toHaveBeenCalledWith(
      { id: 'operation', archiveOperationCommandDto: { command: 'cancel' } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );
  expect(screen.getByText(/1 archived/)).toHaveTextContent('1 no longer accessible');
});

it('retires late responses on a lock event and aborts the transport', async () => {
  let resolve!: (value: ArchiveOperationResponseDto[]) => void;
  sdkMock.getArchiveOperations.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const onClose = vi.fn();
  render(ArchiveOperationsModal, { onClose });
  await waitFor(() => expect(sdkMock.getArchiveOperations).toHaveBeenCalled());
  eventManager.emit('SessionLocked');
  expect(onClose).toHaveBeenCalled();
  expect(sdkMock.getArchiveOperations.mock.calls[0][0]?.signal?.aborted).toBe(true);
  resolve([receipt]);
  await Promise.resolve();
  expect(screen.queryByText('1 selected assets · Your library')).not.toBeInTheDocument();
});
