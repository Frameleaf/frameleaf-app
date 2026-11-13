import request from 'supertest';
import { FoundFileAdminController } from 'src/controllers/found-file-admin.controller.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { FoundFilesService } from 'src/services/found-files.service.js';
import { ControllerContext, automock, controllerSetup } from 'test/utils.js';

describe(FoundFileAdminController.name, () => {
  let ctx: ControllerContext;
  const service = automock(FoundFilesService, { args: [{ setContext: () => {} }], strict: false });
  const id = '0194d6a5-7a6e-7c2a-9cb4-0a1c2d3e4f50';
  const owner = '9d2f0c1e-5b6a-4c7d-8e9f-0a1b2c3d4e5f';

  beforeAll(async () => {
    ctx = await controllerSetup(FoundFileAdminController, [
      { provide: FoundFilesService, useValue: service },
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  it.each([
    ['get', '/admin/found-files'],
    ['get', '/admin/found-files/files?outcome=back'],
    ['get', `/admin/found-files/files/${id}`],
    ['get', `/admin/found-files/files/${id}/file`],
    ['post', `/admin/found-files/files/${id}/undo`],
    ['post', '/admin/found-files/resolve'],
    ['post', '/admin/found-files/spare/delete'],
  ] as const)('%s %s requires authentication', async (method, url) => {
    await request(ctx.getHttpServer())[method](url);
    expect(ctx.authenticate).toHaveBeenCalled();
  });

  describe('GET /admin/found-files/files', () => {
    it('needs an outcome it knows', async () => {
      expect((await request(ctx.getHttpServer()).get('/admin/found-files/files')).status).toBe(400);
      expect((await request(ctx.getHttpServer()).get('/admin/found-files/files?outcome=tidied')).status).toBe(400);
      expect(service.list).not.toHaveBeenCalled();
    });

    it('passes the page through', async () => {
      service.list.mockResolvedValue({ items: [], nextCursor: null });
      const { status } = await request(ctx.getHttpServer()).get(
        `/admin/found-files/files?outcome=needs&reason=no-owner&size=20&cursor=${id}`,
      );
      expect(status).toBe(200);
      expect(service.list.mock.calls[0][1]).toEqual({ outcome: 'needs', reason: 'no-owner', size: 20, cursor: id });
    });
  });

  describe('POST /admin/found-files/files/:id/undo', () => {
    it('refuses an id that is not one', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/admin/found-files/files/nope/undo');
      expect(status).toBe(400);
      expect(service.undo).not.toHaveBeenCalled();
    });
  });

  describe('POST /admin/found-files/resolve', () => {
    it('refuses a reason no decision exists for', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/admin/found-files/resolve')
        .send({ reason: 'wont-open' });
      expect(status).toBe(400);
      expect(service.resolve).not.toHaveBeenCalled();
    });

    it('passes the decision through', async () => {
      const dto = { reason: 'no-owner', folder: '/data/upload/5b2e', ownerId: owner };
      service.resolve.mockResolvedValue({ back: 0, added: 2, spare: 0, waiting: 0, skipped: 0, nextCursor: null });
      const { status, body } = await request(ctx.getHttpServer()).post('/admin/found-files/resolve').send(dto);
      expect(status).toBe(200);
      expect(body.added).toBe(2);
      expect(service.resolve).toHaveBeenCalledWith(dto);
    });
  });

  describe('POST /admin/found-files/spare/delete', () => {
    it('refuses an empty list and more than a hundred at once', async () => {
      const post = (ids: string[]) =>
        request(ctx.getHttpServer()).post('/admin/found-files/spare/delete').send({ ids });
      expect((await post([])).status).toBe(400);
      expect((await post(Array.from({ length: 101 }, () => id))).status).toBe(400);
      expect(service.deleteSpares).not.toHaveBeenCalled();
    });

    it('deletes all of them when none are named', async () => {
      service.deleteSpares.mockResolvedValue({ deleted: 3, freedBytes: 30, kept: 1, nextCursor: null });
      const { status, body } = await request(ctx.getHttpServer()).post('/admin/found-files/spare/delete').send({});
      expect(status).toBe(200);
      expect(body).toEqual({ deleted: 3, freedBytes: 30, kept: 1, nextCursor: null });
    });
  });
});
