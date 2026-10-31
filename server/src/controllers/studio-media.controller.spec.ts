import request from 'supertest';
import { StudioMediaController } from 'src/controllers/studio-media.controller.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioMediaService } from 'src/services/studio-media.service.js';
import { ControllerContext, automock, controllerSetup } from 'test/utils.js';

const id = '44444444-4444-4444-8444-444444444444';

describe(StudioMediaController.name, () => {
  let ctx: ControllerContext;
  const service = automock(StudioMediaService, { args: [{ setContext: () => {} }], strict: false });

  beforeAll(async () => {
    ctx = await controllerSetup(StudioMediaController, [
      { provide: StudioMediaService, useValue: service },
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /assets/:id/filmstrip', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get(`/assets/${id}/filmstrip`);
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should parse count, height and format', async () => {
      await request(ctx.getHttpServer())
        .get(`/assets/${id}/filmstrip`)
        .query({ count: '12', height: '64', format: 'webp' });
      expect(service.getFilmstrip).toHaveBeenCalledWith(undefined, id, { count: 12, height: 64, format: 'webp' });
    });

    it('should reject out-of-range sizes and unknown formats', async () => {
      for (const query of [{ count: '0' }, { count: '121' }, { height: '16' }, { height: '241' }, { format: 'png' }]) {
        const { status } = await request(ctx.getHttpServer()).get(`/assets/${id}/filmstrip`).query(query);
        expect(status).toBe(400);
      }
      expect(service.getFilmstrip).not.toHaveBeenCalled();
    });

    it('should require a UUID', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/assets/123/filmstrip');
      expect(status).toBe(400);
    });
  });

  describe('GET /assets/:id/filmstrip/sprite', () => {
    it('should reject a malformed version', async () => {
      const { status } = await request(ctx.getHttpServer())
        .get(`/assets/${id}/filmstrip/sprite`)
        .query({ version: 'not-a-version' });
      expect(status).toBe(400);
      expect(service.viewFilmstripSprite).not.toHaveBeenCalled();
    });
  });

  describe('GET /assets/:id/waveform', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get(`/assets/${id}/waveform`);
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should parse buckets and channels', async () => {
      await request(ctx.getHttpServer()).get(`/assets/${id}/waveform`).query({ buckets: '500', channels: 'all' });
      expect(service.getWaveform).toHaveBeenCalledWith(undefined, id, { buckets: 500, channels: 'all' });
    });

    it('should reject out-of-range buckets', async () => {
      for (const buckets of ['0', '10001']) {
        const { status } = await request(ctx.getHttpServer()).get(`/assets/${id}/waveform`).query({ buckets });
        expect(status).toBe(400);
      }
      expect(service.getWaveform).not.toHaveBeenCalled();
    });
  });
});
