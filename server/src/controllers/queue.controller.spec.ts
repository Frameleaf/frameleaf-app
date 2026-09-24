import request from 'supertest';
import { QueueController } from 'src/controllers/queue.controller.js';
import { QueueName } from 'src/enum.js';
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
});
