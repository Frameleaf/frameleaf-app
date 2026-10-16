import { ConflictException } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DB } from 'src/schema/index.js';
import { defaults } from 'src/config.js';
import { MlDestinationKind, MlWorkload, SystemMetadataKey } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { DesktopWorkerRepository } from 'src/repositories/desktop-worker.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DesktopAssistanceActivationService } from 'src/services/desktop-assistance-activation.service.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { DesktopNasProducerService } from 'src/services/desktop-nas-producer.service.js';
import { seedDesktopQualification } from 'test/desktop-qualification.js';
import { mediumFactory } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const space = JSON.parse(
  readFileSync(new URL('../../../../resources/desktop/model-spaces.json', import.meta.url), 'utf8'),
).spaces[0];
const catalogue = JSON.parse(
  readFileSync(new URL('../../../../resources/desktop/model-catalogue.json', import.meta.url), 'utf8'),
);
const profile = catalogue.profiles.find((p: { modelKey: string }) => p.modelKey === space.visualModelKey);
let db: Kysely<DB>;
beforeEach(async () => {
  db = await getKyselyDB();
  for (const table of [
    'smart_search',
    'smart_search_description',
    'asset_video_duplicate_frame',
    'video_moment_frame_embedding',
  ])
    await sql`ALTER TABLE ${sql.table(table)} ALTER COLUMN embedding TYPE vector(768)`.execute(db);
});
afterEach(async () => db.destroy());
const setup = async (consent = true) => {
  const user = await mediumFactory.userWithClusterGroup(db, { isAdmin: true });
  await new UserRepository(db).create(user);
  const photo = await new SessionRepository(db).create({ userId: user.id, token: Buffer.alloc(32, 1) });
  const devices = new DesktopDeviceRepository(db);
  const device = (await devices.enroll({
    userId: user.id,
    installationId: randomUUID(),
    publicKey: Buffer.alloc(32, 2).toString('base64'),
    name: 'activation fixture',
    platform: 'linux',
    architecture: 'x86_64',
    mode: 'client-worker',
    state: 'preparing',
  }))!;
  const workers = new DesktopWorkerRepository(db);
  const session = (await workers.issue({
    deviceId: device.id,
    authorizationEpoch: device.authorizationEpoch,
    photoSessionId: photo.id,
    tokenHash: Buffer.alloc(32, 3),
    modelKeys: [],
  }))!;
  const grant = (await workers.consume(session.id, session.tokenHash, 1))!;
  const qualification = await seedDesktopQualification(db, grant, {
    modelKey: profile.modelKey,
    config: profile.spec.entries,
    inputKind: 'image',
  });
  const metadata = new SystemMetadataRepository(db);
  const policies = new DesktopAssistancePolicyService(metadata);
  if (consent) await policies.enable(user.id);
  const routes = new MlDestinationRepository(db);
  const destination = await routes.create({
    kind: MlDestinationKind.Local,
    name: 'synthetic NAS',
    url: 'https://unused.invalid',
    authToken: null,
    enabled: true,
    workloads: [MlWorkload.Clip],
    budgetLimitUsd: null,
    maxRuntimeMinutes: null,
    maxUploadBytes: null,
  });
  await routes.setDefaultRoute(MlWorkload.Clip, destination.id);
  const route = (await routes.getRouteStates()).find((route) => route.workload === MlWorkload.Clip)!;
  const proof = {
    spaceKey: space.spaceKey,
    modelKeys: [space.visualModelKey, ...space.textModelKeys],
    routeRevisionId: route.revisionId,
    selection: {
      destinationId: destination.id,
      kind: MlDestinationKind.Local,
      workload: MlWorkload.Clip,
      endpoint: { url: destination.url!, assertAuthority: () => Promise.resolve() },
      record: () => {},
    },
    assertCurrent: vi.fn().mockResolvedValue(undefined),
  };
  const nas = { verify: vi.fn().mockResolvedValue(proof) };
  const index = new DesktopClipIndexRepository(db);
  const service = new DesktopAssistanceActivationService(workers, index, nas as never, policies, metadata, routes);
  return {
    user,
    devices,
    device,
    workers,
    session,
    grant,
    qualification,
    metadata,
    policies,
    routes,
    destination,
    proof,
    nas,
    index,
    service,
  };
};
it('atomically admits the paired index and grants only the accepted model', async () => {
  const f = await setup();
  await f.service.activate(f.grant, f.qualification, space.spaceKey);
  expect((await f.index.getActive())?.space.spaceKey).toBe(space.spaceKey);
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([space.visualModelKey]);
  await f.service.activate(f.grant, f.qualification, space.spaceKey);
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([space.visualModelKey]);
});
it('keeps the index unadmitted and scope empty when consent is absent', async () => {
  const f = await setup(false);
  await expect(f.service.activate(f.grant, f.qualification, space.spaceKey)).rejects.toThrow(
    'desktop_pool_policy_required',
  );
  expect(await f.index.getActive()).toBeUndefined();
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([]);
});
it.each(['revoke', 'expiry', 'credential'])(
  'rolls back index admission when %s invalidates the helper before grant',
  async (reason) => {
    const f = await setup();
    f.proof.assertCurrent.mockImplementationOnce(async () => {
      if (reason === 'revoke') await f.devices.revoke(f.user.id, f.device.id);
      else if (reason === 'credential') await f.workers.rotate(f.grant, f.session.tokenHash, Buffer.alloc(32, 4));
      else
        await sql`UPDATE desktop_worker_qualification SET "createdAt"=now()-interval '2 hours', "expiresAt"=now()-interval '1 hour' WHERE id=${f.qualification.id}::uuid`.execute(
          db,
        );
    });
    await expect(f.service.activate(f.grant, f.qualification, space.spaceKey)).rejects.toThrow(
      'desktop_worker_activation_invalid',
    );
    expect(await f.index.getActive()).toBeUndefined();
    const { rows } = await sql`SELECT "modelKeys" FROM desktop_worker_session WHERE id=${f.session.id}::uuid`.execute(
      db,
    );
    expect(rows).toEqual([{ modelKeys: [] }]);
  },
);
it('rechecks consent after NAS verification before making any grant', async () => {
  const f = await setup();
  f.nas.verify.mockImplementationOnce(async () => {
    await f.metadata.withConfigTransaction((metadata) =>
      metadata.set(SystemMetadataKey.FrameleafDesktopAssistance, { version: 1, accounts: {} }),
    );
    return f.proof;
  });
  await expect(f.service.activate(f.grant, f.qualification, space.spaceKey)).rejects.toThrow(
    'desktop_pool_policy_changed',
  );
  expect(await f.index.getActive()).toBeUndefined();
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([]);
});
it('preserves a route pinned while qualification was in progress', async () => {
  const f = await setup();
  await f.routes.setRoute(MlWorkload.Clip, f.destination.id);
  await expect(f.service.activate(f.grant, f.qualification, space.spaceKey)).rejects.toThrow(
    'desktop_pool_route_changed',
  );
  expect(await f.index.getActive()).toBeUndefined();
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([]);
});

