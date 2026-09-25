import { faker } from '@faker-js/faker';
import { AssetVisibility, type AssetResponseDto } from '@immich/sdk';
import { BrowserContext, expect, Request, test } from '@playwright/test';
import { toAssetResponseDto, type TimelineAssetConfig } from 'src/ui/generators/timeline.js';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * "Try an enrichment change" (FL-59, `REC-101`) against a mocked server: samples → Compare (a
 * preview that writes nothing) → Scope with dependency stages and unticked moment captions → a
 * durable plan followed item by item, which a reload returns to, with cancel and retry. No request
 * ever asks for speech transcription.
 */
const workbench =
  '/user-settings?area=intelligence&section=machine-learning&isOpen=machine-learning&openSetting=workbench';

const makeAsset = (ownerId: string, isVideo: boolean, name: string): AssetResponseDto => {
  const config: TimelineAssetConfig = {
    id: faker.string.uuid(),
    ownerId,
    ratio: 1.5,
    thumbhash: null,
    localDateTime: '2026-09-01T10:00:00.000Z',
    fileCreatedAt: '2026-09-01T10:00:00.000Z',
    isFavorite: false,
    isTrashed: false,
    isVideo,
    isImage: !isVideo,
    duration: isVideo ? 12 : null,
    projectionType: null,
    livePhotoVideoId: null,
    city: null,
    country: null,
    people: null,
    latitude: null,
    longitude: null,
    visibility: AssetVisibility.Timeline,
    stack: null,
    fileSizeInByte: 1000,
    checksum: faker.string.alphanumeric({ length: 5 }),
  };
  return { ...toAssetResponseDto(config), originalFileName: name };
};

const destination = {
  id: 'd0000000-0000-4000-8000-000000000001',
  name: 'Studio GPU',
  kind: 'lan',
  cloud: false,
  health: 'healthy',
  enrichment: { admitted: true, refusal: null },
  search: { admitted: true, refusal: null },
};

const operation = (id: string, status: string, retryOfId: string | null = null) => ({
  id,
  kind: 'enrichment_plan',
  status,
  label: 'Enrichment plan',
  assetId: null,
  attempt: 1,
  autoRetries: 0,
  bulk: null,
  cancelAcknowledgedAt: null,
  cancelRequestedAt: null,
  createdAt: '2026-09-25T09:00:00.000Z',
  destination: 'lan',
  destinationDetail: null,
  error: null,
  errorCode: null,
  estimate: null,
  finishedAt: null,
  maxAttempts: 2,
  pausable: true,
  pauseRequestedAt: null,
  processedUnits: '0',
  progress: 0,
  projectId: null,
  resultAssetId: null,
  retryAt: null,
  retryOfId,
  revisionId: null,
  settings: {},
  startedAt: null,
  totalUnits: '2',
  updatedAt: '2026-09-25T09:00:00.000Z',
  withheld: false,
});

