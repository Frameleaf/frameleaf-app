import {
  AssetRestorationMode,
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkerRole,
  MlWorkload,
  RestorationDynamicRange,
  RestorationModelState,
  type MlDestinationResponseDto,
  type RestorationModelCapabilityDto,
} from '@immich/sdk';
import { render, screen, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import RestorationModelsDialog from './RestorationModelsDialog.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const lan: MlDestinationResponseDto = {
  id: '33333333-3333-4333-8333-333333333333',
  kind: MlDestinationKind.Lan,
  name: 'Workshop GPU',
  url: 'https://workshop.lan:3004',
  authTokenConfigured: true,
  enabled: true,
  workloads: [MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative],
  role: MlWorkerRole.Restoration,
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
  health: { status: MlDestinationHealth.Healthy, probedAt: null, summary: null, servedWorkloads: [] },
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
};

const model = (overrides: Partial<RestorationModelCapabilityDto> = {}): RestorationModelCapabilityDto => ({
  id: 'realbasicvsr-x4',
  family: 'realbasicvsr',
  mode: AssetRestorationMode.Faithful,
  displayName: 'RealBasicVSR x4',
  revision: 'REPLACE-with-the-exact-40-character-commit-that-was-qualified',
  fingerprint: null,
  state: RestorationModelState.NotPinned,
  reasons: ["revision 'REPLACE' is not an exact 40-character commit", 'no NVIDIA GPU is visible to the worker'],
  nativeScale: 4,
  maxInputLongEdge: 1280,
  maxFrames: 300,
  dynamicRanges: [RestorationDynamicRange.Sdr],
  measured: [],
  qualificationId: null,
  ...overrides,
});

describe('RestorationModelsDialog (FL-114)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists each model with its state and every reason it is unavailable', async () => {
    sdkMock.getMlDestinationRestorationModels.mockResolvedValue({
      destinationId: lan.id,
      reachable: true,
      error: null,
      workloads: [],
      models: [model()],
      gpus: [],
      configurationProblems: [],
      checkedAt: '2026-09-22T12:00:00.000Z',
    });

    render(RestorationModelsDialog, { destination: lan, open: true });

    const item = await screen.findByRole('listitem', { name: 'RealBasicVSR x4' });
    expect(within(item).getByText('Not pinned')).toBeInTheDocument();
    expect(within(item).getByText('no NVIDIA GPU is visible to the worker')).toBeInTheDocument();
    expect(
      within(item).getByText('No throughput has been measured yet, so no time estimate can be shown.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Serves no restoration work/)).toBeInTheDocument();
    expect(sdkMock.getMlDestinationRestorationModels).toHaveBeenCalledWith({ id: lan.id });
  });

  it('shows measured throughput for a qualified model', async () => {
    const measurement = {
      gpu: 'GPU A',
      inputWidth: 640,
      inputHeight: 360,
      frames: 150,
      framesPerSecond: 4.2,
      peakVramBytes: 9 * 1024 ** 3,
    };
    const measured = [measurement];
    sdkMock.getMlDestinationRestorationModels.mockResolvedValue({
      destinationId: lan.id,
      reachable: true,
      error: null,
      workloads: [MlWorkload.RestorationFaithful],
      models: [model({ state: RestorationModelState.Available, reasons: [], fingerprint: 'a'.repeat(64), measured })],
      gpus: [],
      configurationProblems: [],
      checkedAt: null,
    });

    render(RestorationModelsDialog, { destination: lan, open: true });

    const item = await screen.findByRole('listitem', { name: 'RealBasicVSR x4' });
    expect(within(item).getByText('Available')).toBeInTheDocument();
    expect(
      within(item).getByText('640 × 360 on GPU A: 4.2 frames per second, peak 9 GiB of GPU memory'),
    ).toBeInTheDocument();
    expect(screen.getByText('Serves Restoration (faithful)')).toBeInTheDocument();
  });

  it("shows the worker's GPU memory and each model's input profile (FL-110)", async () => {
    sdkMock.getMlDestinationRestorationModels.mockResolvedValue({
      destinationId: lan.id,
      reachable: true,
      error: null,
      workloads: [],
      models: [model({ dynamicRanges: [RestorationDynamicRange.Sdr] })],
      gpus: [{ name: 'NVIDIA GeForce RTX 4090', memoryTotalBytes: 24 * 1024 ** 3, driverVersion: '550.54.14' }],
      configurationProblems: [],
      checkedAt: null,
    });

    render(RestorationModelsDialog, { destination: lan, open: true });

    expect(await screen.findByText('NVIDIA GeForce RTX 4090 · 24 GiB · driver 550.54.14')).toBeInTheDocument();
    const item = screen.getByRole('listitem', { name: 'RealBasicVSR x4' });
    expect(
      within(item).getByText('Inputs up to 1280 px on the long edge and 300 frames per run · SDR'),
    ).toBeInTheDocument();
  });

  it('says when the worker reports no GPU', async () => {
    sdkMock.getMlDestinationRestorationModels.mockResolvedValue({
      destinationId: lan.id,
      reachable: true,
      error: null,
      workloads: [],
      models: [],
      gpus: [],
      configurationProblems: [],
      checkedAt: null,
    });

    render(RestorationModelsDialog, { destination: lan, open: true });

    expect(await screen.findByText('This worker reports no GPU.')).toBeInTheDocument();
  });

  it('says so when the destination cannot be asked', async () => {
    sdkMock.getMlDestinationRestorationModels.mockResolvedValue({
      destinationId: lan.id,
      reachable: false,
      error: 'the destination does not run the restoration worker',
      workloads: [],
      models: [],
      gpus: [],
      configurationProblems: [],
      checkedAt: null,
    });

    render(RestorationModelsDialog, { destination: lan, open: true });

    expect(
      await screen.findByText(
        "Could not read this destination's restoration models: the destination does not run the restoration worker",
      ),
    ).toBeInTheDocument();
  });
});