it('preserves unknown legacy vectors when index admission is incompatible', async () => {
  const f = await setup();
  const asset = await new AssetRepository(db).create(mediumFactory.assetInsert({ ownerId: f.user.id }));
  const vector = JSON.stringify(Array.from({ length: 768 }, () => 0.1));
  await sql`INSERT INTO smart_search ("assetId", embedding) VALUES (${asset.id}::uuid, ${vector}::vector)`.execute(db);
  const refused = f.service.activate(f.grant, f.qualification, space.spaceKey);
  await expect(refused).rejects.toThrow('desktop_clip_index_incompatible');
  await expect(refused).rejects.toBeInstanceOf(ConflictException);
  expect(await f.index.getActive()).toBeUndefined();
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([]);
  expect(
    await db.selectFrom('smart_search').select('producerModelKey').where('assetId', '=', asset.id).executeTakeFirst(),
  ).toEqual({ producerModelKey: null });
});

it('uses the real NAS verifier in the activation transaction without a second-connection lock deadlock', async () => {
  const f = await setup();
  const settings = structuredClone(defaults);
  settings.machineLearning.enabled = true;
  settings.machineLearning.clip.enabled = true;
  settings.machineLearning.clip.modelName = profile.modelName;
  settings.machineLearning.urls = [f.destination.url!];
  await f.metadata.withConfigTransaction((metadata) => metadata.set(SystemMetadataKey.SystemConfig, settings));
  const machineLearning = {
    probe: () =>
      Promise.resolve({
        reachable: true,
        workloads: [MlWorkload.Clip],
        hardware: null,
        latencyMs: 1,
        probedAt: new Date(),
        error: null,
      }),
    encodeBoundClip: (_selection: unknown, _payload: unknown, selected: typeof profile) =>
      Promise.resolve({ embedding: selected.spec.expectedOutput.clip, modelKey: selected.modelKey }),
  };
  const nas = new DesktopNasProducerService(
    machineLearning as never,
    f.routes,
    f.index,
    new ConfigRepository(),
    f.metadata,
  );
  const service = new DesktopAssistanceActivationService(f.workers, f.index, nas, f.policies, f.metadata, f.routes);
  await service.activate(f.grant, f.qualification, space.spaceKey);
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([space.visualModelKey]);
  expect((await f.index.getActive())?.space.spaceKey).toBe(space.spaceKey);
});

it('adds separately accepted paired roles and drops expired previous scope', async () => {
  const f = await setup();
  await f.service.activate(f.grant, f.qualification, space.spaceKey);
  const text = catalogue.profiles.find((p: { modelKey: string }) => p.modelKey === space.textModelKeys[0]);
  const accepted = await seedDesktopQualification(db, f.grant, {
    modelKey: text.modelKey,
    config: text.spec.entries,
    inputKind: 'text',
  });
  await f.service.activate(f.grant, accepted, space.spaceKey);
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual(
    [space.visualModelKey, text.modelKey].sort((a: string, b: string) => a.localeCompare(b)),
  );
  await sql`UPDATE desktop_worker_qualification SET "createdAt"=now()-interval '2 hours', "expiresAt"=now()-interval '1 hour' WHERE id=${f.qualification.id}::uuid`.execute(
    db,
  );
  await f.service.activate(f.grant, accepted, space.spaceKey);
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([text.modelKey]);
});

it('reports NAS verification unavailability as a setup conflict without a grant', async () => {
  const f = await setup();
  f.nas.verify.mockRejectedValueOnce(new Error('private fixture network failure'));
  const refused = f.service.activate(f.grant, f.qualification, space.spaceKey);
  await expect(refused).rejects.toThrow('desktop_nas_producer_unavailable');
  await expect(refused).rejects.toBeInstanceOf(ConflictException);
  expect(await f.index.getActive()).toBeUndefined();
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([]);
});
