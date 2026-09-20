import { LoginResponseDto, getConfig } from '@immich/sdk';
import { errorDto } from 'src/responses.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const getSystemConfig = (accessToken: string) => getConfig({ headers: asBearerAuth(accessToken) });

describe('/system-config', () => {
  let admin: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
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
});
