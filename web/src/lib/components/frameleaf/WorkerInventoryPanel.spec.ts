import {
  MlAdmissionRefusal,
  MlDestinationKind,
  MlWorkerAcceleration,
  MlWorkerReadiness,
  MlWorkerRole,
  MlWorkload,
  QueueName,
  WorkerCredentialState,
  WorkerInventorySource,
  type AdminConfigDto,
  type WorkerInventoryEntryDto,
  type WorkerInventoryResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import WorkerInventoryPanel from './WorkerInventoryPanel.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const entry = (overrides: Partial<WorkerInventoryEntryDto> = {}): WorkerInventoryEntryDto => ({
  id: '11111111-1111-4111-8111-111111111111',
  source: WorkerInventorySource.MlDestination,
  name: 'This server',
  kind: MlDestinationKind.Local,
  role: MlWorkerRole.LibraryAnalysis,
  url: 'http://immich-machine-learning:3003',
  configured: true,
  enabled: true,
  readiness: MlWorkerReadiness.Cpu,
  acceleration: MlWorkerAcceleration.Cpu,
  gpus: [],
  gpuMemoryBytes: null,
  credential: WorkerCredentialState.None,
  leavesNetwork: false,
  consentGranted: true,
  allowedWorkloads: [MlWorkload.Face, MlWorkload.Clip],
  servedWorkloads: [MlWorkload.Face, MlWorkload.Clip],
  routedWorkloads: [MlWorkload.Face],
  admission: [
    { workload: MlWorkload.Face, admitted: true, refusal: null, detail: null },
    { workload: MlWorkload.Clip, admitted: true, refusal: null, detail: null },
  ],
  renderKinds: [],
  sharesLibraryHardware: false,
  waitingForLibraryAnalysis: false,
  activeOperations: 1,
  queuedOperations: 12,
  maxConcurrentOperations: null,
  checkedAt: new Date().toISOString(),
  latencyMs: 12,
  summary: null,
  ...overrides,
});

const cloud = entry({
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Frameleaf Cloud',
  kind: MlDestinationKind.FrameleafCloud,
  url: null,
  readiness: MlWorkerReadiness.Unreachable,
  acceleration: MlWorkerAcceleration.Unknown,
  credential: WorkerCredentialState.None,
  leavesNetwork: true,
  allowedWorkloads: [MlWorkload.Enrichment],
  servedWorkloads: null,
  routedWorkloads: [MlWorkload.Enrichment],
  admission: [
    {
      workload: MlWorkload.Enrichment,
      admitted: false,
      refusal: MlAdmissionRefusal.EndpointUnresolved,
      detail: 'Frameleaf Cloud is not linked to this server',
    },
  ],
});

const restoration = entry({
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Workshop GPU',
  kind: MlDestinationKind.Lan,
  role: MlWorkerRole.Restoration,
  url: 'https://workshop.lan:3004',
  readiness: MlWorkerReadiness.ModelReady,
  acceleration: MlWorkerAcceleration.Gpu,
  gpus: [{ name: 'RTX 4070 Ti SUPER', memoryTotalBytes: 17_179_869_184 }],
  gpuMemoryBytes: 17_179_869_184,
  credential: WorkerCredentialState.Stored,
  allowedWorkloads: [MlWorkload.RestorationFaithful],
  servedWorkloads: [MlWorkload.RestorationFaithful],
  routedWorkloads: [],
  admission: [{ workload: MlWorkload.RestorationFaithful, admitted: true, refusal: null, detail: null }],
  sharesLibraryHardware: true,
  waitingForLibraryAnalysis: true,
  activeOperations: 0,
  queuedOperations: 2,
});

const inventory = (overrides: Partial<WorkerInventoryResponseDto> = {}): WorkerInventoryResponseDto => ({
  entries: [entry(), cloud, restoration],
  runners: [],
  libraryRoutes: [
    { workload: MlWorkload.Face, destinationId: entry().id, queues: [QueueName.FaceDetection] },
    { workload: MlWorkload.Clip, destinationId: null, queues: [QueueName.SmartSearch] },
    { workload: MlWorkload.Ocr, destinationId: null, queues: [QueueName.Ocr] },
    { workload: MlWorkload.Enrichment, destinationId: cloud.id, queues: [QueueName.ImageDescription] },
  ],
  libraryQueues: [
    { queue: QueueName.FaceDetection, active: 1, waiting: 12, paused: false },
    { queue: QueueName.SmartSearch, active: 0, waiting: 0, paused: false },
  ],
  libraryBacklog: 13,
  machineLearningEnabled: true,
  configuredUrls: ['http://immich-machine-learning:3003'],
  checkedAt: new Date().toISOString(),
  ...overrides,
});

