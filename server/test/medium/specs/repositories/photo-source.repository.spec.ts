import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotoSourceRepository } from 'src/repositories/photo-source.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => db?.destroy());
const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const session = await new SessionRepository(db).create({ userId: user.id, token: Buffer.alloc(32, 7) });
  const devices = new DesktopDeviceRepository(db);
  const device = (await devices.enroll({
    userId: user.id,
    installationId: randomUUID(),
    publicKey: Buffer.alloc(32, 7).toString('base64'),
    name: 'Fixture',
    platform: 'linux',
    architecture: 'x86_64',
    mode: 'client-worker',
    state: 'awaiting-approval',
  }))!;
  const authority = { ownerId: user.id, sessionId: session.id };
  const input = {
    id: randomUUID(),
    deviceId: device.id,
    kind: 'folder' as const,
    mode: 'copy' as const,
    name: 'Folder',
    scopeFingerprint: 'a'.repeat(64),
  };
  const sut = new PhotoSourceRepository(db);
  const source = await sut.create(authority, input);
  return { sut, source, input, authority, devices, device, user };
};
it('photo-copy authority is independent of ML approval and retries preserve one immutable source', async () => {
  const { sut, source, input, authority } = await setup();
  expect(await sut.create(authority, input)).toEqual(source);
  await expect(sut.create(authority, { ...input, scopeFingerprint: 'b'.repeat(64) })).rejects.toThrow();
  expect(await db.selectFrom('photo_source').select('id').where('id', '=', source.id).execute()).toHaveLength(1);
});
it('foreign accounts and dead/expired photo sessions cannot use source authority', async () => {
  const owner = await setup();
  const other = await setup();
  await expect(owner.sut.create(other.authority, owner.input)).rejects.toThrow();
  await expect(
    owner.sut.run(other.authority, owner.source.id, { id: randomUUID(), maxItems: 1, maxBytes: 10 }),
  ).rejects.toThrow();
  await db
    .updateTable('session')
    .set({ expiresAt: new Date(0) })
    .where('id', '=', owner.authority.sessionId)
    .execute();
  await expect(
    owner.sut.run(owner.authority, owner.source.id, { id: randomUUID(), maxItems: 1, maxBytes: 10 }),
  ).rejects.toThrow();
});
it('reserves aggregate item/byte budgets under concurrency and never charges an identical retry twice', async () => {
  const { sut, source, authority } = await setup();
  const run = await sut.run(authority, source.id, { id: randomUUID(), maxItems: 2, maxBytes: 10 });
  const item = {
    id: randomUUID(),
    resourceKey: 'b'.repeat(64),
    version: 'c'.repeat(64),
    sha256: 'd'.repeat(64),
    bytes: 6,
  };
  const results = await Promise.allSettled([
    sut.plan(authority, source.id, run.id, item),
    sut.plan(authority, source.id, run.id, { ...item, id: randomUUID(), resourceKey: 'e'.repeat(64) }),
  ]);
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  const [stored] = await db.selectFrom('photo_source_resource').selectAll().where('runId', '=', run.id).execute();
  const retry = { ...item, id: stored.id, resourceKey: stored.resourceKey };
  expect((await sut.plan(authority, source.id, run.id, retry)).id).toBe(stored.id);
  await expect(sut.plan(authority, source.id, run.id, { ...retry, bytes: 5 })).rejects.toThrow();
  expect(await db.selectFrom('photo_source_resource').select('id').where('runId', '=', run.id).execute()).toHaveLength(
    1,
  );
});
it('revoking a source or ending a desktop association fences pending work without deleting associations', async () => {
  const { sut, source, authority, devices, device, input } = await setup();
  const run = await sut.run(authority, source.id, { id: randomUUID(), maxItems: 2, maxBytes: 10 });
  const item = {
    id: randomUUID(),
    resourceKey: 'b'.repeat(64),
    version: 'c'.repeat(64),
    sha256: 'd'.repeat(64),
    bytes: 6,
  };
  await sut.plan(authority, source.id, run.id, item);
  await devices.endSession(authority.ownerId, device.id);
  await expect(sut.plan(authority, source.id, run.id, item)).rejects.toThrow();
  await sut.revoke(authority, source.id);
  await db.updateTable('desktop_device').set({ state: 'awaiting-approval' }).where('id', '=', device.id).execute();
  await expect(sut.create(authority, input)).rejects.toThrow('photo_source_identity_changed');
  expect(await db.selectFrom('photo_source_resource').select('id').where('id', '=', item.id).execute()).toHaveLength(1);
});
it('paused/cancelled/complete runs cannot accept new items; planned items prevent completion', async () => {
  const { sut, source, authority } = await setup();
  const run = await sut.run(authority, source.id, { id: randomUUID(), maxItems: 2, maxBytes: 10 });
  const item = {
    id: randomUUID(),
    resourceKey: 'b'.repeat(64),
    version: 'c'.repeat(64),
    sha256: 'd'.repeat(64),
    bytes: 6,
  };
  await sut.plan(authority, source.id, run.id, item);
  await expect(
    sut.setState(authority, source.id, run.id, { state: 'complete', inventoryComplete: true }),
  ).rejects.toThrow();
  await sut.setState(authority, source.id, run.id, { state: 'paused', inventoryComplete: false });
  await expect(sut.plan(authority, source.id, run.id, item)).rejects.toThrow();
  await sut.setState(authority, source.id, run.id, { state: 'open', inventoryComplete: false });
  expect((await sut.plan(authority, source.id, run.id, item)).id).toBe(item.id);
  await sut.setState(authority, source.id, run.id, { state: 'cancelled', inventoryComplete: false });
  await expect(
    sut.setState(authority, source.id, run.id, { state: 'open', inventoryComplete: false }),
  ).rejects.toThrow();
});
it('removing ML approval does not revoke the separately approved photo-copy source', async () => {
  const { sut, source, authority, device } = await setup();
  const run = await sut.run(authority, source.id, { id: randomUUID(), maxItems: 1, maxBytes: 10 });
  await db
    .updateTable('desktop_device')
    .set({ authorizationEpoch: device.authorizationEpoch + 1, state: 'awaiting-approval' })
    .where('id', '=', device.id)
    .execute();
  await expect(
    sut.plan(authority, source.id, run.id, {
      id: randomUUID(),
      resourceKey: 'b'.repeat(64),
      version: 'c'.repeat(64),
      sha256: 'd'.repeat(64),
      bytes: 6,
    }),
  ).resolves.toMatchObject({ state: 'planned' });
});
it('recovers a planned resource by its source identity after an item response is lost', async () => {
  const { sut, source, authority } = await setup();
  const run = await sut.run(authority, source.id, { id: randomUUID(), maxItems: 1, maxBytes: 10 });
  const item = {
    id: randomUUID(),
    resourceKey: 'b'.repeat(64),
    version: 'c'.repeat(64),
    sha256: 'd'.repeat(64),
    bytes: 6,
  };
  const first = await sut.plan(authority, source.id, run.id, item);
  expect((await sut.plan(authority, source.id, run.id, { ...item, id: randomUUID() })).id).toBe(first.id);
});
it('fresh photo sign-in explicitly rebinds source consent without losing prior dispositions', async () => {
  const { sut, source, authority, input, user } = await setup();
  const run = await sut.run(authority, source.id, { id: randomUUID(), maxItems: 1, maxBytes: 10 });
  const fresh = await new SessionRepository(db).create({ userId: user.id, token: Buffer.alloc(32, 8) });
  const next = { ownerId: user.id, sessionId: fresh.id };
  await sut.create(next, input);
  await expect(sut.snapshot(authority, source.id, run.id)).rejects.toThrow();
  expect((await sut.snapshot(next, source.id, run.id)).run.id).toBe(run.id);
  await db.deleteFrom('session').where('id', '=', authority.sessionId).execute();
  expect((await sut.snapshot(next, source.id, run.id)).run.id).toBe(run.id);
});
it('an existing item ID cannot be reassigned to another known resource identity', async () => {
  const { sut, source, authority } = await setup();
  const run = await sut.run(authority, source.id, { id: randomUUID(), maxItems: 3, maxBytes: 30 });
  const first = {
    id: randomUUID(),
    resourceKey: '0'.repeat(64),
    version: 'c'.repeat(64),
    sha256: 'd'.repeat(64),
    bytes: 6,
  };
  const second = { ...first, id: randomUUID(), resourceKey: 'f'.repeat(64) };
  await sut.plan(authority, source.id, run.id, first);
  await sut.plan(authority, source.id, run.id, second);
  await expect(sut.plan(authority, source.id, run.id, { ...first, id: second.id })).rejects.toThrow(
    'photo_source_item_changed',
  );
});

