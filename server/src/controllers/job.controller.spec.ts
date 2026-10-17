import request from 'supertest';
import { JobController } from 'src/controllers/job.controller.js';
import { JobService } from 'src/services/job.service.js';
import { QueueService } from 'src/services/queue.service.js';
import { RunningJobService } from 'src/services/running-job.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(JobController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(JobService);
  const queueService = mockBaseService(QueueService);
  const runningJobService = { getRunning: vi.fn() };

  beforeAll(async () => {
    ctx = await controllerSetup(JobController, [
      { provide: JobService, useValue: service },
      { provide: QueueService, useValue: queueService },
      { provide: RunningJobService, useValue: runningJobService },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    queueService.resetAllMocks();
    runningJobService.getRunning.mockReset();
    ctx.reset();
  });

  describe('GET /jobs/running', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get('/jobs/running');
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should not be read as a queue name', async () => {
      runningJobService.getRunning.mockResolvedValue({
        operations: [],
        memoryExports: [],
        queues: [],
        canManageQueues: false,
      });

      const { status } = await request(ctx.getHttpServer()).get('/jobs/running');

      expect(status).toBe(200);
      expect(runningJobService.getRunning).toHaveBeenCalled();
    });
  });

  describe('PUT /jobs/:name', () => {
    it('should require a valid queue name', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put('/jobs/invalid')
        .send({ command: 'start', force: false });

      expect(status).toBe(400);
      expect(queueService.runCommandLegacy).not.toHaveBeenCalled();
    });

    it('should require a valid command', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put('/jobs/metadataExtraction')
        .send({ command: 'invalid', force: false });

      expect(status).toBe(400);
      expect(queueService.runCommandLegacy).not.toHaveBeenCalled();
    });
  });
});
