import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueExecution } from 'src/queue/types.js';
import type { MlSelection } from 'src/repositories/machine-learning.repository.js';
import { defaults } from 'src/config.js';
import { JobName, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { DesktopMlService } from 'src/services/desktop-ml.service.js';
import { desktopFaceProfile, faceEntries } from 'src/utils/desktop-face.js';
import { desktopEndpointDigest } from 'src/utils/desktop-ml-disclosure.js';
import * as mlDestination from 'src/utils/ml-destination.js';
import { desktopSourceSnapshot } from 'test/desktop-source-authority.js';

const ownerId = '8da8d162-c2c3-4d1d-b6e1-9148b0bfd327';
const other = '2bd5aa96-614a-4df1-bd20-1c285bd8be63';
const space = JSON.parse(readFileSync(new URL('../../resources/desktop/model-spaces.json', import.meta.url), 'utf8'))
  .spaces[0];
const binding = { revisionId: 'index', space };
const policy = { accounts: { [ownerId]: { revisionId: 'consent' } } };
const index = { selectProfile: vi.fn(), assertCurrent: vi.fn() };
const policies = { snapshot: vi.fn(), assertCurrent: vi.fn() };
const routes = { getRouteStates: vi.fn(), assertDesktopDestination: vi.fn() };
const assertSource = vi.fn();
const assertConfig = vi.fn();
let context: QueueExecution;
let service: DesktopMlService;
let selection: MlSelection;
beforeEach(() => {
  vi.resetAllMocks();
  selection = {
    destinationId: 'nas',
    kind: MlDestinationKind.Local,
    workload: MlWorkload.Clip,
    endpoint: { url: 'https://unused.invalid', assertAuthority: vi.fn() },
    record: vi.fn(),
  };
  context = {
    claim: {
      id: 'job',
      token: 'claim',
      name: JobName.SmartSearch,
      data: {},
      queue: 'smart-search',
      workerId: 'worker',
      attempt: 1,
      runId: null,
      itemKey: null,
      deadlineMs: 60_000,
      startedAt: new Date(),
    },
    signal: new AbortController().signal,
    progress: vi.fn(),
    followups: [],
    adoptions: [],
    buffering: false,
    progressUnits: 0,
    sourceAuthorities: new Map([
      ['asset', { ownerId, snapshot: desktopSourceSnapshot(ownerId), assertCurrent: assertSource }],
    ]),
  };
  policies.snapshot.mockResolvedValue(structuredClone(policy));
  routes.getRouteStates.mockResolvedValue([
    { workload: MlWorkload.Clip, destinationId: 'nas', origin: 'default', revisionId: 'route' },
  ]);
  index.selectProfile.mockResolvedValue({ binding });
  service = new DesktopMlService({} as never, index as never, policies as never, routes as never);
});
const select = (jobId?: string) =>
  service.selectBackgroundPool(selection, { jobId, modelName: defaults.machineLearning.clip.modelName, assertConfig });
it('selects a consented source owner for queued home work', async () => {
  await queueExecution.run(context, async () => {
    const chosen = await select('asset');
    expect(chosen.desktopClip).toBeTypeOf('function');
    expect(assertSource).toHaveBeenCalledOnce();
    expect(policies.assertCurrent).toHaveBeenCalledWith(ownerId, 'consent', undefined);
    expect(routes.assertDesktopDestination).toHaveBeenCalledWith(selection, undefined, MlWorkload.Clip);
  });
});
it.each(['pinned', 'legacy'] as const)('takes work whose %s route chose a home destination', async (origin) => {
  routes.getRouteStates.mockResolvedValue([
    { workload: MlWorkload.Clip, destinationId: 'nas', origin, revisionId: null },
  ]);
  await queueExecution.run(context, async () => expect((await select('asset')).desktopClip).toBeTypeOf('function'));
});
it('takes work for a home destination the route does not name (processing order)', async () => {
  routes.getRouteStates.mockResolvedValue([]);
  await queueExecution.run(context, async () => expect((await select('asset')).desktopClip).toBeTypeOf('function'));
});
it.each(['interactive', 'other-account', 'other-workload'])('preserves %s selection', async (mode) => {
  if (mode === 'interactive') {
    expect(await select('asset')).toBe(selection);
    return;
  }
  switch (mode) {
    case 'other-account': {
      context.sourceAuthorities!.get('asset')!.ownerId = other;
      break;
    }
    case 'other-workload': {
      selection.workload = MlWorkload.PetRecognition;
      break;
    }
    default: {
      break;
    }
  }
  await queueExecution.run(context, async () => expect(await select('asset')).toBe(selection));
});
it.each(['unknown', 'ambiguous'])('waits without falling back for %s authority', async (mode) => {
  if (mode === 'unknown') context.sourceAuthorities!.clear();
  else
    context.sourceAuthorities!.set('other', {
      ownerId: other,
      snapshot: desktopSourceSnapshot(other),
      assertCurrent: vi.fn(),
    });
  await queueExecution.run(context, async () => {
    await expect(select(mode === 'ambiguous' ? undefined : 'asset')).rejects.toThrow();
    expect(context.dependencyReason).toBe('source-unavailable');
  });
});
it('leaves smart search on the destination itself while no desktop has been granted it', async () => {
  index.selectProfile.mockResolvedValue(undefined);
  await queueExecution.run(context, async () => {
    expect(await select('asset')).toBe(selection);
    // nothing to wait for: a retry must not defer for an index no desktop has asked for
    expect(context.dependencyReason).toBeUndefined();
  });
});
it('refuses changed source before constructing an inference descriptor', async () => {
  assertSource.mockRejectedValue(new Error('source changed'));
  await queueExecution.run(context, async () => await expect(select('asset')).rejects.toThrow('source changed'));
});
it('retains a captured source guard if another asset is guarded later', async () => {
  const factory = vi.spyOn(service, 'selectClipPool').mockReturnValue(selection);
  await queueExecution.run(context, async () => {
    await select('asset');
    context.sourceAuthorities!.set('asset', {
      ownerId: other,
      snapshot: desktopSourceSnapshot(other),
      assertCurrent: vi.fn(),
    });
    await factory.mock.calls[0][1].assertAuthority();
    expect(assertSource).toHaveBeenCalledTimes(2);
    policies.assertCurrent.mockRejectedValue(new Error('revoked'));
    await expect(factory.mock.calls[0][1].assertAuthority()).rejects.toThrow('revoked');
  });
});

it('registers the pool selector at bootstrap and refuses queued work after shutdown', async () => {
  const ml = new MachineLearningRepository(LoggingRepository.create(), undefined, undefined, undefined, index as never);
  ml.setup({ ...defaults.machineLearning, urls: [selection.endpoint.url] });
  const registered = new DesktopMlService({} as never, index as never, policies as never, routes as never, ml);
  await queueExecution.run(context, async () => {
    await expect(ml.selectBackgroundPool(selection, 'asset')).rejects.toThrow('desktop_pool_authority_unavailable');
    registered.onBootstrap();
    expect((await ml.selectBackgroundPool(selection, 'asset')).desktopClip).toBeTypeOf('function');
    registered.onShutdown();
    await expect(ml.selectBackgroundPool(selection, 'asset')).rejects.toThrow('desktop_pool_authority_unavailable');
  });
  expect(await ml.selectBackgroundPool(selection, 'asset')).toBe(selection);
});

it('selects the exact OCR workload without requiring a CLIP index or NAS inference', async () => {
  selection.workload = MlWorkload.Ocr;
  routes.getRouteStates.mockResolvedValue([
    { workload: MlWorkload.Ocr, destinationId: 'nas', origin: 'default', revisionId: 'route' },
  ]);
  await queueExecution.run(context, async () => {
    const chosen = await service.selectBackgroundPool(selection, {
      jobId: 'asset',
      modelName: defaults.machineLearning.ocr.modelName,
      ocr: defaults.machineLearning.ocr,
      assertConfig,
    });
    expect(chosen.desktopOcr).toBeTypeOf('function');
    expect(index.selectProfile).not.toHaveBeenCalled();
    expect(assertSource).toHaveBeenCalledOnce();
  });
});

it('selects a qualified face workload without changing the CLIP index', async () => {
  selection.workload = MlWorkload.Face;
  routes.getRouteStates.mockResolvedValue([
    { workload: MlWorkload.Face, destinationId: 'nas', origin: 'default', revisionId: 'route' },
  ]);
  await queueExecution.run(context, async () => {
    const chosen = await service.selectBackgroundPool(selection, {
      jobId: 'asset',
      modelName: defaults.machineLearning.facialRecognition.modelName,
      face: defaults.machineLearning.facialRecognition,
      assertConfig,
    });
    expect(chosen.desktopFace).toBeTypeOf('function');
    expect(index.selectProfile).not.toHaveBeenCalled();
    expect(assertSource).toHaveBeenCalledOnce();
  });
});
describe('when the processing order sends the job to the helpers (FL-456)', () => {
  const ready = vi.fn();
  const selectReady = () =>
    service.selectBackgroundPool(selection, {
      jobId: 'asset',
      modelName: defaults.machineLearning.clip.modelName,
      assertConfig,
      requireReady: true,
    });
  beforeEach(() => {
    service = new DesktopMlService(
      { hasReadyWorker: ready } as never,
      index as never,
      policies as never,
      routes as never,
    );
  });
  it('takes the job when one of the owner’s helpers is ready for its model', async () => {
    ready.mockResolvedValue(true);
    await queueExecution.run(context, async () => {
      expect((await selectReady()).desktopClip).toBeTypeOf('function');
      // FL-1484: an unlocked photo may also go to a computer that helps everyone
      expect(ready).toHaveBeenCalledWith(ownerId, space.visualModelKey, { household: true });
    });
  });
  it('hands the job back for the next place when none is ready', async () => {
    ready.mockResolvedValue(false);
    await queueExecution.run(context, async () => expect(await selectReady()).toBe(selection));
  });
});

describe('extra jobs a queue starts for desktops', () => {
  const broker = { helperCapacity: vi.fn() };
  const plans = { resolveRoutes: vi.fn() };
  const ml = { desktopModelKeys: vi.fn() };
  const here = { source: 'local', destinationId: 'nas', desktopPool: false, available: true };
  const desktops = { source: 'desktops', destinationId: 'nas', desktopPool: true, available: true };
  beforeEach(() => {
    service = new DesktopMlService(broker as never, index as never, policies as never, plans as never, ml as never);
    ml.desktopModelKeys.mockImplementation((workload: MlWorkload) => Promise.resolve([`${workload}-key`]));
    broker.helperCapacity.mockImplementation((scopes: Record<string, string[]>) =>
      Promise.resolve(Object.fromEntries(Object.entries(scopes).map(([queue, keys]) => [queue, keys.length * 2]))),
    );
  });

  it('starts none while this server comes first and its AI is answering', async () => {
    plans.resolveRoutes.mockResolvedValue(
      new Map([
        [MlWorkload.Clip, [here, desktops]],
        [MlWorkload.Face, [here, desktops]],
        [MlWorkload.Ocr, [here, desktops]],
      ]),
    );
    expect(await service.queueCapacity('smartSearch')).toBe(0);
    expect(broker.helperCapacity).toHaveBeenCalledWith({ smartSearch: [], faceDetection: [], ocr: [] });
    expect(ml.desktopModelKeys).not.toHaveBeenCalled();
  });

  it('counts desktops only for a queue whose work goes to them first, for the models the settings ask for', async () => {
    plans.resolveRoutes.mockResolvedValue(
      new Map([
        // desktops first in the order
        [MlWorkload.Clip, [desktops, here]],
        // this server first, but its AI is down: the first place that can take the work is the desktops
        [MlWorkload.Face, [{ ...here, available: false }, desktops]],
        // no desktop is ready: this server
        [MlWorkload.Ocr, [{ ...desktops, available: false }, here]],
      ]),
    );
    expect(await service.queueCapacity('smartSearch')).toBe(2);
    expect(await service.queueCapacity('faceDetection')).toBe(2);
    expect(await service.queueCapacity('ocr')).toBe(0);
    expect(await service.queueCapacity('thumbnailGeneration')).toBe(0);
    expect(broker.helperCapacity).toHaveBeenCalledExactlyOnceWith({
      smartSearch: ['clip-key'],
      faceDetection: ['face-key'],
      ocr: [],
    });
    // read at most every two seconds for all queues, then again
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 2500);
    await service.queueCapacity('smartSearch');
    expect(broker.helperCapacity).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});

describe('a gallery guest selfie (FL-1058)', () => {
  const broker = {
    hasReadyWorker: vi.fn(),
    create: vi.fn(),
    result: vi.fn(),
    cancel: vi.fn(),
    discard: vi.fn(),
    assertAdoption: vi.fn(),
  };
  const face = defaults.machineLearning.facialRecognition;
  const guest = (requireReady = true) =>
    service.selectBackgroundPool(selection, {
      guestOwnerId: ownerId,
      requireReady,
      modelName: face.modelName,
      face,
      assertConfig,
    });
  beforeEach(() => {
    selection.workload = MlWorkload.Face;
    routes.getRouteStates.mockResolvedValue([
      { workload: MlWorkload.Face, destinationId: 'nas', origin: 'default', revisionId: 'route' },
    ]);
    broker.hasReadyWorker.mockResolvedValue(true);
    broker.create.mockResolvedValue({ id: 'task' });
    service = new DesktopMlService(broker as never, index as never, policies as never, routes as never);
  });

  it('runs on the owner own helpers outside the queue and discards the task', async () => {
    const chosen = await guest();
    expect(broker.hasReadyWorker).toHaveBeenCalledWith(ownerId, expect.stringMatching(/^face:/), { household: false });
    const result = { imageWidth: 1, imageHeight: 1, 'facial-recognition': [] };
    broker.result.mockImplementation(() => {
      const { authorityKey, modelKey } = broker.create.mock.calls[0]![0];
      return Promise.resolve({ state: 'completed', result, authorityKey, modelKey });
    });
    const folder = await mkdtemp(join(tmpdir(), 'guest-'));
    const imagePath = join(folder, 'selfie.jpg');
    await writeFile(imagePath, 'selfie');
    try {
      await expect(chosen.desktopFace!({ imagePath }, faceEntries(face))).resolves.toEqual(result);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
    const [request] = broker.create.mock.calls[0]!;
    expect(request.disclosure).toMatchObject({ version: 4, workload: 'guest-face', policyRevision: 'consent' });
    expect(request.disclosure).not.toHaveProperty('source');
    expect(request.disclosure).not.toHaveProperty('job');
    expect(request.deadlineAt.getTime() - Date.now()).toBeLessThanOrEqual(25_000);
    expect(broker.discard).toHaveBeenCalledWith('task', true);
    expect(routes.assertDesktopDestination).toHaveBeenCalledWith(selection, undefined, MlWorkload.Face);
  });

  it('never uses a household computer or an unready helper', async () => {
    policies.snapshot.mockResolvedValue({ accounts: {}, household: { revisionId: 'home', devices: ['device'] } });
    expect((await guest()).desktopFace).toBeUndefined();
    policies.snapshot.mockResolvedValue(structuredClone(policy));
    broker.hasReadyWorker.mockResolvedValue(false);
    expect((await guest()).desktopFace).toBeUndefined();
    expect(broker.create).not.toHaveBeenCalled();
  });
});

describe('a helper reading a guest selfie (FL-1058)', () => {
  it('rechecks policy, destination and face settings without a library photo or queued job', async () => {
    const face = defaults.machineLearning.facialRecognition;
    const profile = desktopFaceProfile(face);
    const endpoint = { url: 'https://unused.invalid' };
    const authority = {
      version: 4,
      workload: 'guest-face',
      policyRevision: '5f0c2b8e-1111-4c1d-9b1a-000000000001',
      destinationId: '5f0c2b8e-1111-4c1d-9b1a-000000000003',
      kind: MlDestinationKind.Local,
      endpointSha256: desktopEndpointDigest(endpoint),
      modelName: face.modelName,
      modelKey: profile.modelKey,
      face,
    };
    const task = { ownerId, disclosure: authority, modelKey: profile.modelKey, config: profile.spec.entries };
    const destination = { id: authority.destinationId, kind: MlDestinationKind.Local };
    const tx = {};
    vi.spyOn(MlDestinationRepository.prototype, 'getById').mockResolvedValue(destination as never);
    vi.spyOn(MlDestinationRepository.prototype, 'assertRecoveryAuthority').mockResolvedValue();
    const desktopDestination = vi
      .spyOn(MlDestinationRepository.prototype, 'assertDesktopDestination')
      .mockResolvedValue();
    vi.spyOn(mlDestination, 'resolveEndpoint').mockReturnValue(endpoint as never);
    const assertDesktopFaceConfig = vi.fn();
    const broker = {
      input: vi.fn((_grant, _attempt, authorize: (task: unknown, tx: unknown) => Promise<void>) =>
        authorize(task, tx).then(() => Buffer.from('selfie')),
      ),
    };
    service = new DesktopMlService(
      broker as never,
      index as never,
      policies as never,
      routes as never,
      {
        assertDesktopFaceConfig,
      } as never,
    );
    await expect(service.input({} as never, 'attempt')).resolves.toEqual(Buffer.from('selfie'));
    expect(policies.assertCurrent).toHaveBeenCalledWith(ownerId, authority.policyRevision, tx);
    expect(desktopDestination).toHaveBeenCalledWith(
      expect.objectContaining({ destinationId: authority.destinationId }),
      tx,
      MlWorkload.Face,
    );
    expect(assertDesktopFaceConfig).toHaveBeenCalledOnce();
  });
});
