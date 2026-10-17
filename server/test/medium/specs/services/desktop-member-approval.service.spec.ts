import { type Kysely } from 'kysely';
import request from 'supertest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { DB } from 'src/schema/index.js';
import { DesktopDeviceController } from 'src/controllers/desktop-device.controller.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { DesktopDeviceService } from 'src/services/desktop-device.service.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { mediumFactory } from 'test/medium.factory.js';
import { controllerSetup, getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeEach(async () => {
  db = await getKyselyDB();
});
afterEach(async () => db.destroy());
const setup = async () => {
  const users = new UserRepository(db);
  const admin = await users.create(await mediumFactory.userWithClusterGroup(db, { isAdmin: true }));
  const member = await users.create(await mediumFactory.userWithClusterGroup(db, { isAdmin: false }));
  const session = await new SessionRepository(db).create({ userId: admin.id, token: Buffer.alloc(32, 7) });
  return {
    admin,
    member,
    auth: { user: admin, session: { ...session, hasElevatedPermission: false } } as AuthDto,
    policies: new DesktopAssistancePolicyService(new SystemMetadataRepository(db)),
  };
};
it('defaults to denied, requires explicit approval and preserves approval identity on retries', async () => {
  const { auth, member, policies } = await setup();
  expect(await policies.readMemberApproval(auth, member.id)).toEqual({ enabled: false });
  expect(await policies.setMemberApproval(auth, member.id, true)).toEqual({ enabled: true });
  const first = await policies.read(member.id);
  expect(first?.memberApproved).toBe(true);
  await policies.setMemberApproval(auth, member.id, true);
  expect(await policies.read(member.id)).toEqual(first);
  await policies.setMemberApproval(auth, member.id, false);
  expect(await policies.read(member.id)).toBeUndefined();
});
it('refuses members, API keys, cross-account sessions and stale administrator claims', async () => {
  const { auth, member, policies } = await setup();
  await expect(policies.setMemberApproval({ ...auth, user: member }, member.id, true)).rejects.toThrow();
  await expect(policies.setMemberApproval({ ...auth, apiKey: {} } as AuthDto, member.id, true)).rejects.toThrow();
  const other = await setup();
  await expect(policies.setMemberApproval({ ...auth, session: other.auth.session }, member.id, true)).rejects.toThrow();
  await db.updateTable('user').set({ isAdmin: false }).where('id', '=', auth.user.id).execute();
  await expect(policies.setMemberApproval(auth, member.id, true)).rejects.toThrow();
  expect(await policies.read(member.id)).toBeUndefined();
});
it('does not grant account policy through a dead photo session or for an administrator target', async () => {
  const { admin, auth, member, policies } = await setup();
  await expect(policies.setMemberApproval(auth, admin.id, true)).rejects.toThrow('desktop_member_account_required');
  await db.deleteFrom('session').where('id', '=', auth.session!.id).execute();
  await expect(policies.setMemberApproval(auth, member.id, true)).rejects.toThrow();
  expect(await policies.read(member.id)).toBeUndefined();
});

it('enforces real member and stale-administrator refusal through the HTTP controller', async () => {
  const { auth, member, policies } = await setup();
  const http = await controllerSetup(DesktopDeviceController, [
    { provide: DesktopDeviceService, useValue: {} },
    { provide: DesktopWorkerAuthService, useValue: {} },
    { provide: DesktopAssistancePolicyService, useValue: policies },
  ]);
  try {
    http.authenticate.mockResolvedValue(auth);
    const url = `/desktop/accounts/${member.id}/approval`;
    expect((await request(http.getHttpServer()).put(url).send({ enabled: true })).status).toBe(200);
    http.authenticate.mockResolvedValue({ ...auth, user: member });
    expect((await request(http.getHttpServer()).put(url).send({ enabled: false })).status).toBe(403);
    http.authenticate.mockResolvedValue(auth);
    await db.updateTable('user').set({ isAdmin: false }).where('id', '=', auth.user.id).execute();
    expect((await request(http.getHttpServer()).put(url).send({ enabled: false })).status).toBe(403);
    expect((await policies.read(member.id))?.memberApproved).toBe(true);
  } finally {
    await http.close();
  }
});
