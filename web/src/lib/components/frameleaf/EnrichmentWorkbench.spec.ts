import {
  AssetTypeEnum,
  EnrichmentItemState,
  EnrichmentPreviewStatus,
  EnrichmentStage,
  MediaOperationKind,
  MediaOperationStatus,
  type AdminConfigImageDescriptionDto,
  type EnrichmentDestinationOptionDto,
  type EnrichmentPlanItemDto,
  type EnrichmentPlanResponseDto,
  type MediaOperationDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { lastPlan } from '$lib/frameleaf/enrichment';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../i18n/en.json';
import EnrichmentWorkbench from './EnrichmentWorkbench.svelte';

const PLAN_ID = '00000000-0000-4000-8000-0000000000a1';
const RETRY_ID = '00000000-0000-4000-8000-0000000000a2';
const ASSET_ID = '00000000-0000-4000-8000-0000000000b1';

const settings = {
  enabled: true,
  device: 'cpu',
  modelName: 'describe-v2',
  fallbackModelName: 'describe-v1',
  prompt: 'Describe this photo.',
} as unknown as AdminConfigImageDescriptionDto;

const destination = {
  id: 'dest-local',
  name: 'Local ML',
  cloud: false,
  enrichment: { admitted: true },
  search: { admitted: true },
} as unknown as EnrichmentDestinationOptionDto;

const asset = { id: ASSET_ID, type: AssetTypeEnum.Image, originalFileName: 'lake.jpg', thumbhash: null };

const operation = (overrides: Partial<MediaOperationDto> = {}): MediaOperationDto =>
  ({
    id: PLAN_ID,
    kind: MediaOperationKind.EnrichmentPlan,
    label: 'Enrichment plan',
    status: MediaOperationStatus.Rendering,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    pausable: true,
    pauseRequestedAt: null,
    autoRetries: 0,
    ...overrides,
  }) as MediaOperationDto;

const item = (state: EnrichmentItemState): EnrichmentPlanItemDto => ({
  assetId: ASSET_ID,
  retryPending: false,
  state,
  stages: [{ stage: EnrichmentStage.Description, state, at: null, message: null, reasonKey: null }],
});

const counts = (overrides: Partial<EnrichmentPlanResponseDto['counts']> = {}) => ({
  total: 1,
  queued: 0,
  running: 0,
  completed: 0,
  skipped: 0,
  failed: 0,
  cancelled: 0,
  ...overrides,
});

const plan = (
  status: MediaOperationStatus,
  state: EnrichmentItemState,
  overrides: Partial<EnrichmentPlanResponseDto> = {},
): EnrichmentPlanResponseDto => ({
  addedStages: [],
  configHash: 'hash',
  counts: counts({ [state]: 1 }),
  enrichmentDestination: { id: destination.id, name: destination.name } as never,
  hiddenCount: 0,
  items: [item(state)],
  modelName: 'describe-v1',
  operation: operation({ status }),
  requestedStages: [EnrichmentStage.Description],
  searchDestination: null,
  searchModelName: 'clip',
  stages: [EnrichmentStage.Description],
  ...overrides,
});

const stageRow = (state: string) => screen.findByText(`Descriptions and tags: ${state}`);

const renderWorkbench = () => render(EnrichmentWorkbench, { open: true, draft: settings, saved: settings });

/** Choose the sample, preview it, and queue a plan from the Scope step. */
const queueThroughWizard = async () => {
  sdkMock.previewEnrichment.mockResolvedValue({
    cloud: false,
    destinationId: destination.id,
    destinationName: destination.name,
    modelName: 'describe-v2',
    samples: [],
  } as never);
  await fireEvent.click(await screen.findByRole('button', { name: 'lake.jpg' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'Queue plan' }));
};

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => {
  addMessages('dev', en);
  vi.resetAllMocks();
  localStorage.clear();
  authManager.setUser(userAdminFactory.build({ id: 'user-1', isAdmin: true }));
  sdkMock.getEnrichmentOptions.mockResolvedValue({
    defaultStages: [EnrichmentStage.Description],
    descriptionEnabled: true,
    destinations: [destination],
    framesPerVideo: 6,
    lockedCheckEnabled: false,
    maxAssets: 500,
    maxSamples: 6,
    modelName: 'describe-v1',
    routes: { enrichment: destination.id, search: destination.id },
    searchEnabled: false,
    searchModelName: 'clip',
  });
  sdkMock.searchMediaOperations.mockResolvedValue({ items: [] } as never);
  sdkMock.searchAssets.mockResolvedValue({ assets: { items: [asset] } } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EnrichmentWorkbench', () => {
  it('previews a draft without queuing a plan or writing anything', async () => {
    sdkMock.previewEnrichment.mockResolvedValue({
      cloud: false,
      destinationId: destination.id,
      destinationName: destination.name,
      modelName: 'describe-v2',
      samples: [
        {
          assetId: ASSET_ID,
          status: EnrichmentPreviewStatus.Success,
          current: 'A lake.',
          candidate: 'A still lake at dawn.',
          tags: [],
          frameCount: 0,
          hallucinatedNames: [],
          warnings: [],
          message: null,
          reasonKey: null,
        },
      ],
    } as never);
    renderWorkbench();

    await fireEvent.click(await screen.findByRole('button', { name: 'lake.jpg' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(await screen.findByText('A still lake at dawn.')).toBeInTheDocument();
    expect(screen.getByText('A lake.')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_enrichment_compare_done)).toBeInTheDocument();
    expect(sdkMock.previewEnrichment).toHaveBeenCalledWith({
      enrichmentPreviewRequestDto: {
        assetIds: [ASSET_ID],
        destinationId: destination.id,
        modelName: 'describe-v2',
        fallbackModelName: 'describe-v1',
        prompt: 'Describe this photo.',
      },
    });
    expect(sdkMock.createEnrichmentPlan).not.toHaveBeenCalled();
    expect(sdkMock.retryMediaOperation).not.toHaveBeenCalled();
    expect(lastPlan('user-1')).toBeNull();
  });

  it('queues a plan and ticks each stage forward as the plan is read again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sdkMock.createEnrichmentPlan.mockResolvedValue(plan(MediaOperationStatus.Queued, EnrichmentItemState.Queued));
    sdkMock.getEnrichmentPlan
      .mockResolvedValueOnce(plan(MediaOperationStatus.Rendering, EnrichmentItemState.Running))
      .mockResolvedValueOnce(plan(MediaOperationStatus.Completed, EnrichmentItemState.Completed));
    renderWorkbench();

    await queueThroughWizard();

    expect(await stageRow('Queued')).toBeInTheDocument();
    expect(sdkMock.createEnrichmentPlan).toHaveBeenCalledWith({
      enrichmentPlanCreateDto: expect.objectContaining({
        assetIds: [ASSET_ID],
        stages: [EnrichmentStage.Description],
      }),
    });
    expect(lastPlan('user-1')).toBe(PLAN_ID);

    await vi.advanceTimersByTimeAsync(5000);
    expect(await stageRow('Running')).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(2000);
    expect(await stageRow('Completed')).toBeInTheDocument();
    expect(sdkMock.getEnrichmentPlan).toHaveBeenCalledTimes(2);
    expect(sdkMock.getEnrichmentPlan).toHaveBeenCalledWith({ id: PLAN_ID });

    // A finished plan is not read again.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sdkMock.getEnrichmentPlan).toHaveBeenCalledTimes(2);
  });

  it('picks the running plan back up after the page is reloaded', async () => {
    sdkMock.createEnrichmentPlan.mockResolvedValue(plan(MediaOperationStatus.Rendering, EnrichmentItemState.Running));
    sdkMock.getEnrichmentPlan.mockResolvedValue(plan(MediaOperationStatus.Rendering, EnrichmentItemState.Running));
    const first = renderWorkbench();
    await queueThroughWizard();
    await stageRow('Running');
    first.unmount();
    expect(sdkMock.getEnrichmentPlan).not.toHaveBeenCalled();

    renderWorkbench();

    expect(await stageRow('Running')).toBeInTheDocument();
    expect(sdkMock.getEnrichmentPlan).toHaveBeenCalledWith({ id: PLAN_ID });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(sdkMock.createEnrichmentPlan).toHaveBeenCalledTimes(1);
  });

  it('forgets a remembered plan the server no longer has and starts fresh', async () => {
    localStorage.setItem(`frameleaf.enrichment.lastPlan.user-1`, PLAN_ID);
    sdkMock.getEnrichmentPlan.mockRejectedValue(new Error('gone'));
    renderWorkbench();

    expect(await screen.findByRole('button', { name: 'lake.jpg' })).toBeInTheDocument();
    await waitFor(() => expect(lastPlan('user-1')).toBeNull());
  });

  it('cancels a running plan and shows it cancelled', async () => {
    localStorage.setItem(`frameleaf.enrichment.lastPlan.user-1`, PLAN_ID);
    sdkMock.getEnrichmentPlan
      .mockResolvedValueOnce(plan(MediaOperationStatus.Rendering, EnrichmentItemState.Running))
      .mockResolvedValueOnce(plan(MediaOperationStatus.Cancelled, EnrichmentItemState.Cancelled));
    sdkMock.cancelMediaOperation.mockResolvedValue(operation({ status: MediaOperationStatus.Cancelling }));
    renderWorkbench();

    await stageRow('Running');
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await stageRow('Cancelled')).toBeInTheDocument();
    expect(sdkMock.cancelMediaOperation).toHaveBeenCalledWith({ id: PLAN_ID });
    const status = screen.getByText('Cancelled', { selector: 'strong' });
    expect(status).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('retries a failed plan and follows the new queued run', async () => {
    localStorage.setItem(`frameleaf.enrichment.lastPlan.user-1`, PLAN_ID);
    sdkMock.getEnrichmentPlan.mockImplementation(({ id }) =>
      Promise.resolve(
        id === RETRY_ID
          ? plan(MediaOperationStatus.Queued, EnrichmentItemState.Queued, {
              operation: operation({ id: RETRY_ID, status: MediaOperationStatus.Queued }),
            })
          : plan(MediaOperationStatus.Failed, EnrichmentItemState.Failed),
      ),
    );
    sdkMock.retryMediaOperation.mockResolvedValue(operation({ id: RETRY_ID, status: MediaOperationStatus.Queued }));
    renderWorkbench();

    await stageRow('Failed');
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await stageRow('Queued')).toBeInTheDocument();
    expect(sdkMock.retryMediaOperation).toHaveBeenCalledWith({ id: PLAN_ID });
    expect(sdkMock.getEnrichmentPlan).toHaveBeenLastCalledWith({ id: RETRY_ID });
    const section = screen.getByText('Queued', { selector: 'strong' }).closest('section') as HTMLElement;
    expect(within(section).queryByText('Descriptions and tags: Failed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(lastPlan('user-1')).toBe(RETRY_ID);
  });
});
