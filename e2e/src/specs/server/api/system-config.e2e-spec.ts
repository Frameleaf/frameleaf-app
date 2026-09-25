import { LoginResponseDto, getConfig } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { errorDto } from 'src/responses.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const getSystemConfig = (accessToken: string) => getConfig({ headers: asBearerAuth(accessToken) });

const getCredentials = async (accessToken: string) => {
  const { status, body } = await request(app)
    .get('/admin/config/credentials')
    .set('Authorization', `Bearer ${accessToken}`);
  expect(status).toBe(200);
  return body as Array<{ name: string; configured: boolean }>;
};

const clearCredential = (accessToken: string, name: string) =>
  request(app).delete(`/admin/config/credentials/${name}`).set('Authorization', `Bearer ${accessToken}`);

describe('/system-config', () => {
  let admin: LoginResponseDto;
  let nonAdmin: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    nonAdmin = await utils.userSetup(admin.accessToken, createUserDto.user1);
  });

  describe('PUT /system-config', () => {
    it('should always return the new config', async () => {
      const config = await getSystemConfig(admin.accessToken);
      const updatedConfig = { ...config, server: { ...config.server, loginPageMessage: 'Updated login message' } };

      const response1 = await request(app)
        .put('/system-config')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(updatedConfig);

      expect(response1.status).toBe(200);
      expect(response1.body).toEqual(updatedConfig);

      const response2 = await request(app)
        .put('/system-config')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(config);

      expect(response2.status).toBe(200);
      expect(response2.body).toEqual(config);
    });

    it('should keep automatic external version checks disabled when requested', async () => {
      const config = await getSystemConfig(admin.accessToken);
      const { status, body } = await request(app)
        .put('/system-config')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ...config, newVersionCheck: { ...config.newVersionCheck, enabled: true } });

      const expectedConfig = { ...config, newVersionCheck: { ...config.newVersionCheck, enabled: false } };
      expect(status).toBe(200);
      expect(body).toEqual(expectedConfig);
      expect(await getSystemConfig(admin.accessToken)).toEqual(expectedConfig);
    });

    it('should reject an invalid config entry', async () => {
      const { status, body } = await request(app)
        .put('/system-config')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({
          ...(await getSystemConfig(admin.accessToken)),
          storageTemplate: { enabled: true, hashVerificationEnabled: true, template: '{{foo}}' },
        });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest(expect.stringContaining('Invalid storage template')));
    });
  });

  describe('/admin/config/credentials', () => {
    const secret = 'fl67-write-only-client-secret';

    // FL-67: the credentials list says which secrets are stored, never their values
    it('should list every credential with its stored state', async () => {
      await clearCredential(admin.accessToken, 'oauth-client-secret');
      const body = await getCredentials(admin.accessToken);
      expect(body).toEqual(
        expect.arrayContaining([
          { name: 'smtp-password', configured: false },
          { name: 'oauth-client-secret', configured: false },
          { name: 'runpod-api-key', configured: false },
          { name: 'huggingface-token', configured: false },
        ]),
      );
      expect(body).toHaveLength(4);
    });

    // FL-67: a stored secret is write-only: the configuration only reports that it is configured
    it('should store a credential without ever returning its value', async () => {
      const { status, body } = await request(app)
        .put('/admin/config/credentials/oauth-client-secret')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ value: secret });
      expect(status).toBe(200);
      expect(body).toEqual({ name: 'oauth-client-secret', configured: true });

      expect(await getCredentials(admin.accessToken)).toContainEqual({ name: 'oauth-client-secret', configured: true });

      const config = await request(app).get('/system-config').set('Authorization', `Bearer ${admin.accessToken}`);
      expect(config.status).toBe(200);
      expect(config.body.oauth).toMatchObject({ clientSecret: '', clientSecretConfigured: true });
      expect(JSON.stringify(config.body)).not.toContain(secret);

      const adminConfig = await request(app).get('/admin/config').set('Authorization', `Bearer ${admin.accessToken}`);
      expect(JSON.stringify(adminConfig.body)).not.toContain(secret);
    });

    // FL-67: a configuration saved from a redacted draft keeps the stored secret
    it('should keep the stored credential when a redacted configuration is saved back', async () => {
      await request(app)
        .put('/admin/config/credentials/oauth-client-secret')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ value: secret });
      const config = await getSystemConfig(admin.accessToken);

      const { status, body } = await request(app)
        .put('/system-config')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send(config);
      expect(status).toBe(200);
      expect(body.oauth).toMatchObject({ clientSecret: '', clientSecretConfigured: true });
      expect(await getCredentials(admin.accessToken)).toContainEqual({ name: 'oauth-client-secret', configured: true });
    });

    // FL-67: clearing a credential removes the stored value
    it('should clear a credential', async () => {
      await request(app)
        .put('/admin/config/credentials/oauth-client-secret')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ value: secret });

      const { status, body } = await clearCredential(admin.accessToken, 'oauth-client-secret');
      expect(status).toBe(200);
      expect(body).toEqual({ name: 'oauth-client-secret', configured: false });

      expect(await getCredentials(admin.accessToken)).toContainEqual({
        name: 'oauth-client-secret',
        configured: false,
      });
      const config = await getSystemConfig(admin.accessToken);
      expect(config.oauth).toMatchObject({ clientSecret: '', clientSecretConfigured: false });
    });

    // FL-67: a blank value is not a way to clear a credential
    it('should reject a blank value', async () => {
      const { status } = await request(app)
        .put('/admin/config/credentials/oauth-client-secret')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ value: ' '.repeat(3) });
      expect(status).toBe(400);
    });

    // FL-67: the RunPod key cannot be cleared while RunPod is on, so a running pod can still be stopped
    it('should refuse to clear the RunPod API key while RunPod is on', async () => {
      const stored = await request(app)
        .put('/admin/config/credentials/runpod-api-key')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ value: 'fl67-runpod-key' });
      expect(stored.status).toBe(200);

      const config = await getSystemConfig(admin.accessToken);
      const runpod = config.machineLearning.runpod;
      const enabled = await request(app)
        .put('/system-config')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ...config, machineLearning: { ...config.machineLearning, runpod: { ...runpod, mode: 'pod' } } });
      expect(enabled.status).toBe(200);

      try {
        const { status, body } = await clearCredential(admin.accessToken, 'runpod-api-key');
        expect(status).toBe(400);
        expect(body).toEqual(errorDto.badRequest('Turn RunPod off before clearing its API key.'));
        expect(await getCredentials(admin.accessToken)).toContainEqual({ name: 'runpod-api-key', configured: true });
      } finally {
        const current = await getSystemConfig(admin.accessToken);
        await request(app)
          .put('/system-config')
          .set('Authorization', `Bearer ${admin.accessToken}`)
          .send({
            ...current,
            machineLearning: {
              ...current.machineLearning,
              runpod: { ...current.machineLearning.runpod, enabled: false, mode: 'disabled' },
            },
          });
      }

      const cleared = await clearCredential(admin.accessToken, 'runpod-api-key');
      expect(cleared.status).toBe(200);
      expect(cleared.body).toEqual({ name: 'runpod-api-key', configured: false });
    });

    // FL-67: only administrators can list, replace or clear server credentials
    it('should refuse a non-admin', async () => {
      const auth = { Authorization: `Bearer ${nonAdmin.accessToken}` };
      const list = await request(app).get('/admin/config/credentials').set(auth);
      expect(list.status).toBe(403);

      const put = await request(app)
        .put('/admin/config/credentials/oauth-client-secret')
        .set(auth)
        .send({ value: secret });
      expect(put.status).toBe(403);

      const del = await request(app).delete('/admin/config/credentials/oauth-client-secret').set(auth);
      expect(del.status).toBe(403);
    });
  });
});
