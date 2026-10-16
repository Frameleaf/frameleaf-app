import { readFileSync } from 'node:fs';
import type { QueueExecution } from 'src/queue/types.js';
import type { MlSelection } from 'src/repositories/machine-learning.repository.js';
import { defaults } from 'src/config.js';
import { JobName, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { DesktopMlService } from 'src/services/desktop-ml.service.js';
import { desktopSourceSnapshot } from 'test/desktop-source-authority.js';

const ownerId = '8da8d162-c2c3-4d1d-b6e1-9148b0bfd327';
const other = '2bd5aa96-614a-4df1-bd20-1c285bd8be63';
const space = JSON.parse(readFileSync(new URL('../../resources/desktop/model-spaces.json', import.meta.url), 'utf8'))
  .spaces[0];
const binding = { revisionId: 'index', space };
const policy = { accounts: { [ownerId]: { revisionId: 'consent' } } };
const index = { selectProfile: vi.fn(), assertCurrent: vi.fn() };
const policies = { snapshot: vi.fn(), assertCurrent: vi.fn() };
const routes = { getRouteStates: vi.fn(), assertDefaultRoute: vi.fn() };
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
it('selects a consented source owner on the default queued route', async () => {
  await queueExecution.run(context, async () => {
    const chosen = await select('asset');
    expect(chosen.desktopClip).toBeTypeOf('function');
    expect(assertSource).toHaveBeenCalledOnce();
    expect(policies.assertCurrent).toHaveBeenCalledWith(ownerId, 'consent', undefined);
    expect(routes.assertDefaultRoute).toHaveBeenCalledWith(selection, 'route', undefined);
  });
});
it.each(['interactive', 'pinned', 'legacy', 'other-account', 'other-workload'])(
  'preserves %s selection',
  async (mode) => {
    if (mode === 'interactive') {
      expect(await select('asset')).toBe(selection);
      return;
    }
    switch (mode) {
      case 'pinned':
      case 'legacy': {
        routes.getRouteStates.mockResolvedValue([
          { workload: MlWorkload.Clip, destinationId: 'nas', origin: mode, revisionId: 'route' },
        ]);
        break;
      }
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
  },
);
it.each(['unknown', 'ambiguous', 'index'])('waits without falling back for %s authority', async (mode) => {
  switch (mode) {
    case 'unknown': {
      context.sourceAuthorities!.clear();
      break;
    }
    case 'ambiguous': {
      context.sourceAuthorities!.set('other', {
        ownerId: other,
        snapshot: desktopSourceSnapshot(other),
        assertCurrent: vi.fn(),
      });
      break;
    }
    case 'index': {
      index.selectProfile.mockResolvedValue(undefined);
      break;
    }
    default: {
      break;
    }
  }
  await queueExecution.run(context, async () => {
    await expect(select(mode === 'ambiguous' ? undefined : 'asset')).rejects.toThrow();
    expect(context.dependencyReason).toBe(mode === 'index' ? 'destination-configuration' : 'source-unavailable');
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
