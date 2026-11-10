import request from 'supertest';
import { MediaHealthController } from 'src/controllers/media-health.controller.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { ControllerContext, automock, controllerSetup } from 'test/utils.js';

describe(MediaHealthController.name, () => {
  let ctx: ControllerContext;
  const service = automock(MediaHealthService, { args: [{ setContext: () => {} }], strict: false });
  const id = '6f4f3c3e-8a3b-4c51-9a4b-2a7d0c9f1e21';

  beforeAll(async () => {
    ctx = await controllerSetup(MediaHealthController, [
      { provide: MediaHealthService, useValue: service },
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('damaged and missing files (FL-1337)', () => {
    it('are authenticated routes', async () => {
      await request(ctx.getHttpServer()).get('/media-health/files').query({ tab: 'needs' });
      await request(ctx.getHttpServer()).get('/media-health/files/folders');
      await request(ctx.getHttpServer()).get(`/media-health/files/${id}`);
      await request(ctx.getHttpServer()).post(`/media-health/files/${id}/undo`);
      expect(ctx.authenticate).toHaveBeenCalledTimes(4);
    });

    it('lists a tab a page at a time, 50 by default and at most 200', async () => {
      await request(ctx.getHttpServer()).get('/media-health/files').query({ tab: 'fixed' });
      expect(service.listFileProblems).toHaveBeenLastCalledWith(undefined, { tab: 'fixed', take: 50, skip: 0 });

      for (const query of [{}, { tab: 'everything' }, { tab: 'needs', take: '201' }, { tab: 'needs', skip: '-1' }]) {
        const { status } = await request(ctx.getHttpServer()).get('/media-health/files').query(query);
        expect(status).toBe(400);
      }
      expect(service.listFileProblems).toHaveBeenCalledTimes(1);
    });

    it('reads the folders before a problem id', async () => {
      await request(ctx.getHttpServer()).get('/media-health/files/folders');
      expect(service.getFileProblemFolders).toHaveBeenCalled();
      expect(service.getFileProblem).not.toHaveBeenCalled();
    });

    it('takes a problem by its id', async () => {
      await request(ctx.getHttpServer()).get(`/media-health/files/${id}`);
      expect(service.getFileProblem).toHaveBeenCalledWith(undefined, id);

      const { status } = await request(ctx.getHttpServer()).post('/media-health/files/not-an-id/keep');
      expect(status).toBe(400);
      expect(service.keepFileProblem).not.toHaveBeenCalled();
    });

    it('acts on a problem', async () => {
      await request(ctx.getHttpServer()).post(`/media-health/files/${id}/undo`);
      await request(ctx.getHttpServer()).post(`/media-health/files/${id}/keep`);
      await request(ctx.getHttpServer()).post(`/media-health/files/${id}/try-again`);
      await request(ctx.getHttpServer()).post(`/media-health/files/${id}/look-in`).send({ folderId: 'managed' });

      expect(service.undoFileProblemFix).toHaveBeenCalledWith(undefined, id);
      expect(service.keepFileProblem).toHaveBeenCalledWith(undefined, id);
      expect(service.tryFileProblemAgain).toHaveBeenCalledWith(undefined, id);
      expect(service.lookInFolderForFileProblem).toHaveBeenCalledWith(undefined, id, { folderId: 'managed' });
    });

    it('needs a folder to look in', async () => {
      const { status } = await request(ctx.getHttpServer()).post(`/media-health/files/${id}/look-in`).send({});
      expect(status).toBe(400);
      expect(service.lookInFolderForFileProblem).not.toHaveBeenCalled();
    });
  });
});
