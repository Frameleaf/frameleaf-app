import request from 'supertest';
import { PhysicalDeduplicationController } from 'src/controllers/physical-deduplication.controller.js';
import { Permission } from 'src/enum.js';
import { PhysicalDeduplicationPlanService } from 'src/services/physical-deduplication-plan.service.js';
import { PhysicalDeduplicationService } from 'src/services/physical-deduplication.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { errorDto } from 'test/medium/responses.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

const fingerprint = 'ab'.repeat(32);
const reviewToken = 'cd'.repeat(32);

describe(PhysicalDeduplicationController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(PhysicalDeduplicationService);
  const plans = automock(PhysicalDeduplicationPlanService, { args: [{ setContext: () => {} }], strict: false });

  beforeAll(async () => {
    ctx = await controllerSetup(PhysicalDeduplicationController, [
      { provide: PhysicalDeduplicationService, useValue: service },
      { provide: PhysicalDeduplicationPlanService, useValue: plans },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    plans.resetAllMocks();
    ctx.reset();
  });

  describe('GET /admin/physical-deduplication/preview', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get('/admin/physical-deduplication/preview');
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('reads the preview with the applied plans (FL-73)', async () => {
      await request(ctx.getHttpServer()).get('/admin/physical-deduplication/preview');
      expect(plans.getPreview).toHaveBeenCalled();
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

  describe('POST /admin/physical-deduplication/plan/review', () => {
    it('is an administrator route that needs job create permission', async () => {
      await request(ctx.getHttpServer()).post('/admin/physical-deduplication/plan/review').send({ fingerprint });

      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ permission: Permission.JobCreate, adminRoute: true }),
        }),
      );
    });

    it('requires the fingerprint of the plan on screen', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/admin/physical-deduplication/plan/review')
        .send({ fingerprint: 'PD-1234' });

      expect(status).toBe(400);
      expect(plans.review).not.toHaveBeenCalled();
    });

    it('takes left-out groups as retained asset ids', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/admin/physical-deduplication/plan/review')
        .send({ fingerprint, excludedRetainedAssetIds: ['not-a-uuid'] });

      expect(status).toBe(400);
      expect(plans.review).not.toHaveBeenCalled();
    });

    it('answers 200 with the review', async () => {
      // The harness authenticates nobody unless told to, so hand it an administrator to pass through.
      const auth = AuthFactory.create({ isAdmin: true });
      ctx.authenticate.mockResolvedValue(auth);
      const { status } = await request(ctx.getHttpServer())
        .post('/admin/physical-deduplication/plan/review')
        .send({ fingerprint });

      expect(status).toBe(200);
      expect(plans.review).toHaveBeenCalledWith(auth, { fingerprint });
    });
  });

  describe('POST /admin/physical-deduplication/plan/apply', () => {
    it('is an administrator route that needs job create permission', async () => {
      await request(ctx.getHttpServer())
        .post('/admin/physical-deduplication/plan/apply')
        .send({ fingerprint, reviewToken, confirmation: 'APPLY PD-ABABABAB' });

      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ permission: Permission.JobCreate, adminRoute: true }),
        }),
      );
    });

    it('cannot be applied without a review token', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/admin/physical-deduplication/plan/apply')
        .send({ fingerprint, confirmation: 'APPLY PD-ABABABAB' });

      expect(status).toBe(400);
      expect(plans.apply).not.toHaveBeenCalled();
    });

    it('cannot be applied without a typed confirmation', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/admin/physical-deduplication/plan/apply')
        .send({ fingerprint, reviewToken });

      expect(status).toBe(400);
      expect(plans.apply).not.toHaveBeenCalled();
    });

    it('answers 201 with the queued job', async () => {
      const dto = { fingerprint, reviewToken, confirmation: 'APPLY PD-ABABABAB' };
      // The harness authenticates nobody unless told to, so hand it an administrator to pass through.
      const auth = AuthFactory.create({ isAdmin: true });
      ctx.authenticate.mockResolvedValue(auth);
      const { status } = await request(ctx.getHttpServer()).post('/admin/physical-deduplication/plan/apply').send(dto);

      expect(status).toBe(201);
      expect(plans.apply).toHaveBeenCalledWith(auth, dto);
    });
  });

  describe('POST /admin/physical-deduplication/applies/:id/verify (FL-73)', () => {
    const id = '00000000-0000-4000-8000-000000000001';

    it('is an administrator route that needs job read permission', async () => {
      await request(ctx.getHttpServer()).post(`/admin/physical-deduplication/applies/${id}/verify`);

      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ permission: Permission.JobRead, adminRoute: true }),
        }),
      );
    });

    it('rejects an id that is not a uuid', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/admin/physical-deduplication/applies/nope/verify');

      expect(status).toBe(400);
      expect(plans.verify).not.toHaveBeenCalled();
    });

    it('verifies the applied plan', async () => {
      const auth = AuthFactory.create({ isAdmin: true });
      ctx.authenticate.mockResolvedValue(auth);
      const { status } = await request(ctx.getHttpServer()).post(`/admin/physical-deduplication/applies/${id}/verify`);

      expect(status).toBe(200);
      expect(plans.verify).toHaveBeenCalledWith(auth, id);
    });
  });

  describe('POST /admin/physical-deduplication/applies/:id/restore (FL-73)', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const assetId = '00000000-0000-4000-8000-000000000002';

    it('is an administrator route that needs job create permission', async () => {
      await request(ctx.getHttpServer()).post(`/admin/physical-deduplication/applies/${id}/restore`).send({ assetId });

      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ permission: Permission.JobCreate, adminRoute: true }),
        }),
      );
    });

    it('requires the copy to restore', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post(`/admin/physical-deduplication/applies/${id}/restore`)
        .send({});

      expect(status).toBe(400);
      expect(plans.restore).not.toHaveBeenCalled();
    });

    it('restores the copy', async () => {
      const auth = AuthFactory.create({ isAdmin: true });
      ctx.authenticate.mockResolvedValue(auth);
      const { status } = await request(ctx.getHttpServer())
        .post(`/admin/physical-deduplication/applies/${id}/restore`)
        .send({ assetId });

      expect(status).toBe(200);
      expect(plans.restore).toHaveBeenCalledWith(auth, id, { assetId });
    });
  });
});
