import { ForbiddenException } from '@nestjs/common';
import request from 'supertest';
import { QueueController } from 'src/controllers/queue.controller.js';
import { Permission, QueueName } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { QueueService } from 'src/services/queue.service.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

describe(QueueController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(QueueService);

  beforeAll(async () => {
    ctx = await controllerSetup(QueueController, [
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
      { provide: QueueService, useValue: service },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('POST /queues/:name/jobs/retry-failed (FL-71)', () => {
    it('retries the failed jobs of the named queue', async () => {
      service.retryFailedJobs.mockResolvedValue({ count: 2 });

      const { status, body } = await request(ctx.getHttpServer()).post(
        `/queues/${QueueName.SmartSearch}/jobs/retry-failed`,
      );

      expect(status).toBe(200);
      expect(body).toEqual({ count: 2 });
      expect(service.retryFailedJobs).toHaveBeenCalledWith(undefined, QueueName.SmartSearch);
    });

    it('refuses an unknown queue', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/queues/not-a-queue/jobs/retry-failed');

      expect(status).toBe(400);
      expect(service.retryFailedJobs).not.toHaveBeenCalled();
    });
  });

  describe('authorization (FL-71)', () => {
    it('asks for an administrator with queueJob.create to retry failed jobs', async () => {
      await request(ctx.getHttpServer()).post(`/queues/${QueueName.SmartSearch}/jobs/retry-failed`);

      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ adminRoute: true, permission: Permission.QueueJobCreate }),
        }),
      );
    });

    it('asks for an administrator with queueJob.read to list jobs with their accounts', async () => {
      service.searchJobs.mockResolvedValue([]);
      await request(ctx.getHttpServer()).get(`/queues/${QueueName.SmartSearch}/jobs`);

      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ adminRoute: true, permission: Permission.QueueJobRead }),
        }),
      );
    });

    it('refuses the request when authentication fails', async () => {
      ctx.authenticate.mockRejectedValue(new ForbiddenException('Forbidden'));
      const { status } = await request(ctx.getHttpServer()).post(`/queues/${QueueName.SmartSearch}/jobs/retry-failed`);

      expect(status).toBe(403);
      expect(service.retryFailedJobs).not.toHaveBeenCalled();
    });
  });

  describe('GET /queues/:name/jobs (FL-71)', () => {
    it('accepts a single status, which the SDK sends as one query value', async () => {
      service.searchJobs.mockResolvedValue([]);

      const { status } = await request(ctx.getHttpServer())
        .get(`/queues/${QueueName.SmartSearch}/jobs`)
        .query({ status: 'failed' });

      expect(status).toBe(200);
      expect(service.searchJobs).toHaveBeenCalledWith(undefined, QueueName.SmartSearch, { status: ['failed'] });
    });
  });

  describe('GET /queues/:name/statistics (FL-71 J-1)', () => {
    it("counts one account's jobs, for an administrator with queueJob.read", async () => {
      const ownerId = 'af1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a03';
      service.getOwnerStatistics.mockResolvedValue({
        active: 0,
        completed: 0,
        failed: 1,
        delayed: 0,
        waiting: 0,
        paused: 0,
        truncated: false,
      });

      const { status } = await request(ctx.getHttpServer())
        .get(`/queues/${QueueName.SmartSearch}/statistics`)
        .query({ ownerId });

      expect(status).toBe(200);
      expect(service.getOwnerStatistics).toHaveBeenCalledWith(undefined, QueueName.SmartSearch, ownerId);
      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ adminRoute: true, permission: Permission.QueueJobRead }),
        }),
      );
    });

    it('requires an account', async () => {
      const { status } = await request(ctx.getHttpServer()).get(`/queues/${QueueName.SmartSearch}/statistics`);

      expect(status).toBe(400);
      expect(service.getOwnerStatistics).not.toHaveBeenCalled();
    });
  });
});
