import {
  CloudMlConnection,
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkerRole,
  MlWorkload,
  type MlDestinationResponseDto,
  type MlWorkloadRouteDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import MlDestinationsPanel from './MlDestinationsPanel.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const destination = (overrides: Partial<MlDestinationResponseDto> = {}): MlDestinationResponseDto => ({
  id: '11111111-1111-4111-8111-111111111111',
  kind: MlDestinationKind.Local,
  name: 'This server',
  url: 'http://immich-machine-learning:3003',
  authTokenConfigured: false,
  enabled: true,
  workloads: [MlWorkload.Face, MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Enrichment],
  role: MlWorkerRole.LibraryAnalysis,
  sharesLibraryHardware: false,
  consent: { required: false, acknowledgedAt: null, acknowledgedBy: null, requiredVersion: null, version: null },
  cloud: null,
  costControls: {
    budgetLimitUsd: null,
    maxRuntimeMinutes: null,
    maxUploadBytes: null,
    spentUsd: 0,
    budgetWindowDays: 30,
  },
  health: {
    status: MlDestinationHealth.Healthy,
    probedAt: '2026-09-22T12:00:00.000Z',
    summary: 'Serves face, clip, ocr, enrichment; auto; 12 ms',
    servedWorkloads: [MlWorkload.Face, MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Enrichment],
  },
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  ...overrides,
});

const cloud = destination({
  id: '22222222-2222-4222-8222-222222222222',
  kind: MlDestinationKind.FrameleafCloud,
  name: 'Frameleaf Cloud',
  url: null,
  workloads: [MlWorkload.Enrichment, MlWorkload.RestorationFaithful],
  role: MlWorkerRole.Mixed,
  consent: { required: true, acknowledgedAt: null, acknowledgedBy: null, requiredVersion: '2026-10-01', version: null },
  cloud: {
    region: 'eu',
    entitled: true,
    balanceUsd: 12,
    heldUsd: 2,
    dailyCapUsd: null,
    spentTodayUsd: 0,
    refusal: null,
    refusalDetail: null,
  },
  costControls: {
    budgetLimitUsd: 25,
    maxRuntimeMinutes: 120,
    maxUploadBytes: 500_000_000,
    spentUsd: 3.5,
    budgetWindowDays: 30,
  },
  health: { status: MlDestinationHealth.Unknown, probedAt: null, summary: null, servedWorkloads: null },
});

const cloudStatus = {
  connection: CloudMlConnection.Ready,
  detail: null,
  enabled: true,
  region: 'eu',
  entitled: true,
  destination: cloud,
  consent: {
    requiredVersion: '2026-10-01',
    recordedVersion: null,
    acceptedVersion: null,
    features: { identityNames: false, medicalSignals: false, ocrAddon: false },
    summary: 'Media is processed in the EU region and deleted after each job.',
    documentUrl: null,
    outdated: false,
  },
  wallet: null,
  checkedAt: '2026-09-25T00:00:00.000Z',
};

const routes: MlWorkloadRouteDto[] = Object.values(MlWorkload).map((workload) => ({
  workload,
  destinationId: [MlWorkload.Face, MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Enrichment].includes(workload)
    ? destination().id
    : null,
  modelId: null,
}));

