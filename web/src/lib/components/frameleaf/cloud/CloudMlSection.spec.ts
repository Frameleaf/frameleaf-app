import {
  CloudMlConnection,
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkerRole,
  MlWorkload,
  type CloudMlStatusResponseDto,
  type MlDestinationResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import CloudMlSection from './CloudMlSection.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const destination: MlDestinationResponseDto = {
  id: '22222222-2222-4222-8222-222222222222',
  kind: MlDestinationKind.FrameleafCloud,
  name: 'Frameleaf Cloud',
  url: null,
  authTokenConfigured: false,
  enabled: true,
  workloads: [MlWorkload.Enrichment, MlWorkload.RestorationFaithful],
  role: MlWorkerRole.Mixed,
  sharesLibraryHardware: false,
  consent: { required: true, acknowledgedAt: null, acknowledgedBy: null, requiredVersion: '2026-10-01', version: null },
  cloud: null,
  costControls: {
    budgetLimitUsd: null,
    maxRuntimeMinutes: null,
    maxUploadBytes: null,
    spentUsd: 0,
    budgetWindowDays: 30,
  },
  health: { status: MlDestinationHealth.Unknown, probedAt: null, summary: null, servedWorkloads: null },
  createdAt: '2026-09-25T00:00:00.000Z',
  updatedAt: '2026-09-25T00:00:00.000Z',
};

const wallet = {
  balanceUsd: 12,
  heldUsd: 2,
  availableUsd: 10,
  dailyCapUsd: null,
  spentTodayUsd: 0,
  topUpUrl: null as string | null,
  updatedAt: '2026-09-25T09:00:00.000Z',
};

const status = (overrides: Partial<CloudMlStatusResponseDto> = {}): CloudMlStatusResponseDto => ({
  connection: CloudMlConnection.Ready,
  detail: null,
  enabled: true,
  region: 'eu',
  entitled: true,
  destination,
  consent: {
    requiredVersion: '2026-10-01',
    recordedVersion: null,
    acceptedVersion: null,
    features: { identityNames: false, medicalSignals: false, ocrAddon: false },
    summary: 'Media is processed in the EU region and deleted after each job.',
    documentUrl: null,
    outdated: false,
  },
  wallet,
  checkedAt: '2026-09-25T09:00:00.000Z',
  ...overrides,
});

