import request from 'supertest';
import { AlbumSourceController } from 'src/controllers/album-source.controller.js';
import { AlbumSourceService } from 'src/services/album-source.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(AlbumSourceController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(AlbumSourceService);

  beforeAll(async () => {
    ctx = await controllerSetup(AlbumSourceController, [{ provide: AlbumSourceService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  it('requires authentication', async () => {
    const { status } = await request(ctx.getHttpServer()).get('/album-sources');
    expect(ctx.authenticate).toHaveBeenCalled();
    expect(status).toBe(200);
  });

  describe('POST /album-sources/resolve', () => {
    it('validates the sources', async () => {
      for (const sources of [
        [],
        [{ kind: 'dropbox', sourceId: 'x', name: 'x' }],
        [{ kind: 'ios-photos', sourceId: '', name: 'x' }],
        [{ kind: 'ios-photos', sourceId: 'x', name: ' '.repeat(3) }],
        Array.from({ length: 501 }, (_, index) => ({ kind: 'ios-photos', sourceId: String(index), name: 'x' })),
      ]) {
        const { status } = await request(ctx.getHttpServer()).post('/album-sources/resolve').send({ sources });
        expect(status).toBe(400);
      }
      expect(service.resolve).not.toHaveBeenCalled();
    });

    it('passes valid sources through, answering 200', async () => {
      service.resolve.mockResolvedValue({ links: [] });
      const sources = [{ kind: 'android-folder', sourceId: '12:DCIM/Camera', deviceKey: 'pixel', name: ' Camera ' }];
      const { status } = await request(ctx.getHttpServer()).post('/album-sources/resolve').send({ sources });
      expect(status).toBe(200);
      expect(service.resolve).toHaveBeenCalledWith(undefined, {
        sources: [{ ...sources[0], name: 'Camera' }],
      });
    });
  });

  describe('assets and links', () => {
    it('requires a uuid link id and asset ids', async () => {
      expect((await request(ctx.getHttpServer()).post('/album-sources/nope/assets').send({ ids: [] })).status).toBe(
        400,
      );
      expect(
        (
          await request(ctx.getHttpServer())
            .delete(`/album-sources/${factory.uuid()}/assets`)
            .send({ ids: ['x'] })
        ).status,
      ).toBe(400);
      expect(
        (await request(ctx.getHttpServer()).patch(`/album-sources/${factory.uuid()}`).send({ name: '' })).status,
      ).toBe(400);
    });

    it('unlinks with 204', async () => {
      service.delete.mockResolvedValue();
      const id = factory.uuid();
      const { status } = await request(ctx.getHttpServer()).delete(`/album-sources/${id}`);
      expect(status).toBe(204);
      expect(service.delete).toHaveBeenCalledWith(undefined, id);
    });
  });
});
