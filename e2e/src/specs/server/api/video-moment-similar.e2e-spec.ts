import { LoginResponseDto } from '@immich/sdk';
import { errorDto } from 'src/responses.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FL-59 frame-to-moment search. The stack has no video frames or search model in e2e, so this
 * covers the route's contract: it needs a signed-in account, validates its frame id and limit, and
 * answers a frame nobody may read exactly like a frame that does not exist. Ranking, Locked and
 * owner rules are covered against a real database by the server medium spec.
 */
describe('/enrichment/frames/:id/similar', () => {
  let admin: LoginResponseDto;
  const frameId = '01923456-789a-7bcd-8ef0-123456789abc';

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  it('requires authentication', async () => {
    const { status } = await request(app).get(`/enrichment/frames/${frameId}/similar`);
    expect(status).toBe(401);
  });

  it('requires a frame id', async () => {
    const { status } = await request(app)
      .get('/enrichment/frames/not-a-frame/similar')
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(status).toBe(400);
  });

  it('refuses a limit outside 1 to 100', async () => {
    const { status } = await request(app)
      .get(`/enrichment/frames/${frameId}/similar`)
      .query({ limit: 101 })
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(status).toBe(400);
  });

  it('answers an unknown frame without saying whether it exists', async () => {
    const { status, body } = await request(app)
      .get(`/enrichment/frames/${frameId}/similar`)
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(status).toBe(400);
    expect(body).toEqual(errorDto.badRequest('Not found or no asset.read access'));
  });
});
