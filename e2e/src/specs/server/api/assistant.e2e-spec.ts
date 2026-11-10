import { LoginResponseDto, SharedLinkType } from '@frameleaf/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/** FL-885: the Library Assistant answers with the rules when no planner model is installed. */
describe('/assistant', () => {
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let favorite: { id: string };
  let other: { id: string };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    owner = await utils.userSetup(admin.accessToken, createUserDto.user1);
    favorite = await utils.createAsset(owner.accessToken, { isFavorite: true });
    other = await utils.createAsset(owner.accessToken);
    await utils.createAsset(admin.accessToken, { isFavorite: true });
  });

  describe('POST /assistant/ask', () => {
    it('requires authentication', async () => {
      const { status } = await request(app).post('/assistant/ask').send({ query: 'my favorites' });
      expect(status).toBe(401);
    });

    it('answers with the rules and says why each item matched', async () => {
      const { status, body } = await request(app)
        .post('/assistant/ask')
        .set(asBearerAuth(owner.accessToken))
        .send({ query: 'my favorites' });

      expect(status).toBe(200);
      expect(body.answeredBy).toBe('rules');
      expect(body.plan).toMatchObject({ favorite: true });
      // only the asker's own favorite: not the other item, never the administrator's
      expect(body.results.assets.items.map(({ id }: { id: string }) => id)).toEqual([favorite.id]);
      expect(body.results.assets.items.map(({ id }: { id: string }) => id)).not.toContain(other.id);
      expect(body.reasons).toEqual([
        { assetId: favorite.id, items: [{ kind: 'favorite', text: 'In your favorites' }] },
      ]);
    });

    it('is not available from a shared link', async () => {
      const share = await utils.createSharedLink(owner.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [favorite.id],
      });
      const { status } = await request(app)
        .post('/assistant/ask')
        .query({ key: share.key })
        .send({ query: 'my favorites' });
      expect(status).toBe(403);
    });
  });
});
