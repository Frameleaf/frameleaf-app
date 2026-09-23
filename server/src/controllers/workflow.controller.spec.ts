import { WorkflowTrigger } from '@immich/plugin-sdk';
import request from 'supertest';
import { WorkflowController } from 'src/controllers/workflow.controller.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { WorkflowService } from 'src/services/workflow.service.js';
import { errorDto } from 'test/medium/responses.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

describe(WorkflowController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(WorkflowService);

  beforeAll(async () => {
    ctx = await controllerSetup(WorkflowController, [
      { provide: WorkflowService, useValue: service },
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('POST /workflows', () => {
    it(`should require a trigger`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post(`/workflows`)
        .send({})
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['trigger'], message: expect.stringContaining('expected string') }]),
      );
    });

    it(`should pass an unavailable trigger to the service, which keeps it paused`, async () => {
      const { status } = await request(ctx.getHttpServer())
        .post(`/workflows`)
        .send({ trigger: 'Schedule', enabled: false })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(201);
      expect(service.create).toHaveBeenCalledWith(undefined, expect.objectContaining({ trigger: 'Schedule' }));
    });

    it(`should refuse more than 100 steps`, async () => {
      const steps = Array.from({ length: 101 }, () => ({ method: 'plugin#method', config: null }));
      const { status } = await request(ctx.getHttpServer())
        .post(`/workflows`)
        .send({ trigger: WorkflowTrigger.AssetCreate, steps })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it(`should require a valid enabled value`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post(`/workflows`)
        .send({ enabled: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['enabled'], message: 'Invalid input: expected boolean, received string' }]),
      );
    });

    it(`should not require a name`, async () => {
      const { status } = await request(ctx.getHttpServer())
        .post(`/workflows`)
        .send({ trigger: WorkflowTrigger.AssetCreate })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(201);
      expect(service.create).toHaveBeenCalled();
    });
  });

  describe('POST /workflows/:id/runs/:runId/retry', () => {
    it(`should require uuids`, async () => {
      const { status } = await request(ctx.getHttpServer())
        .post(`/workflows/00000000-0000-4000-8000-000000000000/runs/invalid/retry`)
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(service.retryRun).not.toHaveBeenCalled();
    });

    it(`should retry a run`, async () => {
      const id = '00000000-0000-4000-8000-000000000001';
      const runId = '00000000-0000-4000-8000-000000000002';
      const { status } = await request(ctx.getHttpServer())
        .post(`/workflows/${id}/runs/${runId}/retry`)
        .set('Authorization', `Bearer token`);
      expect(status).toBe(204);
      expect(service.retryRun).toHaveBeenCalledWith(undefined, id, runId);
    });
  });

  describe('GET /workflows', () => {
    it(`should require id to be a uuid`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get(`/workflows`)
        .query({ id: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });
  });

  describe('GET /workflows/:id', () => {
    it(`should require id to be a uuid`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get(`/workflows/invalid`)
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });
  });

  describe('PATCH /workflows/:id', () => {
    it(`should require id to be a uuid`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .patch(`/workflows/invalid`)
        .set('Authorization', `Bearer token`)
        .send({});
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });
  });
});