describe('MlDestinationsPanel (FL-110)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.listMlDestinations.mockResolvedValue([destination(), cloud]);
    sdkMock.getMlWorkloadRoutes.mockResolvedValue({ routes });
  });

  it('shows every destination with its health and marks an unconsented cloud destination as blocked', () => {
    render(MlDestinationsPanel, { destinations: [destination(), cloud], routes });

    const local = screen.getByRole('listitem', { name: 'This server' });
    expect(within(local).getByText('Healthy')).toBeInTheDocument();
    expect(within(local).getByText('http://immich-machine-learning:3003')).toBeInTheDocument();

    const row = screen.getByRole('listitem', { name: 'Frameleaf Cloud' });
    expect(within(row).getByText('Consent needed')).toBeInTheDocument();
    // FL-159: no URL or token, the region, the wallet instead of an hourly rate, and the budget kept.
    expect(within(row).getByText(/Data region eu · no address or token/)).toBeInTheDocument();
    expect(within(row).getByText('$10.00 available · $2.00 held')).toBeInTheDocument();
    expect(within(row).getByText('$3.50 of $25.00 in the last 30 days')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Record consent' })).not.toBeInTheDocument();
  });

  it('never offers an unconsented cloud destination in a route picker, even for work it allows', () => {
    render(MlDestinationsPanel, { destinations: [destination(), cloud], routes });

    const faceRoute = screen.getByLabelText('Face recognition') as HTMLSelectElement;
    const offered = [...faceRoute.options].map((option) => option.value);
    expect(offered).toContain(destination().id);
    expect(offered).not.toContain(cloud.id);

    const restoration = screen.getByLabelText('Restoration (faithful)') as HTMLSelectElement;
    expect([...restoration.options].map((option) => option.value)).toEqual(['']);
    expect(screen.getAllByText('Not routed: jobs are refused').length).toBeGreaterThan(0);
  });

  it('records the version Frameleaf Cloud requires, only after the acknowledgement is ticked (FL-159)', async () => {
    sdkMock.getCloudMlStatus.mockResolvedValue(cloudStatus);
    sdkMock.grantMlDestinationConsent.mockResolvedValue(cloud);
    render(MlDestinationsPanel, { destinations: [destination(), cloud], routes });

    const row = screen.getByRole('listitem', { name: 'Frameleaf Cloud' });
    await fireEvent.click(within(row).getByRole('button', { name: 'Review consent' }));
    // Every Dialog is labelled by its title, so the open one is addressed by name rather than
    // by relying on closed dialogs being hidden from the accessibility tree.
    const dialog = await screen.findByRole('dialog', { name: 'Cloud processing terms · version 2026-10-01' });
    expect(within(dialog).getByText(cloudStatus.consent.summary)).toBeInTheDocument();
    const action = within(dialog).getByRole('button', { name: 'Accept and turn on' });
    expect(action).toBeDisabled();
    expect(sdkMock.grantMlDestinationConsent).not.toHaveBeenCalled();

    await fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(action).toBeEnabled();
    await fireEvent.click(action);

    await waitFor(() =>
      expect(sdkMock.grantMlDestinationConsent).toHaveBeenCalledWith({
        id: cloud.id,
        mlDestinationConsentRequestDto: {
          acknowledgeMediaLeavesNetwork: true,
          version: '2026-10-01',
          // Names and medical signals never reach a cloud prompt unless chosen.
          features: { identityNames: false, medicalSignals: false, ocrAddon: false },
        },
      }),
    );
    await waitFor(() => expect(sdkMock.listMlDestinations).toHaveBeenCalled());
  });

  it('routes a workload through the server and removes a route with an empty choice', async () => {
    sdkMock.setMlWorkloadRoute.mockResolvedValue({ routes });
    render(MlDestinationsPanel, { destinations: [destination(), cloud], routes });

    const faceRoute = screen.getByLabelText('Face recognition') as HTMLSelectElement;
    await fireEvent.change(faceRoute, { target: { value: '' } });

    await waitFor(() =>
      expect(sdkMock.setMlWorkloadRoute).toHaveBeenCalledWith({
        workload: MlWorkload.Face,
        mlWorkloadRouteUpdateDto: { destinationId: null },
      }),
    );
  });

  it('probes exactly the chosen destination', async () => {
    sdkMock.probeMlDestination.mockResolvedValue(cloud.health);
    render(MlDestinationsPanel, { destinations: [destination(), cloud], routes });

    const row = screen.getByRole('listitem', { name: 'Frameleaf Cloud' });
    await fireEvent.click(within(row).getByRole('button', { name: 'Check now' }));

    await waitFor(() => expect(sdkMock.probeMlDestination).toHaveBeenCalledWith({ id: cloud.id }));
    expect(sdkMock.probeMlDestination).toHaveBeenCalledTimes(1);
  });

  it('adds Frameleaf Cloud only from its own section, and edits it without a URL or token (FL-159)', async () => {
    render(MlDestinationsPanel, { destinations: [destination()], routes });
    expect(screen.getByRole('link', { name: 'Add Frameleaf Cloud' })).toHaveAttribute(
      'href',
      expect.stringContaining('section=cloud-processing'),
    );
  });

  it('saves Frameleaf Cloud without sending a URL or token', async () => {
    sdkMock.updateMlDestination.mockResolvedValue(cloud);
    render(MlDestinationsPanel, { destinations: [destination(), cloud], routes });

    expect(screen.queryByRole('link', { name: 'Add Frameleaf Cloud' })).not.toBeInTheDocument();
    const row = screen.getByRole('listitem', { name: 'Frameleaf Cloud' });
    await fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit destination' });
    expect(within(dialog).queryByLabelText('URL')).not.toBeInTheDocument();
    // Faces are never offered; restoration and descriptions may share Frameleaf Cloud.
    expect(within(dialog).queryByLabelText('Face recognition')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Restoration (creative)')).toBeEnabled();
    // jsdom miscounts the 0.01 step of a whole-dollar budget, so the form is submitted directly.
    await fireEvent.submit(dialog.querySelector('form')!);

    await waitFor(() => expect(sdkMock.updateMlDestination).toHaveBeenCalled());
    const [{ mlDestinationUpdateDto }] = sdkMock.updateMlDestination.mock.calls[0];
    expect(mlDestinationUpdateDto).not.toHaveProperty('url');
    expect(mlDestinationUpdateDto).not.toHaveProperty('authToken');
    expect(mlDestinationUpdateDto.workloads).toEqual([MlWorkload.Enrichment, MlWorkload.RestorationFaithful]);
  });

  it('closes restoration in the form once library work is ticked (FL-72)', async () => {
    render(MlDestinationsPanel, { destinations: [destination(), cloud], routes });

    await fireEvent.click(screen.getByRole('button', { name: 'Add home-network worker' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add destination' });
    await fireEvent.click(within(dialog).getByLabelText('Face recognition'));

    expect(within(dialog).getByLabelText('Restoration (faithful)')).toBeDisabled();
    expect(within(dialog).getByLabelText('Search and similarity')).toBeEnabled();
  });
});
