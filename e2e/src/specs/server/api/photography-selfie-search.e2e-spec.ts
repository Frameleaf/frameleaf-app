import { createAlbum, type LoginResponseDto } from '@frameleaf/sdk';
import { randomUUID } from 'node:crypto';
import { makeRandomImage } from 'src/generators.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, it } from 'vitest';

describe('Clients selfie search', () => {
  let studio: LoginResponseDto;
  let gallery: string;

  beforeAll(async () => {
    await utils.resetDatabase();
    studio = await utils.adminSetup({ onboarding: false });
    const album = await createAlbum(
      { createAlbumDto: { albumName: 'Event' } },
      { headers: asBearerAuth(studio.accessToken) },
    );
    gallery = randomUUID();
    await request(app)
      .put('/photography/shoots')
      .set(asBearerAuth(studio.accessToken))
      .send({
        expectedRevision: null,
        shoots: [
          {
            id: gallery,
            albumId: album.id,
            name: 'Event',
            client: 'Guest',
            type: 'Event',
            date: '2026-11-12',
            stage: 'Imported',
          },
        ],
      })
      .expect(200);
  });

  it('requires a gallery session independently of the server session', async () => {
    await request(app)
      .post(`/photography/galleries/${gallery}/selfie-search`)
      .set(asBearerAuth(studio.accessToken))
      .attach('file', makeRandomImage(), 'guest.png')
      .expect(403);
  });
});
