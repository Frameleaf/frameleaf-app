import { LoginResponseDto } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const total = (rows: Array<{ count: number }>) => rows.reduce((sum, { count }) => sum + count, 0);

describe('/analytics', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    user = await utils.userSetup(admin.accessToken, createUserDto.user1);
    for (const fileCreatedAt of ['2024-03-02T10:00:00.000Z', '2025-07-01T18:00:00.000Z']) {
      await utils.createAsset(user.accessToken, { fileCreatedAt });
    }
  });

  describe('GET /analytics insights (FL-79)', () => {
    it('should reconcile every breakdown to the summary for the account itself', async () => {
      const { status, body } = await request(app)
        .get('/analytics')
        .query({ scope: `account:${user.userId}` })
        .set('Authorization', `Bearer ${user.accessToken}`);

      expect(status).toBe(200);
      const { summary, insights } = body;
      expect(summary.items).toBe(2);
      expect(total(insights.capturesByYear)).toBe(summary.items);
      expect(insights.punchcard).toHaveLength(168);
      expect(total(insights.punchcard)).toBe(summary.items);
      expect(total(insights.lenses)).toBe(summary.items);
      expect(total(insights.focalLengths)).toBe(summary.items);
      expect(total(insights.orientation)).toBe(summary.items);
      expect(total(insights.photoFormats)).toBe(summary.photos);
      expect(total(insights.videoResolutions)).toBe(summary.videos);
      expect(total(body.cameras)).toBe(summary.items - insights.hiddenItems);
      expect(insights.coverage.facesChecked).toBeLessThanOrEqual(summary.items);
      expect(insights.coverage.searchIndexed).toBeLessThanOrEqual(summary.items);
      // the volume breakdown and database size are for the administrator's whole-server report only
      expect(body.host.breakdown).toBeNull();
      expect(insights.peopleAndPlaces).not.toBeNull();
      expect(insights.peopleAndPlaces.itemsWithFaces + insights.peopleAndPlaces.itemsWithoutFaces).toBe(summary.items);
      expect(insights.records.oldestCapture.name).toEqual(expect.any(String));
    });

    it('should not tell an administrator the people, places or file names of another account', async () => {
      const { status, body } = await request(app)
        .get('/analytics')
        .query({ scope: `account:${user.userId}` })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body.insights.peopleAndPlaces).toBeNull();
      expect(body.insights.records.oldestCapture).toEqual({ date: expect.any(String), name: null });
    });

    it('should break the volume down for the whole server so the parts add up to the volume used', async () => {
      const { status, body } = await request(app)
        .get('/analytics')
        .query({ scope: 'all' })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);
      const { host } = body;
      expect(host.breakdown).not.toBeNull();
      const { originalsBytes, previewsBytes, encodedVideoBytes, databaseBytes, otherBytes, exceedsUsed } =
        host.breakdown;
      expect(databaseBytes).toBeGreaterThan(0);
      if (!exceedsUsed) {
        expect(originalsBytes + (previewsBytes ?? 0) + (encodedVideoBytes ?? 0) + databaseBytes + otherBytes).toBe(
          host.volumeUsedBytes,
        );
      }
    });

    it('should keep the whole server for administrators', async () => {
      const { status } = await request(app)
        .get('/analytics')
        .query({ scope: 'all' })
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(403);
    });
  });
});
