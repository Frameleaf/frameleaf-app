import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { MediaHealthController } from 'src/controllers/media-health.controller.js';
import { CacheControl } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaHealthService } from 'src/services/media-health.service.js';
import { FileDownloadResponse } from 'src/utils/file.js';
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
      await request(ctx.getHttpServer()).get(`/media-health/files/${id}/kept-file`);
      expect(ctx.authenticate).toHaveBeenCalledTimes(5);
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

    describe('the damaged file a repair kept (Task 11b)', () => {
      let folder: string;

      beforeEach(async () => {
        folder = await mkdtemp(join(tmpdir(), 'kept-file-'));
      });

      afterEach(async () => {
        await rm(folder, { recursive: true, force: true });
      });

      it('sends the file, named after the photo', async () => {
        const kept = join(folder, 'asset-1-health-1.damaged.jpg');
        await writeFile(kept, 'the damaged file');
        service.getFileProblemKeptFile.mockResolvedValue(
          new FileDownloadResponse({
            path: kept,
            fileName: 'IMG_2041.jpg',
            contentType: 'image/jpeg',
            cacheControl: CacheControl.PrivateWithoutCache,
          }),
        );

        const { status, headers, body } = await request(ctx.getHttpServer())
          .get(`/media-health/files/${id}/kept-file`)
          .buffer(true)
          .parse((response, done) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => {
              chunks.push(chunk);
            });
            response.on('end', () => done(null, Buffer.concat(chunks)));
          });

        expect(status).toBe(200);
        expect(service.getFileProblemKeptFile).toHaveBeenCalledWith(undefined, id);
        expect(headers['content-type']).toMatch(/^image\/jpeg/);
        expect(headers['content-disposition']).toBe("inline; filename*=UTF-8''IMG_2041.jpg");
        expect(headers['cache-control']).toBe('private, no-cache, no-transform');
        expect((body as Buffer).toString()).toBe('the damaged file');
      });

      it('answers a refusal with its own status, not as a missing file', async () => {
        for (const [error, status] of [
          [new ForbiddenException("Only the photo's owner can do that."), 403],
          [new ConflictException("This photo is locked, so the damaged file Frameleaf kept can't be downloaded."), 409],
          [new NotFoundException("Frameleaf didn't keep a damaged file for this photo."), 404],
        ] as const) {
          service.getFileProblemKeptFile.mockRejectedValueOnce(error);
          const response = await request(ctx.getHttpServer()).get(`/media-health/files/${id}/kept-file`);
          expect(response.status).toBe(status);
          expect(response.body).toMatchObject({ message: error.message });
        }
      });

      it('takes a problem by its id', async () => {
        const { status } = await request(ctx.getHttpServer()).get('/media-health/files/not-an-id/kept-file');
        expect(status).toBe(400);
        expect(service.getFileProblemKeptFile).not.toHaveBeenCalled();
      });
    });

    it('needs a folder to look in', async () => {
      const { status } = await request(ctx.getHttpServer()).post(`/media-health/files/${id}/look-in`).send({});
      expect(status).toBe(400);
      expect(service.lookInFolderForFileProblem).not.toHaveBeenCalled();
    });
  });
});
