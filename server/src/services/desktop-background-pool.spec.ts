import { readFileSync } from 'node:fs';
import type { QueueExecution } from 'src/queue/types.js';
import type { MlSelection } from 'src/repositories/machine-learning.repository.js';
import { defaults } from 'src/config.js';
import { JobName, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { DesktopMlService } from 'src/services/desktop-ml.service.js';

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
    sourceAuthorities: new Map([['asset', { ownerId, assertCurrent: assertSource }]]),
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
    if (mode === 'pinned' || mode === 'legacy')
      routes.getRouteStates.mockResolvedValue([
        { workload: MlWorkload.Clip, destinationId: 'nas', origin: mode, revisionId: 'route' },
      ]);
    else if (mode === 'other-account') context.sourceAuthorities!.get('asset')!.ownerId = other;
    else if (mode === 'other-workload') selection.workload = MlWorkload.PetRecognition;
    await queueExecution.run(context, async () => expect(await select('asset')).toBe(selection));
  },
);
it.each(['unknown', 'ambiguous', 'index'])('waits without falling back for %s authority', async (mode) => {
  if (mode === 'unknown') context.sourceAuthorities!.clear();
  else if (mode === 'ambiguous') context.sourceAuthorities!.set('other', { ownerId: other, assertCurrent: vi.fn() });
  else if (mode === 'index') index.selectProfile.mockResolvedValue(undefined);
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
    context.sourceAuthorities!.set('asset', { ownerId: other, assertCurrent: vi.fn() });
    await factory.mock.calls[0][1].assertAuthority();
    expect(assertSource).toHaveBeenCalledTimes(2);
    policies.assertCurrent.mockRejectedValue(new Error('revoked'));
    await expect(factory.mock.calls[0][1].assertAuthority()).rejects.toThrow('revoked');
  });
});
