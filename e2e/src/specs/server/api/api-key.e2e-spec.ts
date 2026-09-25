import { LoginResponseDto, Permission, createApiKey } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { errorDto } from 'src/responses.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const create = (accessToken: string, permissions: Permission[]) =>
  createApiKey({ apiKeyCreateDto: { name: 'api key', permissions } }, { headers: asBearerAuth(accessToken) });

describe('/api-keys', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();

    admin = await utils.adminSetup();
    user = await utils.userSetup(admin.accessToken, createUserDto.user1);
  });

  beforeEach(async () => {
    await utils.resetDatabase(['api_key']);
  });

  describe('POST /api-keys', () => {
    it('should work with apiKey.create', async () => {
      const { secret } = await create(user.accessToken, [Permission.ApiKeyCreate, Permission.ApiKeyRead]);
      const { status, body } = await request(app)
        .post('/api-keys')
        .set('x-api-key', secret)
        .send({
          name: 'API Key',
          permissions: [Permission.ApiKeyRead],
        });
      expect(body).toEqual({
        id: expect.any(String),
        name: 'API Key',
        permissions: [Permission.ApiKeyRead],
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        secret: expect.any(String),
        // TODO: remove in v4
        apiKey: expect.any(Object),
      });
      expect(status).toBe(201);
    });

    it('should not create an api key with all permissions', async () => {
      const { secret } = await create(user.accessToken, [Permission.ApiKeyCreate]);
      const { status, body } = await request(app)
        .post('/api-keys')
        .set('x-api-key', secret)
        .send({ name: 'API Key', permissions: [Permission.All] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Cannot grant permissions you do not have'));
    });

    it('should not create an api key with more permissions', async () => {
      const { secret } = await create(user.accessToken, [Permission.ApiKeyCreate]);
      const { status, body } = await request(app)
        .post('/api-keys')
        .set('x-api-key', secret)
        .send({ name: 'API Key', permissions: [Permission.ApiKeyRead] });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Cannot grant permissions you do not have'));
    });

    it('should create an api key', async () => {
      const { status, body } = await request(app)
        .post('/api-keys')
        .send({ name: 'API Key', permissions: [Permission.All] })
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(body).toEqual({
        id: expect.any(String),
        name: 'API Key',
        permissions: [Permission.All],
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        secret: expect.any(String),
        // TODO: remove in v4
        apiKey: expect.any(Object),
      });
      expect(status).toEqual(201);
    });
  });

  describe('GET /api-keys', () => {
    it('should start off empty', async () => {
      const { status, body } = await request(app).get('/api-keys').set('Authorization', `Bearer ${admin.accessToken}`);
      expect(body).toEqual([]);
      expect(status).toEqual(200);
    });

    it('should return a list of api keys', async () => {
      const [apiKey1, apiKey2, apiKey3] = await Promise.all([
        create(admin.accessToken, [Permission.All]),
        create(admin.accessToken, [Permission.All]),
        create(admin.accessToken, [Permission.All]),
      ]);

      const { status, body } = await request(app).get('/api-keys').set('Authorization', `Bearer ${admin.accessToken}`);
      expect(body).toHaveLength(3);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: apiKey1.id }),
          expect.objectContaining({ id: apiKey2.id }),
          expect.objectContaining({ id: apiKey3.id }),
        ]),
      );
      expect(status).toEqual(200);
    });
  });

  describe('GET /api-keys/:id', () => {
    it('should get api key details', async () => {
      const { id } = await create(user.accessToken, [Permission.All]);
      const { status, body } = await request(app)
        .get(`/api-keys/${id}`)
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual({
        id: expect.any(String),
        name: 'api key',
        permissions: [Permission.All],
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });
  });

  describe('PUT /api-keys/:id', () => {
    it('should update api key details', async () => {
      const { id } = await create(user.accessToken, [Permission.All]);
      const { status, body } = await request(app)
        .put(`/api-keys/${id}`)
        .send({
          name: 'new name',
          permissions: [Permission.ActivityCreate, Permission.ActivityRead, Permission.ActivityUpdate],
        })
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual({
        id: expect.any(String),
        name: 'new name',
        permissions: [Permission.ActivityCreate, Permission.ActivityRead, Permission.ActivityUpdate],
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });
  });

  describe('POST /api-keys/:id/rotate', () => {
    // FL-67: rotating a key reveals a new secret and the previous secret stops working at once
    it('should invalidate the old secret and accept the new one', async () => {
      const { id, secret: oldSecret } = await create(user.accessToken, [Permission.All]);
      const before = await request(app).get('/users/me').set('x-api-key', oldSecret);
      expect(before.status).toBe(200);

      const { status, body } = await request(app)
        .post(`/api-keys/${id}/rotate`)
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(201);
      expect(body).toMatchObject({ id, secret: expect.any(String) });
      expect(body.secret).not.toBe(oldSecret);

      const oldResponse = await request(app).get('/users/me').set('x-api-key', oldSecret);
      expect(oldResponse.status).toBe(401);
      expect(oldResponse.body).toEqual(errorDto.badRequest('Invalid API key'));

      const newResponse = await request(app).get('/users/me').set('x-api-key', body.secret);
      expect(newResponse.status).toBe(200);
      expect(newResponse.body).toMatchObject({ id: user.userId });
    });
  });

  describe('DELETE /api-keys/:id', () => {
    it('should delete an api key', async () => {
      const { id } = await create(user.accessToken, [Permission.All]);
      const { status } = await request(app)
        .delete(`/api-keys/${id}`)
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(204);
    });
  });

  describe('authentication', () => {
    it('should work as a header', async () => {
      const { secret } = await create(user.accessToken, [Permission.All]);
      const { status, body } = await request(app).get('/api-keys').set('x-api-key', secret);
      expect(body).toHaveLength(1);
      expect(status).toBe(200);
    });

    it('should work as a query param', async () => {
      const { secret } = await create(user.accessToken, [Permission.All]);
      const { status, body } = await request(app).get(`/api-keys?apiKey=${secret}`);
      expect(body).toHaveLength(1);
      expect(status).toBe(200);
    });
  });
});
