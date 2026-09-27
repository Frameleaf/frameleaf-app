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

  const terms = (version: string, digest: string) => ({
    requiredVersion: version,
    recordedVersion: null,
    summary: `Terms ${version}.`,
    textSha256: digest.repeat(64),
    documentUrl: null,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getCloudMlConsentTerms.mockResolvedValue(terms('2026-10-01', 'a'));
    sdkMock.isHttpError.mockImplementation(
      (error: unknown) => typeof error === 'object' && error !== null && 'status' in error,
    );
  });

  it('retries the consent on the destination it already added, never adding a second one', async () => {
    const onRecorded = vi.fn();
    sdkMock.createCloudMlDestination.mockResolvedValue({ id: 'cloud-1' } as never);
    sdkMock.grantMlDestinationConsent.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({} as never);
    render(CloudMlConsentDialog, { open: true, destinationId: null, consent, region: 'eu', onRecorded });

    const dialog = screen.getByRole('dialog', { name: 'Cloud processing terms · version 2026-10-01' });
    await fireEvent.click(within(dialog).getByRole('checkbox'));
    const accept = within(dialog).getByRole('button', { name: 'Accept and turn on' });
    await vi.waitFor(() => expect(accept).toBeEnabled());
    await fireEvent.click(accept);
    await vi.waitFor(() => expect(sdkMock.grantMlDestinationConsent).toHaveBeenCalledTimes(1));
    expect(onRecorded).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(accept).toBeEnabled());
    await fireEvent.click(accept);
    await vi.waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
    expect(sdkMock.createCloudMlDestination).toHaveBeenCalledTimes(1);
    expect(sdkMock.grantMlDestinationConsent).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'cloud-1' }));
  });

  it('says names written in a photo may appear, and that the names given to people are never sent (FC-44)', () => {
    render(CloudMlConsentDialog, { open: true, destinationId: null, consent, region: 'eu', onRecorded: vi.fn() });

    const dialog = screen.getByRole('dialog', { name: 'Cloud processing terms · version 2026-10-01' });
    expect(within(dialog).getByText('Allow names written in photos')).toBeInTheDocument();
    expect(within(dialog).getByText(/the names you give people in Frameleaf are never sent/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Sends the names of people/)).not.toBeInTheDocument();
  });

  it('shows and accepts the terms Frameleaf Cloud asks for with the features chosen now (FC-62)', async () => {
    sdkMock.getCloudMlConsentTerms.mockImplementation(({ medicalSignals }) =>
      Promise.resolve(medicalSignals ? terms('2026-11-01.2', 'b') : terms('2026-10-01', 'a')),
    );
    sdkMock.grantMlDestinationConsent.mockResolvedValue({} as never);
    render(CloudMlConsentDialog, { open: true, destinationId: 'cloud-1', consent, region: 'eu', onRecorded: vi.fn() });

    await screen.findByText('Terms 2026-10-01.');
    await fireEvent.click(screen.getByRole('switch', { name: /Describe health and medical details/ }));
    await screen.findByRole('dialog', { name: 'Cloud processing terms · version 2026-11-01.2' });
    expect(screen.getByText('Terms 2026-11-01.2.')).toBeInTheDocument();
    expect(sdkMock.getCloudMlConsentTerms).toHaveBeenLastCalledWith({ identityNames: false, medicalSignals: true });

    await fireEvent.click(screen.getByRole('checkbox', { name: /I have read these terms/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'Accept and turn on' }));
    await vi.waitFor(() => expect(sdkMock.grantMlDestinationConsent).toHaveBeenCalledTimes(1));
    expect(sdkMock.grantMlDestinationConsent).toHaveBeenCalledWith({
      id: 'cloud-1',
      mlDestinationConsentRequestDto: {
        acknowledgeMediaLeavesNetwork: true,
        version: '2026-11-01.2',
        textSha256: 'b'.repeat(64),
        features: { identityNames: false, medicalSignals: true, ocrAddon: false },
      },
    });
  });

  it('reads and shows the terms again when they changed before accepting, never accepting them unseen (FC-62)', async () => {
    sdkMock.getCloudMlConsentTerms
      .mockResolvedValueOnce(terms('2026-10-01', 'a'))
      .mockResolvedValue(terms('2026-10-02.1', 'c'));
    sdkMock.grantMlDestinationConsent.mockRejectedValueOnce({
      status: 409,
      data: { code: 'consent-version-outdated', requiredVersion: '2026-10-02.1' },
    });
    render(CloudMlConsentDialog, { open: true, destinationId: 'cloud-1', consent, region: 'eu', onRecorded: vi.fn() });

    await screen.findByText('Terms 2026-10-01.');
    const read = screen.getByRole('checkbox', { name: /I have read these terms/ });
    await fireEvent.click(read);
    await fireEvent.click(screen.getByRole('button', { name: 'Accept and turn on' }));

    await screen.findByText('Terms 2026-10-02.1.');
    expect(screen.getByText(/Frameleaf Cloud now asks for these terms/)).toBeInTheDocument();
    expect(read).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Accept and turn on' })).toBeDisabled();
    expect(sdkMock.grantMlDestinationConsent).toHaveBeenCalledTimes(1);
  });
});
