import { BadRequestException } from '@nestjs/common';
import request from 'supertest';
import { EnrichmentController } from 'src/controllers/enrichment.controller.js';
import { EnrichmentStage, Permission } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { EnrichmentPlanService } from 'src/services/enrichment-plan.service.js';
import { VideoMomentIndexService } from 'src/services/video-moment-index.service.js';
import { factory, newUuidV7 } from 'test/small.factory.js';
import { ControllerContext, automock, controllerSetup } from 'test/utils.js';

describe(EnrichmentController.name, () => {
  let ctx: ControllerContext;
  const plans = automock(EnrichmentPlanService, { args: [{ setContext: () => {} }], strict: false });
  const moments = automock(VideoMomentIndexService, { args: [{ setContext: () => {} }], strict: false });

  beforeAll(async () => {
    ctx = await controllerSetup(EnrichmentController, [
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
      { provide: EnrichmentPlanService, useValue: plans },
      { provide: VideoMomentIndexService, useValue: moments },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    plans.resetAllMocks();
    moments.resetAllMocks();
    ctx.reset();
  });

  const expectAuth = (metadata: Record<string, unknown>) =>
    expect(ctx.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining(metadata) }),
    );

  describe('GET /enrichment/options', () => {
    it('is an administrator route', async () => {
      await request(ctx.getHttpServer()).get('/enrichment/options');
      expectAuth({ adminRoute: true });
    });

    it('delegates to the plan service', async () => {
      await request(ctx.getHttpServer()).get('/enrichment/options');
      expect(plans.getOptions).toHaveBeenCalledWith();
    });
  });

  describe('POST /enrichment/preview', () => {
    it('is an administrator route', async () => {
      await request(ctx.getHttpServer())
        .post('/enrichment/preview')
        .send({ assetIds: [factory.uuid()] });
      expectAuth({ adminRoute: true });
    });

    it('requires at least one sample', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/enrichment/preview').send({ assetIds: [] });
      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError());
      expect(plans.preview).not.toHaveBeenCalled();
    });

    it('rejects a sample that is not an asset id', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/enrichment/preview')
        .send({ assetIds: ['123'] });
      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['assetIds', 0], message: 'Invalid UUID' }]));
      expect(plans.preview).not.toHaveBeenCalled();
    });

    it('delegates the draft to the plan service and answers 200', async () => {
      const assetId = factory.uuid();
      plans.preview.mockResolvedValue({
        destinationId: 'local',
        destinationName: 'This server',
        cloud: false,
        modelName: 'draft',
        samples: [],
      });
      const { status } = await request(ctx.getHttpServer())
        .post('/enrichment/preview')
        .send({ assetIds: [assetId], modelName: 'draft' });
      expect(status).toBe(200);
      expect(plans.preview).toHaveBeenCalledWith(undefined, expect.objectContaining({ assetIds: [assetId] }));
    });
  });

  describe('POST /enrichment/plans', () => {
    it('requires asset update permission', async () => {
      await request(ctx.getHttpServer())
        .post('/enrichment/plans')
        .send({ assetIds: [factory.uuid()], stages: [EnrichmentStage.Description] });
      expectAuth({ permission: Permission.AssetUpdate });
    });

    it('requires at least one stage', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/enrichment/plans')
        .send({ assetIds: [factory.uuid()], stages: [] });
      expect(status).toBe(400);
      expect(plans.createPlan).not.toHaveBeenCalled();
    });

    it('rejects an unknown stage', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/enrichment/plans')
        .send({ assetIds: [factory.uuid()], stages: ['transcription'] });
      expect(status).toBe(400);
      expect(plans.createPlan).not.toHaveBeenCalled();
    });

    it('requires at least one asset', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/enrichment/plans')
        .send({ assetIds: [], stages: [EnrichmentStage.Description] });
      expect(status).toBe(400);
      expect(plans.createPlan).not.toHaveBeenCalled();
    });

    it('rejects a request key that is not a uuid', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/enrichment/plans')
        .send({ assetIds: [factory.uuid()], stages: [EnrichmentStage.Description], requestKey: 'again' });
      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['requestKey'], message: 'Invalid UUID' }]));
      expect(plans.createPlan).not.toHaveBeenCalled();
    });

    it('delegates to the plan service and answers 201', async () => {
      const dto = {
        assetIds: [factory.uuid(), factory.uuid()],
        stages: [EnrichmentStage.MomentIndex],
        requestKey: factory.uuid(),
      };
      const { status } = await request(ctx.getHttpServer()).post('/enrichment/plans').send(dto);
      expect(status).toBe(201);
      expect(plans.createPlan).toHaveBeenCalledWith(undefined, dto);
    });
  });

  describe('GET /enrichment/plans/:id', () => {
    it('requires authentication', async () => {
      await request(ctx.getHttpServer()).get(`/enrichment/plans/${newUuidV7()}`);
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('requires a media operation id', async () => {
      const { status } = await request(ctx.getHttpServer()).get(`/enrichment/plans/${factory.uuid()}`);
      expect(status).toBe(400);
      expect(plans.getPlan).not.toHaveBeenCalled();
    });

    it('delegates to the plan service', async () => {
      const id = newUuidV7();
      await request(ctx.getHttpServer()).get(`/enrichment/plans/${id}`);
      expect(plans.getPlan).toHaveBeenCalledWith(undefined, id);
    });
  });

  describe('POST /enrichment/moments/search', () => {
    it('requires asset read permission', async () => {
      await request(ctx.getHttpServer()).post('/enrichment/moments/search').send({ query: 'birthday' });
      expectAuth({ permission: Permission.AssetRead });
    });

    it('requires a query', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/enrichment/moments/search').send({ query: '  ' });
      expect(status).toBe(400);
      expect(moments.search).not.toHaveBeenCalled();
    });

    it('caps the limit', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/enrichment/moments/search')
        .send({ query: 'birthday', limit: 101 });
      expect(status).toBe(400);
      expect(moments.search).not.toHaveBeenCalled();
    });

    it('delegates the trimmed query to the moment service and answers 200', async () => {
      moments.search.mockResolvedValue({ hits: [] });
      const { status, body } = await request(ctx.getHttpServer())
        .post('/enrichment/moments/search')
        .send({ query: ' birthday ', limit: 5 });
      expect(status).toBe(200);
      expect(body).toEqual({ hits: [] });
      expect(moments.search).toHaveBeenCalledWith(undefined, { query: 'birthday', limit: 5 });
    });
  });

  describe('GET /enrichment/frames/:id', () => {
    it('requires asset read permission', async () => {
      await request(ctx.getHttpServer()).get(`/enrichment/frames/${newUuidV7()}`);
      expectAuth({ permission: Permission.AssetRead });
    });

    it('requires a frame id', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/enrichment/frames/123');
      expect(status).toBe(400);
      expect(moments.getFrameFile).not.toHaveBeenCalled();
    });

    it('delegates to the moment service and answers a refusal without a file', async () => {
      const id = newUuidV7();
      moments.getFrameFile.mockRejectedValue(new BadRequestException('Not found or no asset.read access'));
      const { status } = await request(ctx.getHttpServer()).get(`/enrichment/frames/${id}`);
      expect(status).toBe(404);
      expect(moments.getFrameFile).toHaveBeenCalledWith(undefined, id);
    });
  });

  describe('GET /enrichment/frames/:id/similar', () => {
    it('requires asset read permission', async () => {
      await request(ctx.getHttpServer()).get(`/enrichment/frames/${newUuidV7()}/similar`);
      expectAuth({ permission: Permission.AssetRead });
    });

    it('requires a frame id', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/enrichment/frames/123/similar');
      expect(status).toBe(400);
      expect(moments.searchSimilar).not.toHaveBeenCalled();
    });

    it('refuses a limit outside 1 to 100', async () => {
      for (const limit of [0, 101, 'many']) {
        const { status } = await request(ctx.getHttpServer())
          .get(`/enrichment/frames/${newUuidV7()}/similar`)
          .query({ limit });
        expect(status).toBe(400);
      }
      expect(moments.searchSimilar).not.toHaveBeenCalled();
    });

    it('delegates the frame and limit to the moment service', async () => {
      const id = newUuidV7();
      moments.searchSimilar.mockResolvedValue({ hits: [] });
      const { status, body } = await request(ctx.getHttpServer())
        .get(`/enrichment/frames/${id}/similar`)
        .query({ limit: 12 });
      expect(status).toBe(200);
      expect(body).toEqual({ hits: [] });
      expect(moments.searchSimilar).toHaveBeenCalledWith(undefined, id, { limit: 12 });
    });
  });

  describe('GET /enrichment/videos/:id/moments', () => {
    it('requires asset read permission', async () => {
      await request(ctx.getHttpServer()).get(`/enrichment/videos/${factory.uuid()}/moments`);
      expectAuth({ permission: Permission.AssetRead });
    });

    it('requires an asset id', async () => {
      const { status, body } = await request(ctx.getHttpServer()).get('/enrichment/videos/123/moments');
      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
      expect(moments.getMoments).not.toHaveBeenCalled();
    });

    it('delegates to the moment service', async () => {
      const id = factory.uuid();
      await request(ctx.getHttpServer()).get(`/enrichment/videos/${id}/moments`);
      expect(moments.getMoments).toHaveBeenCalledWith(undefined, id);
    });
  });

  describe('PUT /enrichment/videos/:id/cover', () => {
    it('requires asset update permission', async () => {
      await request(ctx.getHttpServer()).put(`/enrichment/videos/${factory.uuid()}/cover`).send({ timestampMs: 0 });
      expectAuth({ permission: Permission.AssetUpdate });
    });

    it.each([{}, { timestampMs: -1 }, { timestampMs: 1.5 }])('rejects %j', async (body) => {
      const { status } = await request(ctx.getHttpServer())
        .put(`/enrichment/videos/${factory.uuid()}/cover`)
        .send(body);
      expect(status).toBe(400);
      expect(moments.setCover).not.toHaveBeenCalled();
    });

    it.each([null, 12_000])('delegates a cover time of %s', async (timestampMs) => {
      const id = factory.uuid();
      await request(ctx.getHttpServer()).put(`/enrichment/videos/${id}/cover`).send({ timestampMs });
      expect(moments.setCover).toHaveBeenCalledWith(undefined, id, { timestampMs });
    });
  });

  describe('POST /enrichment/videos/:id/moments', () => {
    it('requires asset update permission', async () => {
      await request(ctx.getHttpServer())
        .post(`/enrichment/videos/${factory.uuid()}/moments`)
        .send({ timestampMs: 1000 });
      expectAuth({ permission: Permission.AssetUpdate });
    });

    it('requires a time', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post(`/enrichment/videos/${factory.uuid()}/moments`)
        .send({ caption: 'Candles' });
      expect(status).toBe(400);
      expect(moments.createMoment).not.toHaveBeenCalled();
    });

    it('rejects a caption over 500 characters', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post(`/enrichment/videos/${factory.uuid()}/moments`)
        .send({ timestampMs: 1000, caption: 'x'.repeat(501) });
      expect(status).toBe(400);
      expect(moments.createMoment).not.toHaveBeenCalled();
    });

    it('delegates to the moment service and answers 201', async () => {
      const id = factory.uuid();
      const dto = { timestampMs: 1000, endMs: 2000, caption: 'Candles', transcript: 'Happy birthday' };
      const { status } = await request(ctx.getHttpServer()).post(`/enrichment/videos/${id}/moments`).send(dto);
      expect(status).toBe(201);
      expect(moments.createMoment).toHaveBeenCalledWith(undefined, id, dto);
    });
  });

  describe('PUT /enrichment/videos/:id/moments/:momentId', () => {
    it('requires asset update permission', async () => {
      await request(ctx.getHttpServer())
        .put(`/enrichment/videos/${factory.uuid()}/moments/${newUuidV7()}`)
        .send({ caption: 'Candles' });
      expectAuth({ permission: Permission.AssetUpdate });
    });

    it('requires a moment id', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/enrichment/videos/${factory.uuid()}/moments/123`)
        .send({ caption: 'Candles' });
      expect(status).toBe(400);
      expect(body).toEqual(factory.responses.validationError([{ path: ['momentId'], message: 'Invalid UUID' }]));
      expect(moments.updateMoment).not.toHaveBeenCalled();
    });

    it('delegates to the moment service', async () => {
      const id = factory.uuid();
      const momentId = newUuidV7();
      await request(ctx.getHttpServer()).put(`/enrichment/videos/${id}/moments/${momentId}`).send({ transcript: null });
      expect(moments.updateMoment).toHaveBeenCalledWith(undefined, id, momentId, { transcript: null });
    });
  });

  describe('DELETE /enrichment/videos/:id/moments/:momentId', () => {
    it('requires asset update permission', async () => {
      await request(ctx.getHttpServer()).delete(`/enrichment/videos/${factory.uuid()}/moments/${newUuidV7()}`);
      expectAuth({ permission: Permission.AssetUpdate });
    });

    it('requires an asset id', async () => {
      const { status } = await request(ctx.getHttpServer()).delete(`/enrichment/videos/123/moments/${newUuidV7()}`);
      expect(status).toBe(400);
      expect(moments.deleteMoment).not.toHaveBeenCalled();
    });

    it('delegates to the moment service and answers 204', async () => {
      const id = factory.uuid();
      const momentId = newUuidV7();
      const { status } = await request(ctx.getHttpServer()).delete(`/enrichment/videos/${id}/moments/${momentId}`);
      expect(status).toBe(204);
      expect(moments.deleteMoment).toHaveBeenCalledWith(undefined, id, momentId);
    });
  });
});
