import { request as httpRequest } from 'node:http';
import { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import request from 'supertest';
import { DownloadController } from 'src/controllers/download.controller.js';
import { DownloadService } from 'src/services/download.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(DownloadController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(DownloadService);

  beforeAll(async () => {
    ctx = await controllerSetup(DownloadController, [{ provide: DownloadService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('POST /download/archive', () => {
    it('should accept comma-separated assetIds string', async () => {
      const downloadArchiveSpy = vi.spyOn(service, 'downloadArchive');
      service.downloadArchive.mockResolvedValue({ stream: Readable.from('') });

      const ids = [factory.uuid(), factory.uuid()];
      const { status } = await request(ctx.getHttpServer())
        .post(`/download/archive`)
        .type('form')
        .send({ assetIds: ids.join(',') });
      expect(status).toBe(200);
      expect(downloadArchiveSpy).toHaveBeenCalledWith(undefined, { assetIds: ids });
    });

    it('destroys the archive stream when the client goes away (FL-54 review B2)', async () => {
      const stream = new Readable({ read() {} });
      stream.push(Buffer.alloc(64 * 1024, 1)); // the archive has started, then stalls
      service.downloadArchive.mockResolvedValue({ stream });

      const server = ctx.getHttpServer();
      if (!server.listening) {
        await new Promise<void>((resolve) => server.listen(0, resolve));
      }
      const { port } = server.address() as AddressInfo;

      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          { port, method: 'POST', path: '/download/archive', headers: { 'content-type': 'application/json' } },
          (res) => {
            res.once('data', () => {
              req.destroy();
              resolve();
            });
          },
        );
        req.on('error', (error) => (req.destroyed ? resolve() : reject(error)));
        req.end(JSON.stringify({ assetIds: [factory.uuid()] }));
      });

      await vi.waitFor(() => expect(stream.destroyed).toBe(true));
    });

    it('destroys the archive stream when the client left before it was ready (FL-54 follow-up)', async () => {
      const stream = new Readable({ read() {} });
      let clientGone!: () => void;
      const gone = new Promise<void>((resolve) => (clientGone = resolve));
      service.downloadArchive.mockImplementation(async () => {
        await gone; // the queries finish only after the client has disconnected
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { stream };
      });

      const server = ctx.getHttpServer();
      if (!server.listening) {
        await new Promise<void>((resolve) => server.listen(0, resolve));
      }
      const { port } = server.address() as AddressInfo;

      const req = httpRequest({
        port,
        method: 'POST',
        path: '/download/archive',
        headers: { 'content-type': 'application/json' },
      });
      req.on('error', () => {});
      req.end(JSON.stringify({ assetIds: [factory.uuid()] }));
      await vi.waitFor(() => expect(service.downloadArchive).toHaveBeenCalled());
      req.destroy();
      clientGone();

      await vi.waitFor(() => expect(stream.destroyed).toBe(true));
    });

    it('should accept assetIds array', async () => {
      const downloadArchiveSpy = vi.spyOn(service, 'downloadArchive');
      service.downloadArchive.mockResolvedValue({ stream: Readable.from('') });

      const ids = [factory.uuid(), factory.uuid()];
      const { status } = await request(ctx.getHttpServer()).post(`/download/archive`).send({
        assetIds: ids,
      });
      expect(status).toBe(200);
      expect(downloadArchiveSpy).toHaveBeenCalledWith(undefined, { assetIds: ids });
    });
  });
});
