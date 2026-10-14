import { Kysely, sql } from 'kysely';
import { cloneDeep } from 'lodash-es';
import { createHash } from 'node:crypto';
import { defaults } from 'src/dtos/config.dto.js';
import { AssetLockReason, SystemMetadataKey } from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { down, up } from 'src/schema/migrations/2100000002968-FrameleafLockReason.js';
import { BaseService } from 'src/services/base.service.js';
import { initializeEffectiveConfig, readConfig } from 'src/utils/config.js';
import { canonicalJson } from 'src/utils/object.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;

beforeAll(async () => {
  database = await getKyselyDB();
});

afterAll(async () => {
  await database?.destroy();
});

it('renames existing lock reasons without changing lock ownership or visibility, and supports reversal', async () => {
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const [{ asset: folderAsset }, { asset: markedAsset }] = await Promise.all([
    ctx.newAsset({ ownerId: user.id }),
    ctx.newAsset({ ownerId: user.id }),
  ]);
  await database
    .insertInto('asset_lock')
    .values([
      { assetId: folderAsset.id, reason: 'immich-locked-folder' as AssetLockReason, lockedBy: user.id },
      { assetId: markedAsset.id, reason: AssetLockReason.Marked, lockedBy: user.id },
    ])
    .execute();
  const read = () => database.selectFrom('asset_lock').selectAll().orderBy('assetId').execute();
  const before = await read();

  await up(database);
  await up(database);
  expect(await read()).toEqual(
    before.map((lock) => ({
      ...lock,
      reason: lock.assetId === folderAsset.id ? AssetLockReason.FrameleafLockedFolder : lock.reason,
    })),
  );

  await down(database);
  expect(await read()).toEqual(before);
});

it('materializes omitted old defaults while preserving an approved database epoch and custom mappings', async () => {
  const legacy = cloneDeep(defaults);
  legacy.machineLearning.urls = ['http://immich-machine-learning:3003'];
  legacy.oauth.roleClaim = 'immich_role';
  legacy.oauth.storageQuotaClaim = 'immich_quota';
  legacy.oauth.enabled = true;
  legacy.oauth.issuerUrl = 'https://issuer.example';
  legacy.oauth.clientId = 'existing-provider';
  const partial = { oauth: { enabled: true, issuerUrl: legacy.oauth.issuerUrl, clientId: legacy.oauth.clientId } };
  const epoch = {
    format: 1,
    epoch: 1,
    sourceKind: 'database',
    digest: createHash('sha256').update(canonicalJson(legacy)).digest('hex'),
    trashEnabled: legacy.trash.enabled,
  };
  await sql`INSERT INTO public.system_metadata (key, value) VALUES
    ('system-config', ${partial}::jsonb),
    ('effective-config-epoch', ${epoch}::jsonb)`.execute(database);
  const { ctx } = newMediumService(BaseService, {
    database,
    real: [SystemMetadataRepository],
    mock: [ConfigRepository, LoggingRepository],
  });
  ctx.getMock(ConfigRepository).getEnv.mockReturnValue(mockEnvData({}));
  const repos = {
    configRepo: ctx.getMock(ConfigRepository) as unknown as ConfigRepository,
    metadataRepo: ctx.get(SystemMetadataRepository),
    logger: ctx.getMock(LoggingRepository) as unknown as LoggingRepository,
  };

  await up(database);
  await expect(initializeEffectiveConfig(repos)).resolves.toBeUndefined();
  expect(await readConfig(repos)).toEqual(legacy);
  expect(await repos.metadataRepo.getEffectiveConfigEpoch()).toEqual(epoch);

  await sql`UPDATE public.system_metadata SET value =
    ${{ oauth: { roleClaim: 'custom-role', storageQuotaClaim: 'custom-quota' }, machineLearning: { urls: ['http://custom:3003'] } }}::jsonb
    WHERE key = 'system-config'`.execute(database);
  await up(database);
  expect(await repos.metadataRepo.get(SystemMetadataKey.SystemConfig)).toMatchObject({
    oauth: { roleClaim: 'custom-role', storageQuotaClaim: 'custom-quota' },
    machineLearning: { urls: ['http://custom:3003'] },
  });
});