describe('CloudMlSection (FL-159)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getCloudMlStatus.mockResolvedValue(status());
    sdkMock.getMlWorkloadRoutes.mockResolvedValue({
      routes: [{ workload: MlWorkload.Enrichment, destinationId: destination.id, modelId: null }],
    });
    sdkMock.getCloudMlConsentHistory.mockResolvedValue({ records: [] });
    sdkMock.getCloudMlSettlements.mockResolvedValue({ items: [] });
    sdkMock.getCloudMlCatalog.mockResolvedValue({
      models: [
        {
          id: 'describe-2',
          workload: MlWorkload.Enrichment,
          name: 'Describe 2',
          description: 'Detailed descriptions',
          fingerprint: 'f2',
          pricingUnit: 'image',
          priceUsd: 0.002,
        },
      ],
    });
  });

  it('says plainly when the server is not linked, and asks the cloud for nothing it cannot answer', async () => {
    sdkMock.getCloudMlStatus.mockResolvedValue(
      status({ connection: CloudMlConnection.NotLinked, destination: null, consent: null, wallet: null, region: null }),
    );
    render(CloudMlSection);

    expect(await screen.findByText('Not linked to a Frameleaf account')).toBeInTheDocument();
    expect(screen.getByText(/Link this server to your Frameleaf account/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Frameleaf Cloud' })).toBeDisabled();
    expect(screen.getByText('The balance is shown once Frameleaf Cloud answers.')).toBeInTheDocument();
    expect(sdkMock.getCloudMlCatalog).not.toHaveBeenCalled();
  });

  it('adds Frameleaf Cloud with the chosen work and no URL or token', async () => {
    sdkMock.getCloudMlStatus.mockResolvedValue(status({ destination: null, consent: null }));
    sdkMock.createCloudMlDestination.mockResolvedValue(destination);
    render(CloudMlSection);

    const add = await screen.findByRole('button', { name: 'Add Frameleaf Cloud' });
    expect(screen.queryByLabelText('Face recognition')).not.toBeInTheDocument();
    await fireEvent.click(screen.getByLabelText('Studio renders'));
    await fireEvent.click(add);

    await waitFor(() =>
      expect(sdkMock.createCloudMlDestination).toHaveBeenCalledWith({
        cloudMlDestinationCreateDto: {
          workloads: [
            MlWorkload.Enrichment,
            MlWorkload.RestorationFaithful,
            MlWorkload.RestorationCreative,
            MlWorkload.StudioAi,
            MlWorkload.Upscale,
            MlWorkload.Interpolation,
          ],
          budgetLimitUsd: null,
        },
      }),
    );
  });

  it('asks for consent before anything runs and records the required version', async () => {
    sdkMock.grantMlDestinationConsent.mockResolvedValue(destination);
    render(CloudMlSection);

    expect(await screen.findByText(/refuses every job until consent/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Review consent' }));
    const dialog = await screen.findByRole('dialog', { name: 'Frameleaf Cloud consent' });
    await fireEvent.click(within(dialog).getByRole('switch', { name: 'People names' }));
    await fireEvent.click(within(dialog).getByRole('checkbox'));
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Record consent' }));

    await waitFor(() =>
      expect(sdkMock.grantMlDestinationConsent).toHaveBeenCalledWith({
        id: destination.id,
        mlDestinationConsentRequestDto: {
          acknowledgeMediaLeavesNetwork: true,
          version: '2026-10-01',
          features: { identityNames: true, medicalSignals: false, ocrAddon: false },
        },
      }),
    );
  });

  it('shows the AI Wallet the cloud reported, with a top-up link only when the cloud sent one', async () => {
    render(CloudMlSection);
    const card = await screen.findByRole('article', { name: 'AI Wallet' });
    expect(within(card).getByText('$10.00')).toBeInTheDocument();
    expect(within(card).getByText('Balance $12.00 · $2.00 held by running jobs')).toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: /Add credit/ })).not.toBeInTheDocument();
  });

  it('offers a top-up link when the cloud returned one, and warns when nothing is left', async () => {
    sdkMock.getCloudMlStatus.mockResolvedValue(
      status({ wallet: { ...wallet, availableUsd: 0, topUpUrl: 'https://account.frameleaf.test/wallet' } }),
    );
    render(CloudMlSection);
    const card = await screen.findByRole('article', { name: 'AI Wallet' });
    expect(within(card).getByRole('link', { name: /Add credit/ })).toHaveAttribute(
      'href',
      'https://account.frameleaf.test/wallet',
    );
    expect(within(card).getByText(/The AI Wallet is empty/)).toBeInTheDocument();
  });

  it('chooses a catalogue model for a workload routed to Frameleaf Cloud', async () => {
    sdkMock.setMlWorkloadRoute.mockResolvedValue({ routes: [] });
    render(CloudMlSection);

    const picker = (await screen.findByLabelText('Descriptions, tags and content checks')) as HTMLSelectElement;
    expect([...picker.options].map((option) => option.text)).toEqual([
      "Frameleaf Cloud's default",
      'Describe 2 · $0.002 per image',
    ]);
    await fireEvent.change(picker, { target: { value: 'describe-2' } });

    await waitFor(() =>
      expect(sdkMock.setMlWorkloadRoute).toHaveBeenCalledWith({
        workload: MlWorkload.Enrichment,
        mlWorkloadRouteUpdateDto: { destinationId: destination.id, modelId: 'describe-2' },
      }),
    );
  });

  it('lists consent records and settled charges as the history', async () => {
    sdkMock.getCloudMlConsentHistory.mockResolvedValue({
      records: [
        {
          version: '2026-09-25',
          features: { identityNames: false, medicalSignals: false, ocrAddon: false },
          acceptedBy: 'admin',
          acceptedAt: '2026-09-25T08:00:00.000Z',
          revokedAt: null,
        },
      ],
    });
    sdkMock.getCloudMlSettlements.mockResolvedValue({
      items: [
        {
          cloudJobId: 'job-1',
          workload: MlWorkload.Enrichment,
          jobName: 'ImageDescription',
          succeeded: true,
          costUsd: 0.42,
          credits: 42,
          finishedAt: '2026-09-25T10:00:00.000Z',
        },
      ],
    });
    render(CloudMlSection);

    expect(await screen.findByText('Consent recorded for version 2026-09-25')).toBeInTheDocument();
    expect(screen.getByText('Descriptions, tags and content checks · $0.42')).toBeInTheDocument();
  });
});
