import { ConflictException } from '@nestjs/common';
import { type Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { DB } from 'src/schema/index.js';
import { SystemMetadataKey } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { DesktopWorkerRepository } from 'src/repositories/desktop-worker.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DesktopAssistanceActivationService } from 'src/services/desktop-assistance-activation.service.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
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
  for (const table of ['smart_search', 'smart_search_description', 'video_moment_frame_embedding'])
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
  const metadata = new SystemMetadataRepository(db);
  const policies = new DesktopAssistancePolicyService(metadata);
  await policies.enable(user.id);
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
  if (!consent)
    await metadata.withConfigTransaction((metadata) =>
      metadata.set(SystemMetadataKey.FrameleafDesktopAssistance, { version: 1, accounts: {} }),
    );
  // Stands in for the server's settings check: resolves while they still ask for the qualified profile.
  const assertProfile = vi.fn().mockResolvedValue(undefined);
  const index = new DesktopClipIndexRepository(db);
  const service = new DesktopAssistanceActivationService(workers, index, policies, metadata);
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
    assertProfile,
    index,
    service,
  };
};
const activate = (f: Awaited<ReturnType<typeof setup>>, qualification = f.qualification) =>
  f.service.activate(f.grant, qualification, space.spaceKey, f.assertProfile);

it('atomically admits the paired index and grants only the accepted model, with no route or destination', async () => {
  const f = await setup();
  await activate(f);
  expect((await f.index.getActive())?.space.spaceKey).toBe(space.spaceKey);
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([space.visualModelKey]);
  expect(f.assertProfile).toHaveBeenCalled();
  await activate(f);
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([space.visualModelKey]);
  expect(await db.selectFrom('ml_workload_route').selectAll().execute()).toEqual([]);
});
it('keeps the index unadmitted and scope empty when consent is absent', async () => {
  const f = await setup(false);
  await expect(activate(f)).rejects.toThrow('desktop_pool_policy_required');
  expect(await f.index.getActive()).toBeUndefined();
  expect(await f.workers.session(f.session.id, f.session.tokenHash)).toBeUndefined();
});
it.each(['revoke', 'expiry', 'credential'])(
  'rolls back index admission when %s invalidates the helper before grant',
  async (reason) => {
    const f = await setup();
    // The credential rotates before activation starts; the others change while the grant is being written.
    if (reason === 'credential') await f.workers.rotate(f.grant, f.session.tokenHash, Buffer.alloc(32, 4));
    f.assertProfile.mockImplementationOnce(async () => {
      if (reason === 'revoke') await f.devices.revoke(f.user.id, f.device.id);
      else if (reason === 'expiry')
        await sql`UPDATE desktop_worker_qualification SET "createdAt"=now()-interval '2 hours', "expiresAt"=now()-interval '1 hour' WHERE id=${f.qualification.id}::uuid`.execute(
          db,
        );
    });
    await expect(activate(f)).rejects.toThrow('desktop_worker_activation_invalid');
    expect(await f.index.getActive()).toBeUndefined();
    const { rows } = await sql`SELECT "modelKeys" FROM desktop_worker_session WHERE id=${f.session.id}::uuid`.execute(
      db,
    );
    expect(rows).toEqual([{ modelKeys: [] }]);
  },
);
it('rechecks consent inside the grant transaction', async () => {
  const f = await setup();
  const policy = await f.policies.read(f.user.id);
  vi.spyOn(f.policies, 'read').mockResolvedValueOnce(policy);
  await f.metadata.withConfigTransaction((metadata) =>
    metadata.set(SystemMetadataKey.FrameleafDesktopAssistance, { version: 1, accounts: {} }),
  );
  await expect(activate(f)).rejects.toThrow('desktop_pool_policy_changed');
  expect(await f.index.getActive()).toBeUndefined();
  expect(await f.workers.session(f.session.id, f.session.tokenHash)).toBeUndefined();
});
it('grants nothing when the settings stopped asking for the profile', async () => {
  const f = await setup();
  f.assertProfile.mockRejectedValue(new ConflictException('desktop_model_profile_changed'));
  const refused = activate(f);
  await expect(refused).rejects.toThrow('desktop_model_profile_changed');
  await expect(refused).rejects.toBeInstanceOf(ConflictException);
  expect(await f.index.getActive()).toBeUndefined();
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([]);
});

it('preserves unknown legacy vectors when index admission is incompatible', async () => {
  const f = await setup();
  const asset = await new AssetRepository(db).create(mediumFactory.assetInsert({ ownerId: f.user.id }));
  const vector = JSON.stringify(Array.from({ length: 768 }, () => 0.1));
  await sql`INSERT INTO smart_search ("assetId", embedding) VALUES (${asset.id}::uuid, ${vector}::vector)`.execute(db);
  const refused = activate(f);
  await expect(refused).rejects.toThrow('desktop_clip_index_incompatible');
  await expect(refused).rejects.toBeInstanceOf(ConflictException);
  expect(await f.index.getActive()).toBeUndefined();
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([]);
  expect(
    await db.selectFrom('smart_search').select('producerModelKey').where('assetId', '=', asset.id).executeTakeFirst(),
  ).toEqual({ producerModelKey: null });
});

it('adds separately accepted paired roles and drops expired previous scope', async () => {
  const f = await setup();
  await activate(f);
  const text = catalogue.profiles.find((p: { modelKey: string }) => p.modelKey === space.textModelKeys[0]);
  const accepted = await seedDesktopQualification(db, f.grant, {
    modelKey: text.modelKey,
    config: text.spec.entries,
    inputKind: 'text',
  });
  await activate(f, accepted);
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual(
    [space.visualModelKey, text.modelKey].sort((a: string, b: string) => a.localeCompare(b)),
  );
  await sql`UPDATE desktop_worker_qualification SET "createdAt"=now()-interval '2 hours', "expiresAt"=now()-interval '1 hour' WHERE id=${f.qualification.id}::uuid`.execute(
    db,
  );
  await activate(f, accepted);
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([text.modelKey]);
});

it.each(['ocr', 'face'])('grants a %s model without CLIP inference or index admission', async (workload) => {
  const f = await setup();
  const selected = JSON.parse(readFileSync(`test/fixtures/desktop-${workload}-profile.json`, 'utf8'));
  const qualification = await seedDesktopQualification(db, f.grant, {
    modelKey: selected.modelKey,
    config: selected.spec.entries,
    inputKind: 'image',
  });
  await f.service.activateModel(f.grant, qualification, selected.modelKey, f.assertProfile);
  expect((await f.workers.session(f.session.id, f.session.tokenHash))?.modelKeys).toEqual([selected.modelKey]);
  expect(await f.index.getActive()).toBeUndefined();
  await expect(f.service.activateModel(f.grant, qualification, space.visualModelKey, f.assertProfile)).rejects.toThrow(
    'desktop_pool_model_unavailable',
  );
  f.assertProfile.mockRejectedValue(new ConflictException('desktop_model_profile_changed'));
  await expect(f.service.activateModel(f.grant, qualification, selected.modelKey, f.assertProfile)).rejects.toThrow(
    'desktop_model_profile_changed',
  );
});
