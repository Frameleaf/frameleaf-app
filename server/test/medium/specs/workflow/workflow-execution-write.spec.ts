import { WorkflowTrigger } from '@immich/plugin-sdk';
import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AssetMetadataKey, AssetVisibility, JobStatus, WorkflowType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PluginRepository } from 'src/repositories/plugin.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { WorkflowRepository } from 'src/repositories/workflow.repository.js';
import { DB } from 'src/schema/index.js';
import { WorkflowExecutionService } from 'src/services/workflow-execution.service.js';
import { MediumTestContext } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Exercises the asset-write restriction of the workflow execution pipeline
 * WITHOUT the wasm core plugin: `PluginRepository` is mocked so
 * `callMethod` can return an arbitrary fake plugin result, while everything
 * from the trigger handler through `isWorkflowEligible` down to
 * `AssetService.update` runs for real. This keeps the suite runnable in
 * environments without an extism-js install (unlike workflow-core-plugin.spec).
 */
class WorkflowWriteTestContext extends MediumTestContext<typeof WorkflowExecutionService> {
  constructor(database: Kysely<DB>) {
    super(WorkflowExecutionService, {
      database,
      real: [
        AccessRepository,
        AlbumRepository,
        AssetRepository,
        CryptoRepository,
        DatabaseRepository,
        LoggingRepository,
        StorageRepository,
        UserRepository,
        WorkflowRepository,
      ],
      mock: [
        ConfigRepository,
        EventRepository,
        JobRepository,
        PluginRepository,
        SystemMetadataRepository,
        WebsocketRepository,
      ],
    });
  }

  async init() {
    this.getMock(ConfigRepository).getEnv.mockReturnValue(mockEnvData({}));
    // Defaults for machineLearning config (imageDescription.enabled=true), so
    // the eligibility gate requires enrichment metadata — same as production.
    this.getMock(SystemMetadataRepository).get.mockResolvedValue(null);
    this.getMock(EventRepository).emit.mockResolvedValue();
    this.getMock(WebsocketRepository).clientSend.mockReturnValue();
    this.getMock(PluginRepository).getForLoad.mockResolvedValue([]);
    // sets the jwt secret used to sign the per-run auth token
    await this.sut.onPluginLoad();
  }
}

const createWorkflow = async (ctx: WorkflowWriteTestContext, ownerId: string) => {
  const pluginId = randomUUID();
  const methodId = randomUUID();
  await sql`
    INSERT INTO public.plugin
      (id, enabled, name, version, title, description, author, "wasmBytes", templates, "sha256hash")
    VALUES (${pluginId}::uuid, true, ${`write-restriction-${pluginId}`}, '1.0.0', 'Write restriction',
      'Write restriction fixture', 'Immich', decode('00', 'hex'), '[]'::jsonb, ${createHash('sha256').update('00').digest()})
  `.execute(ctx.database);
  await sql`
    INSERT INTO public.plugin_method
      (id, "pluginId", name, title, description, types, "hostFunctions", "uiHints", schema)
    VALUES (${methodId}::uuid, ${pluginId}::uuid, 'fakeAssetWriter', 'Fake asset writer', 'Fake asset writer fixture',
      ARRAY[${WorkflowType.AssetV1}]::varchar[], false, ARRAY[]::varchar[], NULL)
  `.execute(ctx.database);

  const stepId = randomUUID();
  // the plugin repository is mocked: what the run checks the definition against (FL-82)
  ctx.getMock(PluginRepository).getForValidation.mockResolvedValue([
    {
      id: methodId,
      name: 'fakeAssetWriter',
      pluginName: `write-restriction-${pluginId}`,
      types: [WorkflowType.AssetV1],
      schema: null,
    },
  ]);
  return ctx.get(WorkflowRepository).create(
    {
      enabled: true,
      name: 'Write restriction workflow',
      ownerId,
      trigger: WorkflowTrigger.AssetCreate,
    },
    {
      version: 1,
      trigger: WorkflowTrigger.AssetCreate,
      extra: {},
      steps: [
        { id: stepId, method: `write-restriction-${pluginId}#fakeAssetWriter`, config: {}, enabled: true, extra: {} },
      ],
    },
    [{ id: stepId, order: 0, enabled: true, pluginMethodId: methodId, config: {} }],
  );
};

