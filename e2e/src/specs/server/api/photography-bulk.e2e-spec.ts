import { createAlbum, type LoginResponseDto } from '@frameleaf/sdk';
import { randomUUID } from 'node:crypto';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

describe('Clients bulk galleries', () => {
  let studio: LoginResponseDto;
  let other: LoginResponseDto;
  let templateId: string;

  beforeAll(async () => {
    await utils.resetDatabase();
    studio = await utils.adminSetup({ onboarding: false });
    other = await utils.userSetup(studio.accessToken, createUserDto.user1);
    const album = await createAlbum(
      { createAlbumDto: { albumName: 'Template' } },
      { headers: asBearerAuth(studio.accessToken) },
    );
    templateId = randomUUID();
    await request(app)
      .put('/photography/shoots')
      .set(asBearerAuth(studio.accessToken))
      .send({
        expectedRevision: null,
        shoots: [
          {
            id: templateId,
            albumId: album.id,
            name: 'Template',
            client: 'Studio',
            type: 'Event',
            date: '2026-11-12',
            stage: 'Imported',
          },
        ],
      })
      .expect(200);
  });

  it('replays the same request without recreating rows and keeps the batch private', async () => {
    const requestId = randomUUID();
    const payload = {
      requestId,
      templateId,
      rows: [{ title: 'Portraits', clientName: 'Morgan', clientEmail: 'morgan@example.test' }],
    };
    const submit = (value = payload) =>
      request(app).post('/photography/shoots/bulk').set(asBearerAuth(studio.accessToken)).send(value);
    const first = await submit().expect(201);
    const second = await submit().expect(201);
    expect(second.body.id).toBe(requestId);
    expect(second.body.rows[0].id).toBe(first.body.rows[0].id);
    await submit({ ...payload, rows: [{ ...payload.rows[0], title: 'Changed' }] }).expect(409);
    await request(app).get(`/photography/shoots/bulk/${requestId}`).set(asBearerAuth(other.accessToken)).expect(404);
    const owner = await request(app)
      .get(`/photography/shoots/bulk/${requestId}`)
      .set(asBearerAuth(studio.accessToken))
      .expect(200);
    expect(owner.headers['cache-control']).toBe('private, no-store');
  });
});
