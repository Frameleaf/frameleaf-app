import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../i18n/en.json';
import CloudMlConsentDialog from './CloudMlConsentDialog.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const consent = {
  requiredVersion: '2026-10-01',
  recordedVersion: null,
  acceptedVersion: null,
  features: { identityNames: false, medicalSignals: false, ocrAddon: false },
  summary: 'Media is processed in the EU region.',
  documentUrl: null,
  outdated: false,
};

describe('CloudMlConsentDialog (FL-159)', () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries the consent on the destination it already added, never adding a second one', async () => {
    const onRecorded = vi.fn();
    sdkMock.createCloudMlDestination.mockResolvedValue({ id: 'cloud-1' } as never);
    sdkMock.grantMlDestinationConsent.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({} as never);
    render(CloudMlConsentDialog, { open: true, destinationId: null, consent, region: 'eu', onRecorded });

    const dialog = screen.getByRole('dialog', { name: 'Cloud processing terms · version 2026-10-01' });
    await fireEvent.click(within(dialog).getByRole('checkbox'));
    const accept = within(dialog).getByRole('button', { name: 'Accept and turn on' });
    await fireEvent.click(accept);
    await vi.waitFor(() => expect(sdkMock.grantMlDestinationConsent).toHaveBeenCalledTimes(1));
    expect(onRecorded).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(accept).toBeEnabled());
    await fireEvent.click(accept);
    await vi.waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    expect(sdkMock.createCloudMlDestination).toHaveBeenCalledTimes(1);
    expect(sdkMock.grantMlDestinationConsent).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'cloud-1' }));
  });
});
