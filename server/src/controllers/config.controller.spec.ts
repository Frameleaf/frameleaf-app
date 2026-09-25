import { cloneDeep } from 'lodash-es';
import request from 'supertest';
import { ConfigAdminController } from 'src/controllers/config-admin.controller.js';
import { ConfigPublicController } from 'src/controllers/config-public.controller.js';
import { ConfigUserController } from 'src/controllers/config-user.controller.js';
import { defaults, mapPublicConfig, mapUserConfig } from 'src/dtos/config.dto.js';
import { ConfigCredential } from 'src/enum.js';
import { SystemConfigService } from 'src/services/system-config.service.js';
import { errorDto } from 'test/medium/responses.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

/** Returns a full config that passes Zod validation (required URLs and min lengths). */
function validConfig() {
  const config = cloneDeep(defaults) as typeof defaults & {
    oauth: { mobileRedirectUri: string };
    notifications: { smtp: { from: string; transport: { host: string } } };
    server: { externalDomain: string };
  };
  config.oauth.mobileRedirectUri ||= 'https://example.com';
  config.server.externalDomain ||= 'https://example.com';
  config.notifications.smtp.from ||= 'noreply@example.com';
  config.notifications.smtp.transport.host ||= 'localhost';
  return config;
}

describe('config controllers', () => {
  let ctx: ControllerContext;
  const service = mockBaseService(SystemConfigService);

  beforeAll(async () => {
    ctx = await controllerSetup(
      [ConfigAdminController, ConfigUserController, ConfigPublicController],
      [{ provide: SystemConfigService, useValue: service }],
    );
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /admin/config', () => {
    it('should return the full config', async () => {
      service.getAdminConfig.mockResolvedValue(validConfig());

      const { status, body } = await request(ctx.getHttpServer()).get('/admin/config');

      expect(status).toBe(200);
      expect(body.oauth.clientSecret).toBeDefined();
      expect(body.job.thumbnailGeneration).toBeDefined();
    });
  });

  describe('PUT /admin/config', () => {
    it('should accept a valid config', async () => {
      service.updateAdminConfig.mockImplementation((dto) => Promise.resolve(dto));

      const { status } = await request(ctx.getHttpServer()).put('/admin/config').send(validConfig());

      expect(status).toBe(200);
    });

    it('should reject an invalid config', async () => {
      const config = validConfig();
      config.nightlyTasks.startTime = 'invalid';

      const { status, body } = await request(ctx.getHttpServer()).put('/admin/config').send(config);

      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          {
            path: ['nightlyTasks', 'startTime'],
            message: 'Invalid input: expected string in HH:MM format, received string',
          },
        ]),
      );
      expect(service.updateAdminConfig).not.toHaveBeenCalled();
    });
  });

  describe('credentials (FL-67)', () => {
    it('should list whether each credential is stored', async () => {
      service.getCredentials.mockResolvedValue([{ name: ConfigCredential.SmtpPassword, configured: true }]);

      const { status, body } = await request(ctx.getHttpServer()).get('/admin/config/credentials');

      expect(status).toBe(200);
      expect(body).toEqual([{ name: 'smtp-password', configured: true }]);
    });

    it('should replace a credential with the value sent', async () => {
      service.setCredential.mockResolvedValue({ name: ConfigCredential.OAuthClientSecret, configured: true });

      const { status, body } = await request(ctx.getHttpServer())
        .put('/admin/config/credentials/oauth-client-secret')
        .send({ value: 'new-secret' });

      expect(status).toBe(200);
      expect(body).toEqual({ name: 'oauth-client-secret', configured: true });
      expect(service.setCredential).toHaveBeenCalledWith(undefined, ConfigCredential.OAuthClientSecret, {
        value: 'new-secret',
      });
    });

    it('should reject a blank credential value', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put('/admin/config/credentials/smtp-password')
        .send({ value: ' '.repeat(3) });

      expect(status).toBe(400);
      expect(service.setCredential).not.toHaveBeenCalled();
    });

    it('should reject an unknown credential name', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put('/admin/config/credentials/database-password')
        .send({ value: 'secret' });

      expect(status).toBe(400);
      expect(service.setCredential).not.toHaveBeenCalled();
    });

    it('should clear a credential', async () => {
      service.clearCredential.mockResolvedValue({ name: ConfigCredential.OAuthClientSecret, configured: false });

      const { status, body } = await request(ctx.getHttpServer()).delete(
        '/admin/config/credentials/oauth-client-secret',
      );

      expect(status).toBe(200);
      expect(body).toEqual({ name: 'oauth-client-secret', configured: false });
      expect(service.clearCredential).toHaveBeenCalledWith(undefined, ConfigCredential.OAuthClientSecret);
    });
  });

  describe('GET /admin/config/history (FL-66)', () => {
    it('should return the settings change history', async () => {
      const history = {
        entries: [
          {
            id: 'entry-1',
            createdAt: '2026-09-23T10:00:00.000Z',
            actorId: 'admin',
            actorName: 'Admin',
            changes: [
              { path: 'trash.days', before: '30', after: '12' },
              { path: 'oauth.clientSecret', before: null, after: null, credential: 'replaced' as const },
            ],
            omittedChanges: 0,
          },
        ],
      };
      service.getConfigHistory.mockResolvedValue(history);

      const { status, body } = await request(ctx.getHttpServer()).get('/admin/config/history');

      expect(status).toBe(200);
      expect(body).toEqual(history);
    });
  });

  describe('GET /admin/config/revision (FL-66)', () => {
    it('should return the saved config with its revision', async () => {
      service.getAdminConfigWithRevision.mockResolvedValue({ config: validConfig(), revision: 'abc123' });

      const { status, body } = await request(ctx.getHttpServer()).get('/admin/config/revision');

      expect(status).toBe(200);
      expect(body.revision).toBe('abc123');
      expect(body.config.trash).toEqual(defaults.trash);
    });
  });

  describe('PUT /admin/config/revision (FL-66)', () => {
    it('should pass the config and the expected revision to the service', async () => {
      service.updateAdminConfigWithRevision.mockImplementation(({ config }) =>
        Promise.resolve({ config, revision: 'next' }),
      );

      const { status, body } = await request(ctx.getHttpServer())
        .put('/admin/config/revision')
        .send({ config: validConfig(), expectedRevision: 'abc123' });

      expect(status).toBe(200);
      expect(body.revision).toBe('next');
      expect(service.updateAdminConfigWithRevision).toHaveBeenCalledWith(
        expect.objectContaining({ expectedRevision: 'abc123' }),
        undefined,
      );
    });

    it('should require the revision the changes were made against', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put('/admin/config/revision')
        .send({ config: validConfig() });

      expect(status).toBe(400);
      expect(service.updateAdminConfigWithRevision).not.toHaveBeenCalled();
    });

    it('should validate the config the same way as PUT /admin/config', async () => {
      const config = validConfig();
      config.nightlyTasks.startTime = 'invalid';

      const { status } = await request(ctx.getHttpServer())
        .put('/admin/config/revision')
        .send({ config, expectedRevision: 'abc123' });

      expect(status).toBe(400);
      expect(service.updateAdminConfigWithRevision).not.toHaveBeenCalled();
    });
  });

  describe('GET /config', () => {
    it('should return the properties visible to logged in users', async () => {
      service.getUserConfig.mockResolvedValue(mapUserConfig(validConfig()));

      const { status, body } = await request(ctx.getHttpServer()).get('/config');

      expect(status).toBe(200);
      expect(body.image).toEqual({
        thumbnail: { size: defaults.image.thumbnail.size },
        preview: { size: defaults.image.preview.size },
        fullsize: { enabled: defaults.image.fullsize.enabled },
      });
      expect(body.oauth.clientSecret).toBeUndefined();
      expect(body.job).toBeUndefined();
    });
  });

  describe('GET /public/config', () => {
    it('should return the properties visible to everyone', async () => {
      service.getPublicConfig.mockResolvedValue(mapPublicConfig(validConfig()));

      const { status, body } = await request(ctx.getHttpServer()).get('/public/config');

      expect(status).toBe(200);
      // FL-71 (CC-4): the server name is shown to everyone, like the login page message.
      expect(body.server).toEqual({ name: defaults.server.name, loginPageMessage: defaults.server.loginPageMessage });
      expect(body.oauth).toEqual({
        autoLaunch: defaults.oauth.autoLaunch,
        buttonText: defaults.oauth.buttonText,
        enabled: defaults.oauth.enabled,
      });
      expect(body.image).toBeUndefined();
      expect(body.trash).toBeUndefined();
    });
  });
});
