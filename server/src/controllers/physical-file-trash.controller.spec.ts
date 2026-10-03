import request from 'supertest';
import { PhysicalFileTrashController } from 'src/controllers/physical-file-trash.controller.js';
import { Permission } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhysicalFileTrashService } from 'src/services/physical-file-trash.service.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

describe(PhysicalFileTrashController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(PhysicalFileTrashService);
  const id = '9c3c4b8a-6a3e-4d8f-9a39-6f0c3f4b2a11';
  const adminOnly = expect.objectContaining({
    metadata: expect.objectContaining({ adminRoute: true, permission: Permission.Maintenance }),
  });

  beforeAll(async () => {
    ctx = await controllerSetup(PhysicalFileTrashController, [
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
      { provide: PhysicalFileTrashService, useValue: service },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  it('GET /admin/file-trash lists the file trash for an administrator', async () => {
    service.list.mockResolvedValue({ items: [], total: 0, totalBytes: 0 });

    const { status, body } = await request(ctx.getHttpServer()).get('/admin/file-trash').query({ page: 2 });

    expect(status).toBe(200);
    expect(body).toEqual({ items: [], total: 0, totalBytes: 0 });
    expect(service.list).toHaveBeenCalledWith({ page: 2, size: 100 });
    expect(ctx.authenticate).toHaveBeenCalledWith(adminOnly);
  });

  it('POST /admin/file-trash/:id/restore is administrator only', async () => {
    service.restore.mockResolvedValue({ assetId: 'asset-id' });

    const { status, body } = await request(ctx.getHttpServer()).post(`/admin/file-trash/${id}/restore`);

    expect(status).toBe(200);
    expect(body).toEqual({ assetId: 'asset-id' });
    expect(ctx.authenticate).toHaveBeenCalledWith(adminOnly);
  });

  it('DELETE /admin/file-trash/:id is administrator only', async () => {
    const { status } = await request(ctx.getHttpServer()).delete(`/admin/file-trash/${id}`);

    expect(status).toBe(204);
    expect(service.purge).toHaveBeenCalledWith(id);
    expect(ctx.authenticate).toHaveBeenCalledWith(adminOnly);
  });

  it('rejects an id that is not a UUID', async () => {
    const { status } = await request(ctx.getHttpServer()).delete('/admin/file-trash/not-a-uuid');

    expect(status).toBe(400);
  });
});