const newEligibleAsset = async (
  ctx: WorkflowWriteTestContext,
  dto: { ownerId: string; visibility?: AssetVisibility },
) => {
  const { asset } = await ctx.newAsset(dto);
  await ctx.newMetadata({
    assetId: asset.id,
    key: AssetMetadataKey.MlEnrichment,
    value: { nsfwDetection: { status: 'success', result: { isNsfw: false } } },
  });
  return asset;
};

const getAssetRow = (ctx: WorkflowWriteTestContext, id: string) =>
  ctx.database
    .selectFrom('asset')
    .select(['visibility', 'isFavorite', 'ownerId', 'originalPath'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

const newContext = async () => {
  const ctx = new WorkflowWriteTestContext(await getKyselyDB());
  await ctx.init();
  return ctx;
};

describe('workflow execution write restriction', () => {
  it('never lets a plugin result touch a Hidden asset: the run is skipped before write', async () => {
    const ctx = await newContext();
    const { user } = await ctx.newUser();
    const asset = await newEligibleAsset(ctx, { ownerId: user.id, visibility: AssetVisibility.Hidden });
    const workflow = await createWorkflow(ctx, user.id);
    ctx
      .getMock(PluginRepository)
      .callMethod.mockResolvedValue({ changes: { asset: { visibility: AssetVisibility.Timeline } } });

    await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBe(
      JobStatus.Skipped,
    );

    expect(ctx.getMock(PluginRepository).callMethod).not.toHaveBeenCalled();
    await expect(getAssetRow(ctx, asset.id)).resolves.toMatchObject({ visibility: AssetVisibility.Hidden });
  });

  it('applies only allow-listed fields from a plugin result', async () => {
    const ctx = await newContext();
    const { user } = await ctx.newUser();
    const { user: otherUser } = await ctx.newUser();
    const asset = await newEligibleAsset(ctx, { ownerId: user.id });
    const workflow = await createWorkflow(ctx, user.id);
    ctx.getMock(PluginRepository).callMethod.mockResolvedValue({
      changes: {
        asset: {
          isFavorite: true,
          visibility: AssetVisibility.Timeline,
          // none of these are in the applied-fields allow-list in
          // workflow-execution.service.ts and must be ignored
          ownerId: otherUser.id,
          originalPath: '/tmp/hijacked.jpg',
          checksum: 'ffff',
        },
      },
    });

    await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();

    expect(ctx.getMock(PluginRepository).callMethod).toHaveBeenCalledTimes(1);
    await expect(getAssetRow(ctx, asset.id)).resolves.toMatchObject({
      isFavorite: true,
      visibility: AssetVisibility.Timeline,
      ownerId: user.id,
      originalPath: asset.originalPath,
    });
  });

  it('visibility IS allow-listed for eligible assets (assetArchive contract)', async () => {
    // Documents that the allow-list deliberately includes `visibility` — the
    // core plugin's archive/lock methods work by returning a visibility
    // change. Hidden/Locked assets are protected by the eligibility gate (see
    // above), not by stripping visibility from the write.
    const ctx = await newContext();
    const { user } = await ctx.newUser();
    const asset = await newEligibleAsset(ctx, { ownerId: user.id });
    const workflow = await createWorkflow(ctx, user.id);
    ctx
      .getMock(PluginRepository)
      .callMethod.mockResolvedValue({ changes: { asset: { visibility: AssetVisibility.Archive } } });

    await expect(ctx.sut.handleAssetTrigger({ workflowId: workflow.id, assetId: asset.id })).resolves.toBeUndefined();

    await expect(getAssetRow(ctx, asset.id)).resolves.toMatchObject({ visibility: AssetVisibility.Archive });
  });
});
