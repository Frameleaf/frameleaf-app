import { readFileSync } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueExecution } from 'src/queue/types.js';
import { defaults } from 'src/config.js';
import { AssetVisibility, JobName, JobStatus, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository, type MlSelection } from 'src/repositories/machine-learning.repository.js';
import { DesktopMlService } from 'src/services/desktop-ml.service.js';
import { SmartInfoService } from 'src/services/smart-info.service.js';
import * as destinationSelection from 'src/utils/ml-destination.js';
import { newTestService } from 'test/utils.js';

const catalogue = JSON.parse(
  readFileSync(new URL('../../resources/desktop/model-catalogue.json', import.meta.url), 'utf8'),
);
const profile = catalogue.profiles[0];
const space = JSON.parse(readFileSync(new URL('../../resources/desktop/model-spaces.json', import.meta.url), 'utf8'))
  .spaces[0];
const binding = { revisionId: 'index-revision', space };
const selection: MlSelection = {
  destinationId: 'NAS-selected',
  kind: MlDestinationKind.Local,
  workload: MlWorkload.Clip,
  endpoint: { url: 'https://never-fetch.invalid', assertAuthority: vi.fn() },
  record: vi.fn(),
};
const ownerId = '8da8d162-c2c3-4d1d-b6e1-9148b0bfd327';
const repository = { create: vi.fn(), result: vi.fn(), cancel: vi.fn(), discard: vi.fn(), assertAdoption: vi.fn() };
const index = { assertCurrent: vi.fn(), selectProfile: vi.fn() };
const authority = vi.fn();
let service: DesktopMlService;
let ml: MachineLearningRepository;
let context: QueueExecution;
beforeEach(() => {
  vi.resetAllMocks();
  service = new DesktopMlService(repository as never, index as never);
  ml = new MachineLearningRepository(LoggingRepository.create(), undefined, undefined, undefined, index as never);
  ml.setup(defaults.machineLearning);
  context = {
    claim: {
      id: 'NAS-job',
      token: 'NAS-claim',
      name: JobName.SmartSearch,
      queue: 'smart-search',
      data: {},
      workerId: 'NAS-worker',
      attempt: 1,
      runId: null,
      itemKey: null,
      deadlineMs: 60_000,
      startedAt: new Date(),
    },
    signal: new AbortController().signal,
    adoptions: [],
    followups: [],
    buffering: false,
    progress: vi.fn(),
    progressUnits: 0,
  };
  index.assertCurrent.mockResolvedValue(undefined);
  index.selectProfile.mockResolvedValue({ binding, profile });
  authority.mockResolvedValue(undefined);
  vi.mocked(selection.endpoint.assertAuthority!).mockResolvedValue(undefined);
  repository.create.mockImplementation((request) => Promise.resolve({ ...request, id: 'broker-task' }));
  repository.result.mockImplementation(() => {
    const request = repository.create.mock.calls[0][0];
    return Promise.resolve({
      state: 'completed',
      modelKey: request.modelKey,
      authorityKey: request.authorityKey,
      result: { clip: profile.spec.expectedOutput.clip },
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const pool = () =>
  service.selectClipPool(selection, {
    ownerId,
    authorityKey: 'explicit-pool-policy',
    binding,
    assertAuthority: authority,
  });
it('runs an explicit queued CLIP request through the broker and retains NAS publication fences', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await queueExecution.run(context, async () => {
    const chosen = pool();
    const result = await ml.encodeTextWithProvenance(chosen, 'a synthetic photo', { modelName: profile.modelName });
    expect(result).toEqual({ embedding: profile.spec.expectedOutput.clip, modelKey: profile.modelKey });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId,
        modelKey: profile.modelKey,
        config: profile.spec.entries,
        input: Buffer.from('a synthetic photo'),
        inputKind: 'text',
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(context.adoptions).toHaveLength(1);
    await context.adoptions[0]('publication' as never);
    expect(index.assertCurrent).toHaveBeenLastCalledWith(binding, 'publication');
    expect(authority).toHaveBeenLastCalledWith('publication');
    expect(repository.assertAdoption).toHaveBeenCalled();
  });
});
it('does not admit interactive work or let a selection escape its NAS queue claim', async () => {
  expect(pool).toThrow('desktop_pool_queue_required');
  const chosen = queueExecution.run(context, pool);
  await expect(ml.encodeText(chosen, 'query', { modelName: profile.modelName })).rejects.toThrow(
    'desktop_pool_queue_changed',
  );
  expect(repository.create).not.toHaveBeenCalled();
});
it.each(['index', 'policy', 'worker', 'result', 'legacy'])(
  'never falls back to HTTP after %s refusal',
  async (reason) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    switch (reason) {
      case 'index': {
        index.assertCurrent.mockRejectedValue(new Error('index changed'));
        break;
      }
      case 'policy': {
        authority.mockRejectedValue(new Error('policy revoked'));
        break;
      }
      case 'worker': {
        repository.result.mockResolvedValue({ state: 'failed' });
        break;
      }
      case 'result': {
        repository.result.mockImplementation(() => {
          const request = repository.create.mock.calls[0][0];
          return Promise.resolve({
            state: 'completed',
            authorityKey: request.authorityKey,
            modelKey: request.modelKey,
            result: { clip: '[1,2]' },
          });
        });
        break;
      }
      case 'legacy': {
        index.selectProfile.mockResolvedValue(undefined);
        // No default
        break;
      }
    }
    await queueExecution.run(context, async () => {
      await expect(ml.encodeText(pool(), 'fixture', { modelName: profile.modelName })).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
      if (reason === 'result') {
        expect(context.adoptions).toHaveLength(0);
        expect(repository.cancel).toHaveBeenCalledWith('broker-task');
      }
    });
  },
);

it('captures bounded image input and returns a validated vector with its producer identity', async () => {
  const visual = catalogue.profiles.find((p: { modelKey: string }) => p.modelKey === space.visualModelKey);
  index.selectProfile.mockResolvedValue({ binding, profile: visual });
  repository.result.mockImplementation(() => {
    const request = repository.create.mock.calls[0][0];
    return Promise.resolve({
      state: 'completed',
      modelKey: request.modelKey,
      authorityKey: request.authorityKey,
      result: visual.spec.expectedOutput,
    });
  });
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-pool-test-'));
  const path = join(root, 'fixture.png');
  const bytes = Buffer.from(visual.fixtureBase64, 'base64');
  try {
    await writeFile(path, bytes);
    await queueExecution.run(context, async () => {
      const result = await ml.encodeImage(pool(), path, {
        ...defaults.machineLearning.clip,
        modelName: visual.modelName,
      });
      expect(result).toEqual({ embedding: visual.spec.expectedOutput.clip, modelKey: visual.modelKey });
      expect(repository.create.mock.calls[0][0].input).toEqual(bytes);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.each([0, 16 * 1024 * 1024 + 1])('refuses a %s byte image before creating a broker task', async (size) => {
  const visual = catalogue.profiles.find((p: { modelKey: string }) => p.modelKey === space.visualModelKey);
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-pool-test-'));
  const path = join(root, 'oversize');
  const file = await open(path, 'w');
  await file.truncate(size);
  await file.close();
  try {
    await queueExecution.run(context, async () => {
      await expect(pool().desktopClip!({ imagePath: path }, visual)).rejects.toThrow('desktop_input_size_invalid');
      expect(repository.create).not.toHaveBeenCalled();
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('executes the existing NAS SmartSearch handler through the selected desktop pool', async () => {
  const visual = catalogue.profiles.find((p: { modelKey: string }) => p.modelKey === space.visualModelKey);
  const root = await mkdtemp(join(tmpdir(), 'frameleaf-pool-job-'));
  const path = join(root, 'fixture.png');
  const { sut, mocks } = newTestService(SmartInfoService);
  const settings = structuredClone(defaults);
  settings.machineLearning.clip.modelName = visual.modelName;
  settings.machineLearning.urls = [selection.endpoint.url];
  const hooks = sut as unknown as {
    getConfig: () => Promise<typeof settings>;
    selectRoutedMlDestination: () => Promise<MlSelection>;
  };
  vi.spyOn(hooks, 'getConfig').mockResolvedValue(settings);
  vi.spyOn(destinationSelection, 'selectMlDestination').mockResolvedValue(selection);
  const policies = {
    snapshot: vi.fn().mockResolvedValue({ accounts: { [ownerId]: { revisionId: 'consent' } } }),
    assertCurrent: vi.fn(),
  };
  const routes = {
    getRouteStates: vi
      .fn()
      .mockResolvedValue([
        { workload: MlWorkload.Clip, destinationId: selection.destinationId, origin: 'default', revisionId: 'route' },
      ]),
    assertDefaultRoute: vi.fn(),
  };
  service = new DesktopMlService(repository as never, index as never, policies as never, routes as never);
  ml = new MachineLearningRepository(
    LoggingRepository.create(),
    undefined,
    undefined,
    undefined,
    index as never,
    service,
  );
  ml.setup(settings.machineLearning);
  context.sourceAuthorities = new Map([[ownerId, { ownerId, assertCurrent: vi.fn() }]]);
  mocks.machineLearning.selectBackgroundPool.mockImplementation(ml.selectBackgroundPool.bind(ml));
  mocks.assetJob.getForClipEncoding.mockResolvedValue({
    id: ownerId,
    ownerId,
    visibility: AssetVisibility.Timeline,
    files: [{ path }],
  } as never);
  mocks.machineLearning.encodeImage.mockImplementation(ml.encodeImage.bind(ml));
  index.selectProfile.mockResolvedValue({ binding, profile: visual });
  repository.result.mockImplementation(() => {
    const request = repository.create.mock.calls[0][0];
    return Promise.resolve({
      state: 'completed',
      modelKey: request.modelKey,
      authorityKey: request.authorityKey,
      result: visual.spec.expectedOutput,
    });
  });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    await writeFile(path, Buffer.from(visual.fixtureBase64, 'base64'));
    await queueExecution.run(context, async () => {
      await expect(sut.handleEncodeClip({ id: ownerId })).resolves.toBe(JobStatus.Success);
      expect(mocks.search.upsert).toHaveBeenCalledWith(ownerId, {
        embedding: visual.spec.expectedOutput.clip,
        modelKey: visual.modelKey,
      });
      expect(repository.create).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['execution', 'publication'])('rejects a replaced NAS queue token at %s', async (stage) => {
  await queueExecution.run(context, async () => {
    const chosen = pool();
    if (stage === 'execution') {
      context.claim.token = 'replacement';
      await expect(ml.encodeText(chosen, 'fixture', { modelName: profile.modelName })).rejects.toThrow(
        'desktop_pool_queue_changed',
      );
      expect(repository.create).not.toHaveBeenCalled();
    } else {
      await ml.encodeText(chosen, 'fixture', { modelName: profile.modelName });
      context.claim.token = 'replacement';
      await expect(context.adoptions[0]('publication' as never)).rejects.toThrow('desktop_pool_queue_changed');
      expect(repository.assertAdoption).not.toHaveBeenCalled();
    }
  });
});

it.each([
  { kind: MlDestinationKind.FrameleafCloud },
  { workload: MlWorkload.Face },
  { endpoint: { ...selection.endpoint, cloud: true as const } },
  { desktopClip: () => Promise.resolve({}) },
])('refuses an incompatible pool parent', (patch) => {
  queueExecution.run(context, () => {
    expect(() =>
      service.selectClipPool(
        { ...selection, ...patch },
        { ownerId, authorityKey: 'policy', binding, assertAuthority: authority },
      ),
    ).toThrow('desktop_pool_selection_invalid');
  });
  expect(repository.create).not.toHaveBeenCalled();
});
