import { readFileSync } from 'node:fs';
import type { QueueExecution } from 'src/queue/types.js';
import type { MlSelection } from 'src/repositories/machine-learning.repository.js';
import { JobName, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { DesktopMlService } from 'src/services/desktop-ml.service.js';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { desktopSourceSnapshot } from 'test/desktop-source-authority.js';

// FD-31: the released catalogue has no description profile yet, so the fixture's stands in for it.
const fixture = parseDesktopModelCatalogue({
  schemaVersion: 1,
  epoch: 19,
  profiles: [JSON.parse(readFileSync('test/fixtures/desktop-description-profile.json', 'utf8'))],
}).profiles[0];
vi.mock('src/utils/desktop-description.js', async (original) => ({
  ...(await original<typeof import('src/utils/desktop-description.js')>()),
  desktopDescriptionProfile: (configured: string) => {
    if (configured !== 'Qwen/Qwen2.5-VL-7B-Instruct') throw new Error('desktop_pool_model_unavailable');
    return fixture;
  },
}));

const ownerId = '8da8d162-c2c3-4d1d-b6e1-9148b0bfd327';
const policies = { snapshot: vi.fn(), assertCurrent: vi.fn() };
const routes = { assertDesktopDestination: vi.fn() };
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
    workload: MlWorkload.Enrichment,
    endpoint: { url: 'https://unused.invalid', assertAuthority: vi.fn() },
    record: vi.fn(),
  };
  context = {
    claim: {
      id: '0d3a33e5-8f8b-4ad8-a2f4-7a3b6b3f6c41',
      token: '5b4c6a8e-0c38-4c33-9d0a-58e0a3c1f2b7',
      name: JobName.ImageDescription,
      data: {},
      queue: 'imageDescription',
      workerId: 'worker',
      attempt: 1,
      runId: null,
      itemKey: null,
      deadlineMs: 600_000,
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
  policies.snapshot.mockResolvedValue({ accounts: { [ownerId]: { revisionId: 'consent' } } });
  service = new DesktopMlService({} as never, {} as never, policies as never, routes as never);
});

const select = (modelName: string, description = true) =>
  queueExecution.run(context, () =>
    service.selectBackgroundPool(selection, {
      jobId: 'asset',
      modelName,
      ...(description && { description: { modelName } }),
      assertConfig,
    }),
  );

it('gives a description job with a desktop build of its model to the owner’s desktops', async () => {
  const chosen = await select('Qwen/Qwen2.5-VL-7B-Instruct');
  expect(chosen.desktopDescription).toBeTypeOf('function');
  expect(chosen.desktopOcr).toBeUndefined();
  expect(routes.assertDesktopDestination).toHaveBeenCalledWith(selection, undefined, MlWorkload.Enrichment);
  expect(assertSource).toHaveBeenCalledOnce();
});

it('leaves the safety check and models with no desktop build on the destination itself', async () => {
  // the safety check a description job also makes is enrichment too, but never a description request
  expect(await select('Qwen/Qwen2.5-VL-7B-Instruct', false)).toBe(selection);
  expect(await select('Qwen/Qwen2.5-VL-3B-Instruct')).toBe(selection);
  expect(policies.snapshot).toHaveBeenCalledOnce();
});
