import request from 'supertest';
import { SystemMetadataController } from 'src/controllers/system-metadata.controller.js';
import { SystemMetadataService } from 'src/services/system-metadata.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(SystemMetadataController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(SystemMetadataService);

  beforeAll(async () => {
    ctx = await controllerSetup(SystemMetadataController, [{ provide: SystemMetadataService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('POST /system-metadata/admin-onboarding', () => {
    it('should require isOnboarded', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/system-metadata/admin-onboarding').send({});

      expect(status).toBe(400);
      expect(service.updateAdminOnboarding).not.toHaveBeenCalled();
    });
  });

  describe('PUT /system-metadata/frameleaf-setup (FL-176)', () => {
    const progress = { version: 1, step: 'account', reached: 2, choices: { signIn: 'local', adminName: 'Ada' } };

    it('accepts password-free progress', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put('/system-metadata/frameleaf-setup')
        .send({ flow: 'new', progress });
      expect(status).toBe(200);
      expect(service.updateFrameleafSetup).toHaveBeenCalled();
    });

    it('rejects a password in the saved choices', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put('/system-metadata/frameleaf-setup')
        .send({ progress: { ...progress, choices: { ...progress.choices, password: 'hunter22' } } });
      expect(status).toBe(400);
      expect(service.updateFrameleafSetup).not.toHaveBeenCalled();
    });

    it('rejects extra top-level fields', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put('/system-metadata/frameleaf-setup')
        .send({ progress: { ...progress, password: 'hunter22' } });
      expect(status).toBe(400);
    });
  });
});
