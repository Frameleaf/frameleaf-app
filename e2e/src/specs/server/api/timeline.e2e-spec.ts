import { AssetVisibility, LoginResponseDto } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

describe('/timeline', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    user = await utils.userSetup(admin.accessToken, createUserDto.user1);

    for (const fileCreatedAt of ['2024-03-02T10:00:00.000Z', '2024-03-20T10:00:00.000Z', '2023-07-01T10:00:00.000Z']) {
      await utils.createAsset(admin.accessToken, { fileCreatedAt });
    }
    await utils.createAsset(user.accessToken, { fileCreatedAt: '2024-03-05T10:00:00.000Z' });
  });

  describe('GET /timeline/highlights (FL-33)', () => {
    it('should require authentication', async () => {
      const { status } = await request(app).get('/timeline/highlights');
      expect(status).toBe(401);
    });

    it('should return one card per month that reconciles to the buckets', async () => {
      const [highlights, buckets] = await Promise.all([
        request(app).get('/timeline/highlights').set('Authorization', `Bearer ${admin.accessToken}`),
        request(app).get('/timeline/buckets').set('Authorization', `Bearer ${admin.accessToken}`),
      ]);

      expect(highlights.status).toBe(200);
      expect(highlights.body).toEqual([
        {
          timeBucket: '2024-03-01',
          count: 2,
          keyAssetId: expect.any(String),
          highlightAssetIds: [expect.any(String)],
          places: expect.any(Array),
        },
        {
          timeBucket: '2023-07-01',
          count: 1,
          keyAssetId: expect.any(String),
          highlightAssetIds: [],
          places: expect.any(Array),
        },
      ]);
      expect(highlights.body.map(({ timeBucket, count }: any) => ({ timeBucket, count }))).toEqual(buckets.body);
    });

    it('should group by year without highlights', async () => {
      const { status, body } = await request(app)
        .get('/timeline/highlights')
        .query({ grouping: 'year', highlightCount: 5 })
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(
        body.map(({ timeBucket, count, highlightAssetIds }: any) => [timeBucket, count, highlightAssetIds]),
      ).toEqual([
        ['2024-01-01', 2, []],
        ['2023-01-01', 1, []],
      ]);
    });

    it("should not include another user's media", async () => {
      const { body } = await request(app)
        .get('/timeline/highlights')
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(body).toEqual([expect.objectContaining({ timeBucket: '2024-03-01', count: 1 })]);
    });

    it('should require an elevated session for Locked highlights', async () => {
      const { status } = await request(app)
        .get('/timeline/highlights')
        .query({ visibility: AssetVisibility.Locked })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(401);
    });

    it('should reject an unknown grouping', async () => {
      const { status } = await request(app)
        .get('/timeline/highlights')
        .query({ grouping: 'week' })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(400);
    });
  });
});
