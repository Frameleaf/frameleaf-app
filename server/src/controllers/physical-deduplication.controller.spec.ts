import request from 'supertest';
import { PhysicalDeduplicationController } from 'src/controllers/physical-deduplication.controller.js';
import { PhysicalDeduplicationService } from 'src/services/physical-deduplication.service.js';
import { errorDto } from 'test/medium/responses.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(PhysicalDeduplicationController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(PhysicalDeduplicationService);

  beforeAll(async () => {
    ctx = await controllerSetup(PhysicalDeduplicationController, [
      { provide: PhysicalDeduplicationService, useValue: service },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /admin/physical-deduplication/preview', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get('/admin/physical-deduplication/preview');
      expect(ctx.authenticate).toHaveBeenCalled();
    });
  });

  describe('POST /admin/physical-deduplication/preview', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).post('/admin/physical-deduplication/preview').send({});
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should reject a retained account that is not a uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/admin/physical-deduplication/preview')
        .send({ masterUserId: 'taylor' });

      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['masterUserId'], message: expect.any(String) }]));
      expect(service.requestPreview).not.toHaveBeenCalled();
    });

    it('should accept an empty body and answer 204', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/admin/physical-deduplication/preview').send({});

      expect(status).toBe(204);
      expect(service.requestPreview).toHaveBeenCalledWith({});
    });
  });
});
