import { type Kysely, sql } from 'kysely';
import { readFileSync } from 'node:fs';
import type { QueueExecution } from 'src/queue/types.js';
import type { MlSelection } from 'src/repositories/machine-learning.repository.js';
import type { DB } from 'src/schema/index.js';
import { defaults } from 'src/config.js';
import { JobName, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { DesktopMlService } from 'src/services/desktop-ml.service.js';
import { EFFECTIVE_CONFIG_LOCK } from 'src/utils/effective-config-lock.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let jobs: JobRepository;
let context: QueueExecution;
beforeEach(async () => {
  db = await getKyselyDB();
  jobs = new JobRepository({} as never, {} as never, {} as never, LoggingRepository.create(), db);
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
  };
});
afterEach(async () => db.destroy());
const assetFixture = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser({ isAdmin: true });
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  return { ctx, user, asset };
};
it('retains database ownership separately for each asset and refuses ownership changes before disclosure', async () => {
  const { ctx, user, asset } = await assetFixture();
  const { user: other } = await ctx.newUser();
  const { asset: second } = await ctx.newAsset({ ownerId: other.id });
  await queueExecution.run(context, async () => {
    await jobs.guardAssetSource(asset.id);
    await jobs.guardAssetSource(second.id);
    expect(context.sourceAuthorities!.get(asset.id)!.ownerId).toBe(user.id);
    expect(context.sourceAuthorities!.get(second.id)!.ownerId).toBe(other.id);
    const authority = context.sourceAuthorities!.get(asset.id)!;
    await authority.assertCurrent();
    await db.updateTable('asset').set({ ownerId: other.id }).where('id', '=', asset.id).execute();
    await expect(authority.assertCurrent()).rejects.toThrow('Asset inputs changed');
    await context.sourceAuthorities!.get(second.id)!.assertCurrent();
  });
});
it('reconstructs the actual policy and route from storage and refuses route changes before adoption', async () => {
  const { user, asset } = await assetFixture();
  const policies = new DesktopAssistancePolicyService(new SystemMetadataRepository(db));
  const account = await policies.enable(user.id);
  const routes = new MlDestinationRepository(db);
  const destination = await routes.create({
    kind: MlDestinationKind.Local,
    name: 'synthetic NAS',
    url: null,
    authToken: null,
    enabled: true,
    workloads: [MlWorkload.Clip],
    budgetLimitUsd: null,
    maxRuntimeMinutes: null,
    maxUploadBytes: null,
  });
  await routes.setDefaultRoute(MlWorkload.Clip, destination.id);
  const space = JSON.parse(
    readFileSync(new URL('../../../../resources/desktop/model-spaces.json', import.meta.url), 'utf8'),
  ).spaces[0];
  const index = { selectProfile: vi.fn().mockResolvedValue({ binding: { revisionId: 'index', space } }) };
  const service = new DesktopMlService({} as never, index as never, policies, routes);
  const selection: MlSelection = {
    destinationId: destination.id,
    kind: MlDestinationKind.Local,
    workload: MlWorkload.Clip,
    endpoint: { url: 'https://unused.invalid', assertAuthority: vi.fn() },
    record: vi.fn(),
  };
  const factory = vi.spyOn(service, 'selectClipPool').mockReturnValue(selection);
  await queueExecution.run(context, async () => {
    await jobs.guardAssetSource(asset.id);
    await service.selectBackgroundPool(selection, {
      jobId: asset.id,
      modelName: defaults.machineLearning.clip.modelName,
      assertConfig: () => Promise.resolve(),
    });
    expect(factory.mock.calls[0][1].ownerId).toBe(user.id);
    expect(factory.mock.calls[0][1].authorityKey).toContain(account.revisionId);
    await db.transaction().execute(async (tx) => {
      await factory.mock.calls[0][1].assertAuthority(tx);
      await db.transaction().execute(async (otherTx) => {
        const {
          rows: [config],
        } = await sql<{
          acquired: boolean;
        }>`select pg_try_advisory_xact_lock(hashtextextended(${EFFECTIVE_CONFIG_LOCK},0)) acquired`.execute(otherTx);
        expect(config.acquired).toBe(false);
        const {
          rows: [route],
        } = await sql<{
          acquired: boolean;
        }>`select pg_try_advisory_xact_lock(hashtextextended('frameleaf:ml-route:' || ${MlWorkload.Clip}::text,0)) acquired`.execute(
          otherTx,
        );
        expect(route.acquired).toBe(false);
      });
    });
    await routes.update(destination.id, { enabled: false });
    await expect(factory.mock.calls[0][1].assertAuthority()).rejects.toThrow('desktop_pool_destination_changed');
    await routes.update(destination.id, { enabled: true });
    await routes.clearRoute(MlWorkload.Clip);
    await expect(factory.mock.calls[0][1].assertAuthority()).rejects.toThrow('desktop_pool_route_changed');
  });
});
