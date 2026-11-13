import request from 'supertest';
import { ConnectMediaController } from 'src/controllers/connect-media.controller.js';
import { ConnectMediaService } from 'src/services/connect-media.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

describe('Connect upload HTTP resume contract', () => {
  let ctx: ControllerContext;
  const service = { state: vi.fn() };

  beforeAll(async () => {
    ctx = await controllerSetup(ConnectMediaController, [{ provide: ConnectMediaService, useValue: service }]);
    return () => ctx.close();
  });

  it.each(['receiving', 'published'])(
    'returns durable HEAD headers for a %s upload before GET routing',
    async (state) => {
      const upload = {
        id: factory.uuid(),
        offset: 8,
        size: 16,
        state,
        expiresAt: '2027-01-01T00:00:00.000Z',
      };
      service.state.mockResolvedValue(upload);
      const head = await request(ctx.getHttpServer()).head(`/connect/uploads/${upload.id}`);
      expect(head.status).toBe(204);
      expect(head.text).toBeUndefined();
      expect(head.headers).toMatchObject({
        'upload-draft-interop-version': '9',
        'upload-offset': '8',
        'upload-length': '16',
        'upload-complete': state === 'published' ? '?1' : '?0',
        'cache-control': 'private, no-store',
      });
      const get = await request(ctx.getHttpServer()).get(`/connect/uploads/${upload.id}`);
      expect(get.status).toBe(200);
      expect(get.body).toEqual(upload);
      expect(ctx.authenticate).toHaveBeenCalled();
    },
  );
});