const config = {
  machineLearning: { enabled: true, urls: ['http://immich-machine-learning:3003'] },
} as unknown as AdminConfigDto;

describe('WorkerInventoryPanel (FL-72)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getWorkerInventory.mockResolvedValue(inventory());
    sdkMock.getConfig.mockResolvedValue(config);
    sdkMock.updateConfig.mockResolvedValue(config);
  });

  it('shows each configured endpoint with its real state, and restoration workers apart from it', () => {
    render(WorkerInventoryPanel, { inventory: inventory(), destinations: [] });

    const first = screen.getByRole('article', { name: 'ML endpoint 1' });
    expect(within(first).getAllByText('CPU only').length).toBeGreaterThan(0);
    expect(within(first).getByText('No credentials in the URL')).toBeInTheDocument();

    const video = screen.getByRole('article', { name: 'Workshop GPU' });
    expect(within(video).getByText('Model ready')).toBeInTheDocument();
    expect(within(video).getByText(/16 GiB/)).toBeInTheDocument();
    expect(within(video).getByText(/waiting for library analysis/)).toBeInTheDocument();
  });

  it('shows routing to Frameleaf Cloud as Frameleaf Cloud, never as local', () => {
    render(WorkerInventoryPanel, { inventory: inventory(), destinations: [] });

    const routes = screen.getByRole('region', { name: 'Library analysis routes' });
    expect(within(routes).getByText('Frameleaf Cloud · Frameleaf Cloud')).toBeInTheDocument();
    expect(within(routes).getAllByText('Not routed: jobs are refused').length).toBe(2);
  });

  it('checks exactly the endpoint asked for', async () => {
    sdkMock.probeMlDestination.mockResolvedValue({} as never);
    render(WorkerInventoryPanel, { inventory: inventory(), destinations: [] });

    const video = screen.getByRole('article', { name: 'Workshop GPU' });
    await fireEvent.click(within(video).getByRole('button', { name: 'Check capabilities' }));

    await waitFor(() => expect(sdkMock.probeMlDestination).toHaveBeenCalledWith({ id: restoration.id }));
    expect(sdkMock.probeMlDestination).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(sdkMock.getWorkerInventory).toHaveBeenCalled());
  });

  it('adds an endpoint to the list the server holds now', async () => {
    render(WorkerInventoryPanel, { inventory: inventory(), destinations: [] });

    await fireEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add ML endpoint' });
    await fireEvent.input(within(dialog).getByLabelText('Endpoint URL'), {
      target: { value: 'http://study:3003/' },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sdkMock.updateConfig).toHaveBeenCalledWith({
        adminConfigDto: expect.objectContaining({
          machineLearning: expect.objectContaining({
            urls: ['http://immich-machine-learning:3003', 'http://study:3003'],
          }),
        }),
      }),
    );
  });

  it('refuses a duplicate with the prototype message and saves nothing', async () => {
    render(WorkerInventoryPanel, { inventory: inventory(), destinations: [] });

    await fireEvent.click(screen.getByRole('button', { name: 'Add endpoint' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add ML endpoint' });
    await fireEvent.input(within(dialog).getByLabelText('Endpoint URL'), {
      target: { value: 'http://immich-machine-learning:3003' },
    });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await within(dialog).findByText('This endpoint is already listed.')).toBeInTheDocument();
    expect(sdkMock.updateConfig).not.toHaveBeenCalled();
  });

  it('keeps the only endpoint and disables changes while machine learning is off', () => {
    render(WorkerInventoryPanel, { inventory: inventory({ machineLearningEnabled: false }), destinations: [] });

    expect(screen.getByRole('button', { name: 'Add endpoint' })).toBeDisabled();
    const first = screen.getByRole('article', { name: 'ML endpoint 1' });
    expect(within(first).getByRole('button', { name: 'Remove' })).toBeDisabled();
    expect(screen.getByText(/Machine learning is disabled/)).toBeInTheDocument();
  });

  it('keeps the last snapshot and says it is old when a refresh fails', async () => {
    sdkMock.getWorkerInventory.mockRejectedValue(new Error('offline'));
    render(WorkerInventoryPanel, { inventory: inventory(), destinations: [] });

    await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText(/The latest refresh failed/)).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'ML endpoint 1' })).toBeInTheDocument();
  });
});
