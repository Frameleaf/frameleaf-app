import { LoginResponseDto } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/** FL-71: the Command Center Overview's readiness data and the server name (CC-4, CC-9). */
describe('admin readiness', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    user = await utils.userSetup(admin.accessToken, createUserDto.user1);
  });

  describe('server name (CC-4)', () => {
    it('is empty until an administrator names the server, then shown in the server config', async () => {
      const before = await request(app).get('/server/config');
      expect(before.body.serverName).toBe('');

      const { body: config } = await request(app)
        .get('/system-config')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      await request(app)
        .put('/system-config')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ...config, server: { ...config.server, name: '  Home archive  ' } })
        .expect(200);

      const after = await request(app).get('/server/config');
      expect(after.body.serverName).toBe('Home archive');
    });
  });

  describe('backup restore verification (CC-9)', () => {
    it('is due until a restore test is recorded, and records the administrator', async () => {
      const before = await request(app)
        .get('/admin/database-backups/restore-verification')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(before.status).toBe(200);
      expect(before.body).toEqual(expect.objectContaining({ overdue: true, metadataVerifiedAt: null }));

      const after = await request(app)
        .post('/admin/database-backups/restore-verification')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ metadata: true, originals: true });
      expect(after.status).toBe(200);
      expect(after.body).toEqual(
        expect.objectContaining({ overdue: false, verifiedBy: { id: admin.userId, name: expect.any(String) } }),
      );
    });

    it('is for administrators only', async () => {
      const { status } = await request(app)
        .get('/admin/database-backups/restore-verification')
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(403);
    });
  });

  describe('render worker compatibility (CC-9)', () => {
    it('lists every render kind as unavailable without an admitted worker', async () => {
      const { status, body } = await request(app)
        .get('/admin/render-workers/compatibility')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);
      expect(body.qualified).toEqual([]);
      expect(body.unavailable.length).toBeGreaterThan(0);
    });
  });

  describe('queue statistics for an account (J-1)', () => {
    it("counts one account's jobs, for administrators only", async () => {
      const { status, body } = await request(app)
        .get('/queues/thumbnailGeneration/statistics')
        .query({ ownerId: user.userId })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ failed: expect.any(Number), truncated: false }));

      const forbidden = await request(app)
        .get('/queues/thumbnailGeneration/statistics')
        .query({ ownerId: user.userId })
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(forbidden.status).toBe(403);
    });
  });

  describe('change history (CC-10)', () => {
    it("records each account's own preference changes and serves them to that account only", async () => {
      await request(app)
        .put('/users/me/preferences')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ memories: { enabled: false } })
        .expect(200);

      const own = await request(app)
        .get('/users/me/preferences/history')
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(own.status).toBe(200);
      expect(own.body.entries[0].changes).toEqual(
        expect.arrayContaining([{ path: 'memories.enabled', before: 'true', after: 'false' }]),
      );

      const admins = await request(app)
        .get('/users/me/preferences/history')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(admins.body.entries).toEqual([]);
    });

    it('titles a review entry in the settings history', async () => {
      const { body } = await request(app)
        .get('/admin/config/history')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(body.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'review', title: 'Reviewed: Recovery readiness' })]),
      );
    });
  });
});
