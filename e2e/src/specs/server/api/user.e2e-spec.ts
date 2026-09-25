import { LoginResponseDto, getMyUser, login } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { errorDto } from 'src/responses.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const setPreferences = (accessToken: string, body: object) =>
  request(app).put('/users/me/preferences').set('Authorization', `Bearer ${accessToken}`).send(body);
const getPreferences = (accessToken: string) =>
  request(app).get('/users/me/preferences').set('Authorization', `Bearer ${accessToken}`);
const lock = (accessToken: string) =>
  request(app).post('/auth/session/lock').set('Authorization', `Bearer ${accessToken}`);
const unlockSession = (accessToken: string, pinCode: string) =>
  request(app).post('/auth/session/unlock').set('Authorization', `Bearer ${accessToken}`).send({ pinCode });

describe('/users', () => {
  let admin: LoginResponseDto;
  let nonAdmin: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    nonAdmin = await utils.userSetup(admin.accessToken, createUserDto.user2);
  });

  describe('PUT /users/me', () => {
    /** @deprecated */
    it('should allow a user to change their password (deprecated)', async () => {
      const user = await getMyUser({ headers: asBearerAuth(nonAdmin.accessToken) });

      expect(user.shouldChangePassword).toBe(true);

      const { status, body } = await request(app)
        .put(`/users/me`)
        .send({ password: 'super-secret' })
        .set('Authorization', `Bearer ${nonAdmin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toMatchObject({
        email: nonAdmin.userEmail,
        shouldChangePassword: false,
      });

      const token = await login({ loginCredentialDto: { email: nonAdmin.userEmail, password: 'super-secret' } });

      expect(token.accessToken).toBeDefined();
    });
  });

  describe('PUT /users/me/preferences savedSearches (FL-49)', () => {
    it('should store saved searches and hide them from an administrator', async () => {
      const savedSearches = [{ name: 'Beach', query: { filter: { city: { eq: 'Lisbon' } } } }];
      const { status, body } = await request(app)
        .put('/users/me/preferences')
        .send({ savedSearches })
        .set('Authorization', `Bearer ${nonAdmin.accessToken}`);
      expect(status).toBe(200);
      expect(body.savedSearches).toEqual(savedSearches);

      const adminView = await request(app)
        .get(`/admin/users/${nonAdmin.userId}/preferences`)
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(adminView.status).toBe(200);
      expect(adminView.body.savedSearches).toEqual([]);
    });

    it('should reject duplicate names', async () => {
      const { status } = await request(app)
        .put('/users/me/preferences')
        .send({
          savedSearches: [
            { name: 'A', query: {} },
            { name: 'a', query: {} },
          ],
        })
        .set('Authorization', `Bearer ${nonAdmin.accessToken}`);
      expect(status).toBe(400);
    });
  });

  describe('PUT /users/me/preferences Locked rules (FL-67)', () => {
    const password = 'locked-rules-password';
    const pinCode = '246810';
    let owner: LoginResponseDto;
    let tagId: string;

    const unlock = (accessToken: string) => unlockSession(accessToken, pinCode);

    beforeAll(async () => {
      owner = await utils.userSetup(admin.accessToken, {
        email: 'locked-rules@immich.cloud',
        name: 'Locked Rules',
        password,
      });
      const setup = await request(app)
        .post('/auth/pin-code')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ pinCode });
      expect(setup.status).toBe(204);
      const [tag] = await utils.upsertTags(owner.accessToken, ['FL-67 Locked']);
      tagId = tag.id;
    });

    // FL-67: Locked rules change only from an unlocked session
    it('should refuse a Locked rules change from a session that is not unlocked', async () => {
      await lock(owner.accessToken);
      const { status, body } = await setPreferences(owner.accessToken, {
        privacy: { suppression: { tagIds: [tagId] } },
      });
      expect(status).toBe(403);
      expect(body).toEqual(errorDto.badRequest('Unlock with your PIN before changing Locked rules'));
    });

    // FL-67: an unlocked session saves against the current revision; a save against a stale revision
    // is refused (409) and does not overwrite the newer rules
    it('should save with the current revision and refuse a stale revision', async () => {
      const unlocked = await unlock(owner.accessToken);
      expect(unlocked.status).toBe(204);

      const loaded = await getPreferences(owner.accessToken);
      expect(loaded.status).toBe(200);
      const staleRevision = loaded.body.revision;
      expect(staleRevision).toEqual(expect.any(String));

      const saved = await setPreferences(owner.accessToken, {
        expectedRevision: staleRevision,
        privacy: { suppression: { tagIds: [tagId] } },
      });
      expect(saved.status).toBe(200);
      expect(saved.body.privacy.suppression.tagIds).toEqual([tagId]);
      expect(saved.body.revision).not.toBe(staleRevision);

      const conflict = await setPreferences(owner.accessToken, {
        expectedRevision: staleRevision,
        privacy: { suppression: { tagIds: [] } },
      });
      expect(conflict.status).toBe(409);
      expect(conflict.body).toEqual(
        errorDto.badRequest(
          'These preferences changed after they were loaded. Load the latest preferences and try again.',
        ),
      );

      const after = await getPreferences(owner.accessToken);
      expect(after.body.privacy.suppression.tagIds).toEqual([tagId]);
    });

    // FL-67: a session that is not unlocked reads the Locked rule ids blanked; the scope stays
    it('should blank the Locked rule ids for a session that is not unlocked', async () => {
      const unlocked = await unlock(owner.accessToken);
      expect(unlocked.status).toBe(204);
      await setPreferences(owner.accessToken, { privacy: { suppression: { tagIds: [tagId], scope: 'owned' } } });

      const otherDevice = await login({ loginCredentialDto: { email: 'locked-rules@immich.cloud', password } });
      const { status, body } = await getPreferences(otherDevice.accessToken);
      expect(status).toBe(200);
      expect(body.privacy.suppression).toEqual({ tagIds: [], personIds: [], petIds: [], scope: 'owned' });

      await lock(owner.accessToken);
      const locked = await getPreferences(owner.accessToken);
      expect(locked.body.privacy.suppression.tagIds).toEqual([]);

      const unlockedAgain = await unlock(owner.accessToken);
      expect(unlockedAgain.status).toBe(204);
      const revealed = await getPreferences(owner.accessToken);
      expect(revealed.body.privacy.suppression.tagIds).toEqual([tagId]);
    });
  });
});
