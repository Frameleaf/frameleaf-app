import { LoginResponseDto, getMyUser, login } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

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
});
