import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { CastController } from 'src/controllers/cast.controller.js';
import { Permission } from 'src/enum.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { CastService } from 'src/services/cast.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

const reflector = new Reflector();

describe(CastController.name, () => {
  let ctx: ControllerContext;
  const service = { createMediaUrl: vi.fn(), resolveMediaUrl: vi.fn() };
  const media = { downloadOriginal: vi.fn(), playbackVideo: vi.fn(), viewThumbnail: vi.fn() };

  beforeAll(async () => {
    ctx = await controllerSetup(CastController, [
      { provide: CastService, useValue: service },
      { provide: AssetMediaService, useValue: media },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    for (const mock of [...Object.values(service), ...Object.values(media)]) {
      mock.mockReset();
    }
    ctx.reset();
  });

  it('issues URLs only to an authenticated account (no shared links) and reads them without one', () => {
    const options = (method: keyof CastController) =>
      getAuthenticatedOptions(reflector, CastController.prototype[method]);
    expect(options('createCastMediaUrl')).toMatchObject({ permission: Permission.AssetView });
    expect(options('createCastMediaUrl')).not.toMatchObject({ sharedLink: true });
    expect(options('readCastMedia')).toMatchObject({ public: true });
  });

  describe('POST /assets/:id/cast', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).post(`/assets/${factory.uuid()}/cast`).send({ kind: 'video' });
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should require a UUID and a known rendition', async () => {
      const bad = await request(ctx.getHttpServer()).post('/assets/123/cast').send({ kind: 'video' });
      expect(bad.status).toBe(400);
      const kind = await request(ctx.getHttpServer()).post(`/assets/${factory.uuid()}/cast`).send({ kind: 'raw' });
      expect(kind.status).toBe(400);
    });
  });

  describe('GET /cast/:token', () => {
    it('should refuse a malformed token before reading anything', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/cast/not-a-token');
      expect(status).toBe(400);
      expect(service.resolveMediaUrl).not.toHaveBeenCalled();
    });
  });
});
