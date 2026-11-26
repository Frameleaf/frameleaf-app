import request from 'supertest';
import { vi } from 'vitest';
import { LocationHistoryController } from 'src/controllers/location-history.controller.js';
import { LocationHistoryService } from 'src/services/location-history.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

describe(LocationHistoryController.name, () => {
  let ctx: ControllerContext;
  const service = {
    createUpload: vi.fn(),
    uploadChunk: vi.fn(),
    createSource: vi.fn(),
    getSources: vi.fn(),
    deleteSource: vi.fn(),
  };
  const base = '/users/me/location-history';
  const id = factory.uuid();

  beforeAll(async () => {
    ctx = await controllerSetup(LocationHistoryController, [{ provide: LocationHistoryService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    ctx.reset();
  });

  it('requires authentication', async () => {
    await request(ctx.getHttpServer()).get(`${base}/sources`);
    expect(ctx.authenticate).toHaveBeenCalled();
  });

  it('lists the files', async () => {
    service.getSources.mockResolvedValue([]);
    const { status, body } = await request(ctx.getHttpServer()).get(`${base}/sources`);
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it.each([
    ['no size', {}],
    ['an empty file', { size: 0 }],
    ['a file larger than any history', { size: 9 * 1024 ** 3 }],
  ])('refuses an upload of %s', async (_, body) => {
    const { status } = await request(ctx.getHttpServer()).post(`${base}/uploads`).send(body);
    expect(status).toBe(400);
    expect(service.createUpload).not.toHaveBeenCalled();
  });

  it('takes a part as bytes at its offset', async () => {
    service.uploadChunk.mockResolvedValue({ id, receivedBytes: 4 });
    const { status, body } = await request(ctx.getHttpServer())
      .put(`${base}/uploads/${id}?offset=0`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('<gpx'));
    expect(status).toBe(200);
    expect(body).toEqual({ id, receivedBytes: 4 });
    expect(service.uploadChunk).toHaveBeenCalledWith(undefined, id, 0, Buffer.from('<gpx'));
  });

  it.each([
    ['a part that is not bytes', (test: request.Test) => test.send({ data: 'x' })],
    [
      'a part without an offset',
      (test: request.Test) => test.set('Content-Type', 'application/octet-stream').send('x'),
    ],
  ])('refuses %s', async (_, send) => {
    const url = `${base}/uploads/${id}${_.includes('offset') ? '' : '?offset=0'}`;
    const { status } = await send(request(ctx.getHttpServer()).put(url));
    expect(status).toBe(400);
    expect(service.uploadChunk).not.toHaveBeenCalled();
  });

  it.each([
    ['no upload', { fileName: 'Records.json' }],
    ['no name', { uploadId: id, fileName: ' ' }],
  ])('refuses to add a file with %s', async (_, body) => {
    const { status } = await request(ctx.getHttpServer()).post(`${base}/sources`).send(body);
    expect(status).toBe(400);
    expect(service.createSource).not.toHaveBeenCalled();
  });

  it('removes a file', async () => {
    const sourceId = '01a2035e-0a5a-7051-a32b-b70220746416';
    const { status } = await request(ctx.getHttpServer()).delete(`${base}/sources/${sourceId}`);
    expect(status).toBe(204);
    expect(service.deleteSource).toHaveBeenCalledWith(undefined, sourceId);
  });
});