const setupWorkbenchMocks = async (context: BrowserContext, ownerId: string) => {
  const photo = makeAsset(ownerId, false, 'harbour.jpg');
  const video = makeAsset(ownerId, true, 'birthday.mp4');
  const requests = {
    all: [] as Array<{ method: string; path: string }>,
    previews: [] as unknown[],
    plans: [] as Array<{ assetIds: string[]; stages: string[] }>,
    cancels: [] as string[],
    retries: [] as string[],
  };
  const plans = new Map<string, Record<string, unknown>>();

  const planFor = (id: string, status: string, stages: string[], states: [string, string], retryOfId?: string) => ({
    operation: operation(id, status, retryOfId),
    stages,
    requestedStages: stages,
    addedStages: [],
    configHash: 'config',
    modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
    searchModelName: 'ViT-B-32__openai',
    enrichmentDestination: { id: destination.id, name: destination.name, cloud: false },
    searchDestination: { id: destination.id, name: destination.name, cloud: false },
    hiddenCount: 0,
    counts: {
      total: 2,
      queued: states.filter((state) => state === 'queued').length,
      running: states.filter((state) => state === 'running').length,
      completed: states.filter((state) => state === 'completed').length,
      failed: states.filter((state) => state === 'failed').length,
      skipped: states.filter((state) => state === 'skipped').length,
      cancelled: states.filter((state) => state === 'cancelled').length,
    },
    items: [photo, video].map((asset, index) => ({
      assetId: asset.id,
      state: states[index],
      retryPending: false,
      stages: stages.map((stage) => ({ stage, state: states[index], at: null, message: null, reasonKey: null })),
    })),
  });

  const track = (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      requests.all.push({ method: request.method(), path: url.pathname });
    }
  };
  context.on('request', track);

  await context.route('**/api/assets/*/thumbnail*', (route) =>
    route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.alloc(0) }),
  );
  await context.route('**/api/search/metadata', async (route, request) => {
    const { type } = request.postDataJSON() as { type?: string };
    const items = type === 'VIDEO' ? [video] : [photo];
    return route.fulfill({
      json: {
        assets: { items, total: items.length, count: items.length, nextPage: null, facets: [] },
        albums: { items: [], total: 0, count: 0, facets: [] },
      },
    });
  });
  await context.route('**/api/enrichment/options', (route) =>
    route.fulfill({
      json: {
        defaultStages: ['description', 'locked-check', 'frames', 'moment-index'],
        descriptionEnabled: true,
        lockedCheckEnabled: true,
        searchEnabled: true,
        destinations: [destination],
        routes: { enrichment: destination.id, search: destination.id },
        framesPerVideo: 6,
        maxAssets: 500,
        maxSamples: 6,
        modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
        searchModelName: 'ViT-B-32__openai',
      },
    }),
  );
  await context.route('**/api/enrichment/preview', async (route, request) => {
    const body = request.postDataJSON() as { assetIds: string[] };
    requests.previews.push(body);
    return route.fulfill({
      json: {
        cloud: false,
        destinationId: destination.id,
        destinationName: destination.name,
        modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
        samples: body.assetIds.map((assetId) => ({
          assetId,
          status: 'success',
          current: 'A quiet harbour at dawn.',
          candidate: 'Fishing boats moored in a calm harbour at sunrise.',
          tags: ['harbour', 'boats'],
          frameCount: assetId === video.id ? 6 : 0,
          hallucinatedNames: [],
          ambiguousReferences: [],
          warnings: [],
          message: null,
          reasonKey: null,
          durationMs: 1200,
        })),
      },
    });
  });
  await context.route('**/api/enrichment/plans', async (route, request) => {
    const body = request.postDataJSON() as { assetIds: string[]; stages: string[] };
    requests.plans.push({ assetIds: body.assetIds, stages: body.stages });
    const plan = planFor('p0000000-0000-4000-8000-000000000001', 'rendering', body.stages, ['completed', 'running']);
    plans.set(plan.operation.id, plan);
    return route.fulfill({ status: 201, json: plan });
  });
  await context.route('**/api/enrichment/plans/*', (route, request) => {
    const id = new URL(request.url()).pathname.split('/').at(-1)!;
    const plan = plans.get(id);
    return plan ? route.fulfill({ json: plan }) : route.fulfill({ status: 404, json: {} });
  });
  await context.route('**/api/media-operations?*', (route) =>
    route.fulfill({ json: { items: Array.from(plans.values(), (plan) => plan.operation), nextCursor: null } }),
  );
  await context.route('**/api/media-operations/*/cancel', (route, request) => {
    const id = new URL(request.url()).pathname.split('/').at(-2)!;
    requests.cancels.push(id);
    const plan = plans.get(id) as { stages: string[] } | undefined;
    if (plan) {
      plans.set(id, planFor(id, 'cancelled', plan.stages, ['completed', 'cancelled']));
    }
    return route.fulfill({ json: plans.get(id)?.operation ?? {} });
  });
  await context.route('**/api/media-operations/*/retry', (route, request) => {
    const id = new URL(request.url()).pathname.split('/').at(-2)!;
    requests.retries.push(id);
    const previous = plans.get(id) as { stages: string[] };
    const retried = planFor(
      'p0000000-0000-4000-8000-000000000002',
      'queued',
      previous.stages,
      ['completed', 'queued'],
      id,
    );
    plans.set(retried.operation.id, retried);
    return route.fulfill({ status: 201, json: retried.operation });
  });

  return { requests, photo, video };
};