it('upload admission binds live photo authority to the exact planned bytes and source run', async () => {
  const { sut, source, authority, device } = await setup();
  const run = await sut.run(authority, source.id, { id: randomUUID(), maxItems: 1, maxBytes: 10 });
  const item = {
    id: randomUUID(),
    resourceKey: 'b'.repeat(64),
    version: 'c'.repeat(64),
    sha256: 'd'.repeat(64),
    bytes: 6,
  };
  await sut.plan(authority, source.id, run.id, item);
  const binding = { kind: 'folder' as const, sourceId: source.id, runId: run.id, itemId: item.id };
  const checksum = Buffer.from(item.sha256, 'hex');
  await expect(sut.assertUpload(authority, binding, checksum, 6)).resolves.toBeUndefined();
  await expect(sut.assertUpload(authority, binding, checksum, undefined)).rejects.toThrow();
  await expect(sut.assertUpload(authority, binding, checksum, 7)).rejects.toThrow();
  await expect(sut.assertUpload(authority, binding, Buffer.alloc(32), 6)).rejects.toThrow();
  await expect(sut.assertUpload(authority, { ...binding, runId: randomUUID() }, checksum, 6)).rejects.toThrow();
  await expect(sut.assertUpload({ ...authority, sessionId: randomUUID() }, binding, checksum, 6)).rejects.toThrow();
  await sut.setState(authority, source.id, run.id, { state: 'paused', inventoryComplete: false });
  await expect(sut.assertUpload(authority, binding, checksum, 6)).rejects.toThrow();
  await sut.setState(authority, source.id, run.id, { state: 'open', inventoryComplete: false });
  await db.updateTable('desktop_device').set({ state: 'paused' }).where('id', '=', device.id).execute();
  await expect(sut.assertUpload(authority, binding, checksum, 6)).rejects.toThrow();
  await db.updateTable('desktop_device').set({ state: 'awaiting-approval' }).where('id', '=', device.id).execute();
  await sut.revoke(authority, source.id);
  await expect(sut.assertUpload(authority, binding, checksum, 6)).rejects.toThrow();
});
