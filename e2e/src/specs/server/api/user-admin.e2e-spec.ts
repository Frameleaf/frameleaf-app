import {
  LoginResponseDto,
  QueueName,
  createStack,
  deleteUserAdmin,
  getMyUser,
  getUserAdmin,
  getUserPreferencesAdmin,
  login,
  type SessionResponseDto,
} from '@immich/sdk';
import { Socket } from 'socket.io-client';
import { createUserDto } from 'src/fixtures.js';
import { errorDto } from 'src/responses.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The id of the session a token belongs to, as the owner's own session list reports it. */
const currentSessionId = async (accessToken: string) => {
  const { status, body } = await request(app).get('/sessions').set('Authorization', `Bearer ${accessToken}`);
  expect(status).toBe(200);
  const session = (body as SessionResponseDto[]).find(({ current }) => current);
  expect(session).toBeDefined();
  return session!.id;
};

describe('/admin/users', () => {
  let websocket: Socket;

  let admin: LoginResponseDto;
  let nonAdmin: LoginResponseDto;
  let deletedUser: LoginResponseDto;
  let userToDelete: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });

    [websocket, nonAdmin, deletedUser, userToDelete] = await Promise.all([
      utils.connectWebsocket(admin.accessToken),
      utils.userSetup(admin.accessToken, createUserDto.user1),
      utils.userSetup(admin.accessToken, createUserDto.user2),
      utils.userSetup(admin.accessToken, createUserDto.user3),
    ]);

    await deleteUserAdmin(
      { id: deletedUser.userId, userAdminDeleteDto: {} },
      { headers: asBearerAuth(admin.accessToken) },
    );
  });

  afterAll(() => {
    utils.disconnectWebsocket(websocket);
  });

  describe('GET /admin/users', () => {
    it('should hide deleted users by default', async () => {
      const { status, body } = await request(app)
        .get(`/admin/users`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);
      expect(body).toHaveLength(3);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ email: admin.userEmail }),
          expect.objectContaining({ email: nonAdmin.userEmail }),
          expect.objectContaining({ email: userToDelete.userEmail }),
        ]),
      );
    });

    it('should include deleted users', async () => {
      const { status, body } = await request(app)
        .get(`/admin/users?withDeleted=true`)
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toHaveLength(4);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ email: admin.userEmail }),
          expect.objectContaining({ email: nonAdmin.userEmail }),
          expect.objectContaining({ email: userToDelete.userEmail }),
          expect.objectContaining({ email: deletedUser.userEmail }),
        ]),
      );
    });
  });

  describe('POST /admin/users', () => {
    it('should accept `isAdmin`', async () => {
      const { status, body } = await request(app)
        .post(`/admin/users`)
        .send({
          isAdmin: true,
          email: 'user5@example.com',
          password: 'password123',
          name: 'Immich',
        })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(body).toMatchObject({
        email: 'user5@example.com',
        isAdmin: true,
        shouldChangePassword: true,
      });
      expect(status).toBe(201);
    });
  });

  describe('PUT /admin/users/:id', () => {
    it('should allow a non-admin to become an admin', async () => {
      const user = await utils.userSetup(admin.accessToken, createUserDto.create('admin2'));
      const { status, body } = await request(app)
        .put(`/admin/users/${user.userId}`)
        .send({ isAdmin: true })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toMatchObject({ isAdmin: true });
    });

    it('ignores updates to profileImagePath', async () => {
      const { status, body } = await request(app)
        .put(`/admin/users/${admin.userId}`)
        .send({ profileImagePath: 'invalid.jpg' })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toMatchObject({ id: admin.userId, profileImagePath: '' });
    });

    it('should update first and last name', async () => {
      const before = await getUserAdmin({ id: admin.userId }, { headers: asBearerAuth(admin.accessToken) });

      const { status, body } = await request(app)
        .put(`/admin/users/${admin.userId}`)
        .send({ name: 'Name' })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual({
        ...before,
        updatedAt: expect.any(String),
        name: 'Name',
      });
      expect(before.updatedAt).not.toEqual(body.updatedAt);
    });

    it('should update password', async () => {
      const { status, body } = await request(app)
        .put(`/admin/users/${nonAdmin.userId}`)
        .send({ password: 'super-secret' })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toMatchObject({ email: nonAdmin.userEmail });

      const token = await login({ loginCredentialDto: { email: nonAdmin.userEmail, password: 'super-secret' } });
      expect(token.accessToken).toBeDefined();

      const user = await getMyUser({ headers: asBearerAuth(token.accessToken) });
      expect(user).toMatchObject({ email: nonAdmin.userEmail });
    });

    it('should update the avatar color', async () => {
      const { status, body } = await request(app)
        .put(`/admin/users/${admin.userId}`)
        .send({ avatarColor: 'orange' })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toMatchObject({ avatarColor: 'orange' });

      const after = await getUserAdmin({ id: admin.userId }, { headers: asBearerAuth(admin.accessToken) });
      expect(after).toMatchObject({ avatarColor: 'orange' });
    });
  });

  describe('GET /admin/users/:id/pin-code (FL-76)', () => {
    it('says whether a PIN is set, never the PIN', async () => {
      const before = await request(app)
        .get(`/admin/users/${nonAdmin.userId}/pin-code`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(before.status).toBe(200);
      expect(before.body).toEqual({ pinCode: false });

      await request(app)
        .put(`/admin/users/${nonAdmin.userId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ pinCode: '123456' });

      const after = await request(app)
        .get(`/admin/users/${nonAdmin.userId}/pin-code`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(after.body).toEqual({ pinCode: true });

      await request(app)
        .put(`/admin/users/${nonAdmin.userId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ pinCode: null });
    });

    it('is for administrators only', async () => {
      const { status } = await request(app)
        .get(`/admin/users/${nonAdmin.userId}/pin-code`)
        .set('Authorization', `Bearer ${nonAdmin.accessToken}`);
      expect(status).toBe(403);
    });
  });

  describe('PUT /admin/users/:id/preferences', () => {
    it('should update memories enabled', async () => {
      const before = await getUserPreferencesAdmin({ id: admin.userId }, { headers: asBearerAuth(admin.accessToken) });
      expect(before).toMatchObject({ memories: { enabled: true } });

      const { status, body } = await request(app)
        .put(`/admin/users/${admin.userId}/preferences`)
        .send({ memories: { enabled: false } })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toMatchObject({ memories: { enabled: false } });

      const after = await getUserPreferencesAdmin({ id: admin.userId }, { headers: asBearerAuth(admin.accessToken) });
      expect(after).toMatchObject({ memories: { enabled: false } });
    });

    it('should update download archive size', async () => {
      const { status, body } = await request(app)
        .put(`/admin/users/${admin.userId}/preferences`)
        .send({ download: { archiveSize: 1_234_567 } })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toMatchObject({ download: { archiveSize: 1_234_567 } });

      const after = await getUserPreferencesAdmin({ id: admin.userId }, { headers: asBearerAuth(admin.accessToken) });
      expect(after).toMatchObject({ download: { archiveSize: 1_234_567 } });
    });
  });

  describe('DELETE /admin/users/:id', () => {
    it('should delete user', async () => {
      const { status, body } = await request(app)
        .delete(`/admin/users/${userToDelete.userId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({});

      expect(status).toBe(200);
      expect(body).toMatchObject({
        id: userToDelete.userId,
        updatedAt: expect.any(String),
        deletedAt: expect.any(String),
      });
    });

    it('should hard delete a user', async () => {
      const user = await utils.userSetup(admin.accessToken, createUserDto.create('hard-delete-1'));

      const { status, body } = await request(app)
        .delete(`/admin/users/${user.userId}`)
        .send({ force: true })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toMatchObject({
        id: user.userId,
        updatedAt: expect.any(String),
        deletedAt: expect.any(String),
      });

      await utils.waitForWebsocketEvent({ event: 'userDelete', id: user.userId, timeout: 5000 });
    });

    it('should hard delete a user with stacked assets', async () => {
      const user = await utils.userSetup(admin.accessToken, createUserDto.create('hard-delete-1'));

      const [asset1, asset2] = await Promise.all([
        utils.createAsset(user.accessToken),
        utils.createAsset(user.accessToken),
      ]);

      await createStack(
        { stackCreateDto: { assetIds: [asset1.id, asset2.id] } },
        { headers: asBearerAuth(user.accessToken) },
      );

      await utils.waitForQueueFinish(admin.accessToken, QueueName.BackgroundTask);

      const { status, body } = await request(app)
        .delete(`/admin/users/${user.userId}`)
        .send({ force: true })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toMatchObject({
        id: user.userId,
        updatedAt: expect.any(String),
        deletedAt: expect.any(String),
      });

      await utils.waitForWebsocketEvent({ event: 'userDelete', id: user.userId, timeout: 5000 });
    });
  });

  describe('POST /admin/users/:id/restore', () => {
    it('should restore a user', async () => {
      const user = await utils.userSetup(admin.accessToken, createUserDto.create('restore'));

      await deleteUserAdmin({ id: user.userId, userAdminDeleteDto: {} }, { headers: asBearerAuth(admin.accessToken) });

      const { status, body } = await request(app)
        .post(`/admin/users/${user.userId}/restore`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual(
        expect.objectContaining({
          id: user.userId,
          email: user.userEmail,
          status: 'active',
          deletedAt: null,
        }),
      );
    });
  });

  describe('POST /admin/users (FL-76 create-time secrets and labels)', () => {
    // FL-76: a PIN given at creation is stored so the new account can unlock Locked content with it.
    it('creates an account whose initial PIN unlocks its session, and refuses a wrong PIN', async () => {
      const dto = { ...createUserDto.create('fl76-create-pin'), pinCode: '123456' };
      const created = await request(app)
        .post('/admin/users')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(dto);
      expect(created.status).toBe(201);

      const state = await request(app)
        .get(`/admin/users/${created.body.id}/pin-code`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(state.body).toEqual({ pinCode: true });

      const { accessToken } = await login({ loginCredentialDto: { email: dto.email, password: dto.password } });

      const unlocked = await request(app)
        .post('/auth/session/unlock')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ pinCode: '123456' });
      expect(unlocked.status).toBe(204);

      // the wrong attempt comes last: failures are throttled per account
      const wrong = await request(app)
        .post('/auth/session/unlock')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ pinCode: '654321' });
      expect(wrong.status).toBe(400);
      expect(wrong.body).toEqual(errorDto.badRequest('Wrong PIN code'));
    });

    // FL-76: two accounts never share a storage label; the create path refuses it like update does.
    it('refuses a storage label another account already has', async () => {
      const first = await request(app)
        .post('/admin/users')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ...createUserDto.create('fl76-label-a'), storageLabel: 'fl76-shared-label' });
      expect(first.status).toBe(201);

      const { status, body } = await request(app)
        .post('/admin/users')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ...createUserDto.create('fl76-label-b'), storageLabel: 'fl76-shared-label' });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Storage label already in use by another account'));
    });
  });

  describe('DELETE /admin/users/:id/sessions/:sessionId (FL-76)', () => {
    // FL-76: signing a device out is an administrator action only.
    it('is for administrators only', async () => {
      const user = await utils.userSetup(admin.accessToken, createUserDto.create('fl76-session-forbidden'));
      const sessionId = await currentSessionId(user.accessToken);

      const { status } = await request(app)
        .delete(`/admin/users/${user.userId}/sessions/${sessionId}`)
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(403);
    });

    // FL-76: the session must belong to the account named in the path.
    it('refuses a session of a different account than the one named', async () => {
      const [owner, other] = await Promise.all([
        utils.userSetup(admin.accessToken, createUserDto.create('fl76-session-owner')),
        utils.userSetup(admin.accessToken, createUserDto.create('fl76-session-other')),
      ]);
      const otherSessionId = await currentSessionId(other.accessToken);

      const { status, body } = await request(app)
        .delete(`/admin/users/${owner.userId}/sessions/${otherSessionId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(404);
      expect(body).toEqual(errorDto.notFound('Session not found'));

      // the other account's device is still signed in
      const me = await request(app).get('/users/me').set('Authorization', `Bearer ${other.accessToken}`);
      expect(me.status).toBe(200);
    });

    // FL-76: revoking the named account's own session signs that device out.
    it("signs out the named account's session", async () => {
      const user = await utils.userSetup(admin.accessToken, createUserDto.create('fl76-session-revoke'));
      const sessionId = await currentSessionId(user.accessToken);

      const { status } = await request(app)
        .delete(`/admin/users/${user.userId}/sessions/${sessionId}`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(204);

      const me = await request(app).get('/users/me').set('Authorization', `Bearer ${user.accessToken}`);
      expect(me.status).toBe(401);
    });
  });
});
