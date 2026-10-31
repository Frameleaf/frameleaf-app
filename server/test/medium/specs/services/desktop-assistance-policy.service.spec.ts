import { type Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { SystemMetadataKey } from 'src/enum.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { mediumFactory } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let metadata: SystemMetadataRepository;
let service: DesktopAssistancePolicyService;
beforeEach(async () => {
  db = await getKyselyDB();
  metadata = new SystemMetadataRepository(db);
  service = new DesktopAssistancePolicyService(metadata);
});
afterEach(async () => db.destroy());
it('serializes concurrent account choices without losing either account or changing a revision', async () => {
  const a = randomUUID();
  const b = randomUUID();
  const choices = await Promise.all(Array.from({ length: 8 }, (_, i) => service.enable(i % 2 ? a : b)));
  expect(new Set(choices.filter((_, i) => i % 2).map((choice) => choice.revisionId)).size).toBe(1);
  const restarted = new DesktopAssistancePolicyService(new SystemMetadataRepository(db));
  expect(await restarted.read(a)).toEqual(choices[1]);
  expect(await restarted.read(b)).toEqual(choices[0]);
  expect(Object.keys((await metadata.get(SystemMetadataKey.FrameleafDesktopAssistance))!.accounts)).toHaveLength(2);
});
it('preserves the chosen pool after the last helper pauses or is revoked', async () => {
  const user = await mediumFactory.userWithClusterGroup(db);
  await new UserRepository(db).create(user);
  const devices = new DesktopDeviceRepository(db);
  const device = await devices.enroll({
    userId: user.id,
    installationId: randomUUID(),
    publicKey: Buffer.alloc(32).toString('base64'),
    name: 'synthetic helper',
    platform: 'macos',
    architecture: 'arm64',
    mode: 'client-worker',
    state: 'preparing',
  });
  const choice = await service.enable(user.id);
  expect(await devices.endSession(user.id, device!.id)).toBe(true);
  expect(await service.read(user.id)).toEqual(choice);
  expect(await devices.revoke(user.id, device!.id)).toBe(true);
  expect(await service.read(user.id)).toEqual(choice);
});
it('refuses corrupt policy in the database and never overwrites it during enrollment retry', async () => {
  const corrupted = { version: 99, accounts: {} };
  await db
    .insertInto('system_metadata')
    .values({ key: SystemMetadataKey.FrameleafDesktopAssistance, value: corrupted as never })
    .execute();
  await expect(service.enable(randomUUID())).rejects.toThrow('desktop_pool_policy_invalid');
  expect(await metadata.get(SystemMetadataKey.FrameleafDesktopAssistance)).toEqual(corrupted);
});
