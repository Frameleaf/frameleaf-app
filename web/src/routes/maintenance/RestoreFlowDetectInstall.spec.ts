import { StorageFolder, type MaintenanceDetectInstallResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { deferredPromise } from '@test-data/deferred';
import RestoreFlowDetectInstall from './RestoreFlowDetectInstall.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
const install: MaintenanceDetectInstallResponseDto = {
  storage: [{ folder: StorageFolder.Upload, files: 1, readable: true, writable: true }],
};
beforeEach(() => {
  vi.resetAllMocks();
  authManager.reset();
});

it('reports an install-check failure and permits a successful retry', async () => {
  sdkMock.detectPriorInstall.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(install);
  render(RestoreFlowDetectInstall, { next: vi.fn(), end: vi.fn() });
  await screen.findByRole('alert');
  expect(handleError).toHaveBeenCalledOnce();
  await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_error_retry' }));
  await screen.findByText(/upload \(maintenance_restore_library_folder_pass\)/);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(sdkMock.detectPriorInstall).toHaveBeenCalledTimes(2);
});

it.each(['current', 'close', 'session'])(
  'reports a failed install check only to its owning step: %s',
  async (change) => {
    const pending = deferredPromise<typeof install>();
    sdkMock.detectPriorInstall.mockReturnValueOnce(pending.promise);
    const view = render(RestoreFlowDetectInstall, { next: vi.fn(), end: vi.fn() });
    await waitFor(() => expect(sdkMock.detectPriorInstall).toHaveBeenCalledOnce());
    if (change === 'close') {
      view.unmount();
    } else if (change === 'session') {
      authManager.reset();
    }
    pending.reject(new Error('Offline'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handleError).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
  },
);
