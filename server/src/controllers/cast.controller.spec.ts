import { Reflector } from '@nestjs/core';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { CastController } from 'src/controllers/cast.controller.js';
import { CacheControl, Permission } from 'src/enum.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { CastService } from 'src/services/cast.service.js';
import { CastMediaKind } from 'src/utils/cast-media.js';
import { ImmichFileResponse } from 'src/utils/file.js';
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
    it('serves preview bytes and video byte ranges through the media route without original fallback', async () => {
      const folder = await mkdtemp(join(tmpdir(), 'frameleaf-cast-route-'));
      try {
        const path = join(folder, 'synthetic.bin');
        const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
        await writeFile(path, bytes);
        const file = new ImmichFileResponse({
          path,
          contentType: 'application/octet-stream',
          cacheControl: CacheControl.PrivateWithoutCache,
        });
        const auth = factory.auth({ session: {} });
        const assetId = factory.uuid();
        service.resolveMediaUrl.mockResolvedValue({ auth, assetId, kind: CastMediaKind.Preview });
        media.viewThumbnail.mockResolvedValue(file);
        const preview = await request(ctx.getHttpServer()).get('/cast/payload.signature');
        expect(preview.status).toBe(200);
        expect(preview.body).toEqual(bytes);
        expect(media.downloadOriginal).not.toHaveBeenCalled();
        service.resolveMediaUrl.mockResolvedValue({ auth, assetId, kind: CastMediaKind.Video });
        media.playbackVideo.mockResolvedValue(file);
        const video = await request(ctx.getHttpServer()).get('/cast/payload.signature').set('Range', 'bytes=2-5');
        expect(video.status).toBe(206);
        expect(video.headers['content-range']).toBe('bytes 2-5/8');
        expect(video.body).toEqual(bytes.subarray(2, 6));
        service.resolveMediaUrl.mockResolvedValue({ auth, assetId, kind: CastMediaKind.Preview });
        media.viewThumbnail.mockResolvedValue({ url: '/original' });
        const missing = await request(ctx.getHttpServer()).get('/cast/payload.signature');
        expect(missing.status).toBe(404);
        expect(missing.headers.location).toBeUndefined();
        expect(media.downloadOriginal).not.toHaveBeenCalled();
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });

    it('should refuse a malformed token before reading anything', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/cast/not-a-token');
      expect(status).toBe(400);
      expect(service.resolveMediaUrl).not.toHaveBeenCalled();
    });
  });
});