test.describe('Try an enrichment change', () => {
  let mocks: Awaited<ReturnType<typeof setupWorkbenchMocks>>;

  test.beforeEach(async ({ context }) => {
    const ownerId = faker.string.uuid();
    await setupBaseMockApiRoutes(context, ownerId);
    mocks = await setupWorkbenchMocks(context, ownerId);
  });

  test('previews without writing, queues the chosen stages, follows the plan across a reload, cancels and retries', async ({
    page,
  }) => {
    await page.goto(workbench);
    let dialog = page.getByRole('dialog', { name: 'Try an enrichment change' });
    await expect(dialog).toBeVisible();

    // Choose sample: one photo and one video.
    await dialog.getByRole('button', { name: 'harbour.jpg' }).click();
    await dialog.getByRole('button', { name: 'Videos', exact: true }).click();
    await dialog.getByRole('button', { name: 'birthday.mp4' }).click();
    const beforePreview = mocks.requests.all.length;
    await dialog.getByRole('button', { name: 'Preview', exact: true }).click();

    // Compare: the draft ran on both samples and nothing was written.
    await expect(dialog.getByText('Nothing was saved. Existing descriptions are unchanged.')).toBeVisible();
    await expect(dialog.getByText('Fishing boats moored in a calm harbour at sunrise.').first()).toBeVisible();
    const duringPreview = mocks.requests.all.slice(beforePreview);
    expect(duringPreview.filter(({ method }) => method !== 'GET')).toEqual([
      { method: 'POST', path: '/api/enrichment/preview' },
    ]);
    expect(mocks.requests.previews).toEqual([expect.objectContaining({ assetIds: [mocks.photo.id, mocks.video.id] })]);

    // Scope: the saved defaults are ticked, moment captions are not, and say what they add.
    await dialog.getByRole('button', { name: 'Continue' }).click();
    const stage = (name: string) => dialog.getByRole('checkbox', { name: new RegExp(`^${name}`) });
    await expect(stage('Descriptions and tags')).toBeChecked();
    await expect(stage('Reusable video frames')).toBeChecked();
    await expect(stage('Moment search index')).toBeChecked();
    await expect(stage('Moment captions')).not.toBeChecked();
    await expect(dialog.getByText(/Adds one model request per frame: about 6 requests/)).toBeVisible();
    await expect(dialog.getByText(/Speech transcription is not available/)).toBeVisible();
    // The moment index needs the frames: the frames stage cannot be dropped while the index is ticked.
    await expect(stage('Reusable video frames')).toBeDisabled();
    await stage('Moment search index').uncheck();
    await expect(stage('Reusable video frames')).toBeEnabled();
    await stage('Moment search index').check();

    await dialog.getByRole('button', { name: 'Queue plan' }).click();
    await expect
      .poll(() => mocks.requests.plans.at(-1)?.stages)
      .toEqual(expect.arrayContaining(['description', 'locked-check', 'frames', 'moment-index']));
    expect(mocks.requests.plans.at(-1)?.stages).not.toContain('moment-captions');

    // The plan is followed item by item.
    await expect(dialog.getByText('Completed', { exact: true }).first()).toBeVisible();
    await expect(dialog.getByText('Running', { exact: true }).first()).toBeVisible();

    // A reload returns to the plan.
    await page.reload();
    dialog = page.getByRole('dialog', { name: 'Try an enrichment change' });
    await expect(dialog.getByText('Running', { exact: true }).first()).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => mocks.requests.cancels).toEqual(['p0000000-0000-4000-8000-000000000001']);
    await expect(dialog.getByText('Cancelled', { exact: true }).first()).toBeVisible();

    await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => mocks.requests.retries).toEqual(['p0000000-0000-4000-8000-000000000001']);
    await expect(dialog.getByText('Queued', { exact: true }).first()).toBeVisible();

    // No automatic speech recognition anywhere in the flow.
    expect(mocks.requests.all.filter(({ path }) => /transcri|asr|speech/i.test(path))).toEqual([]);
  });
});
