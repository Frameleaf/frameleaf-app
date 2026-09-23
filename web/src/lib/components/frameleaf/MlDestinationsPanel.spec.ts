import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import {
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkload,
  type MlDestinationResponseDto,
  type MlWorkloadRouteDto,
} from '@immich/sdk';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  consent: { required: false, acknowledgedAt: null, acknowledgedBy: null },
  costControls: { budgetLimitUsd: null, maxRuntimeMinutes: null, maxUploadBytes: null, spentUsd: 0, budgetWindowDays: 30 },
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

const runPod = destination({
  id: '22222222-2222-4222-8222-222222222222',
  kind: MlDestinationKind.RunPod,
  name: 'RunPod',
  url: null,
  workloads: [MlWorkload.Face, MlWorkload.RestorationFaithful],
  consent: { required: true, acknowledgedAt: null, acknowledgedBy: null },
  costControls: { budgetLimitUsd: 25, maxRuntimeMinutes: 120, maxUploadBytes: 500_000_000, spentUsd: 3.5, budgetWindowDays: 30 },
  health: { status: MlDestinationHealth.Unknown, probedAt: null, summary: null, servedWorkloads: null },
});

const routes: MlWorkloadRouteDto[] = Object.values(MlWorkload).map((workload) => ({
  workload,
  destinationId: [MlWorkload.Face, MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Enrichment].includes(workload)
    ? destination().id
    : null,
}));

describe('MlDestinationsPanel (FL-110)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.listMlDestinations.mockResolvedValue([destination(), runPod]);
    sdkMock.getMlWorkloadRoutes.mockResolvedValue({ routes });
  });

  it('shows every destination with its health and marks an unconsented cloud destination as blocked', () => {
    render(MlDestinationsPanel, { destinations: [destination(), runPod], routes });

    const local = screen.getByRole('listitem', { name: 'This server' });
    expect(within(local).getByText('Healthy')).toBeInTheDocument();
    expect(within(local).getByText('http://immich-machine-learning:3003')).toBeInTheDocument();

    const cloud = screen.getByRole('listitem', { name: 'RunPod' });
    expect(within(cloud).getByText('Consent needed')).toBeInTheDocument();
    expect(within(cloud).getByText('No running pod or ready serverless worker')).toBeInTheDocument();
    expect(within(cloud).getByText('$3.50 of $25.00 in the last 30 days')).toBeInTheDocument();
  });

  it('never offers an unconsented cloud destination in a route picker, even for work it allows', () => {
    render(MlDestinationsPanel, { destinations: [destination(), runPod], routes });

    const faceRoute = screen.getByLabelText('Face recognition') as HTMLSelectElement;
    const offered = [...faceRoute.options].map((option) => option.value);
    expect(offered).toContain(destination().id);
    expect(offered).not.toContain(runPod.id);

    const restoration = screen.getByLabelText('Restoration (faithful)') as HTMLSelectElement;
    expect([...restoration.options].map((option) => option.value)).toEqual(['']);
    expect(screen.getAllByText('Not routed: jobs are refused').length).toBeGreaterThan(0);
  });

  it('records consent only after the explicit acknowledgement is ticked', async () => {
    sdkMock.grantMlDestinationConsent.mockResolvedValue({
      ...runPod,
      consent: { required: true, acknowledgedAt: '2026-09-22T13:00:00.000Z', acknowledgedBy: 'admin' },
    });
    render(MlDestinationsPanel, { destinations: [destination(), runPod], routes });

    const cloud = screen.getByRole('listitem', { name: 'RunPod' });
    await fireEvent.click(within(cloud).getByRole('button', { name: 'Record consent' }));
    // Every Dialog is labelled by its title, so the open one is addressed by name rather than
    // by relying on closed dialogs being hidden from the accessibility tree.
    const dialog = await screen.findByRole('dialog', { name: 'Allow media to leave this network?' });
    const action = within(dialog).getByRole('button', { name: 'Record consent' });
    expect(action).toBeDisabled();
    expect(sdkMock.grantMlDestinationConsent).not.toHaveBeenCalled();

    await fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(action).toBeEnabled();
    await fireEvent.click(action);

    await waitFor(() =>
      expect(sdkMock.grantMlDestinationConsent).toHaveBeenCalledWith({
        id: runPod.id,
        mlDestinationConsentRequestDto: { acknowledgeMediaLeavesNetwork: true },
      }),
    );
    await waitFor(() => expect(sdkMock.listMlDestinations).toHaveBeenCalled());
  });

  it('routes a workload through the server and removes a route with an empty choice', async () => {
    sdkMock.setMlWorkloadRoute.mockResolvedValue({ routes });
    render(MlDestinationsPanel, { destinations: [destination(), runPod], routes });

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
    sdkMock.probeMlDestination.mockResolvedValue(runPod.health);
    render(MlDestinationsPanel, { destinations: [destination(), runPod], routes });

    const cloud = screen.getByRole('listitem', { name: 'RunPod' });
    await fireEvent.click(within(cloud).getByRole('button', { name: 'Check now' }));

    await waitFor(() => expect(sdkMock.probeMlDestination).toHaveBeenCalledWith({ id: runPod.id }));
    expect(sdkMock.probeMlDestination).toHaveBeenCalledTimes(1);
  });
});
