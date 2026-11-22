import { Writable } from 'node:stream';
import request from 'supertest';
import { SyncController } from 'src/controllers/sync.controller.js';
import { GlobalExceptionFilter } from 'src/middleware/global-exception.filter.js';
import { SyncService } from 'src/services/sync.service.js';
import { errorDto } from 'test/medium/responses.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(SyncController.name, () => {
  let ctx: ControllerContext;
  const syncService = mockBaseService(SyncService);
  const errorService = { handleError: vi.fn() };

  beforeAll(async () => {
    ctx = await controllerSetup(SyncController, [
      { provide: SyncService, useValue: syncService },
      { provide: GlobalExceptionFilter, useValue: errorService },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    syncService.resetAllMocks();
    errorService.handleError.mockReset();
    ctx.reset();
  });

  describe('POST /sync/stream', () => {
    it('should require sync request type enums', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/sync/stream')
        .send({ types: ['invalid'] });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['types', 0], message: expect.stringContaining('Invalid option: expected one of') },
        ]),
      );
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should end the connection when the stream fails after its first line', async () => {
      syncService.stream.mockImplementation((_auth, res) => {
        (res as Writable).write('{"type":"AssetV2"}\n');
        return Promise.reject(new Error('lock timeout'));
      });
      // An idle open stream would leave the client waiting for its own timeout; a closed one fails at once.
      const error = await request(ctx.getHttpServer())
        .post('/sync/stream')
        .send({ types: ['AssetsV2'] })
        .timeout(5000)
        .then(
          () => {},
          (error: { code?: string; timeout?: number }) => error,
        );
      expect(error).toBeDefined();
      expect(error?.timeout).toBeUndefined();
      expect(errorService.handleError).toHaveBeenCalled();
    });
  });

  describe('POST /sync/ack', () => {
    it('should not allow more than 1,000 entries', async () => {
      const acks = Array.from({ length: 1001 }, (_, i) => `ack-${i}`);
      const { status, body } = await request(ctx.getHttpServer()).post('/sync/ack').send({ acks });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([{ path: ['acks'], message: 'Too big: expected array to have <=1000 items' }]),
      );
      expect(ctx.authenticate).toHaveBeenCalled();
    });
  });

  describe('DELETE /sync/ack', () => {
    it('should require sync response type enums', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .delete('/sync/ack')
        .send({ types: ['invalid'] });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['types', 0], message: expect.stringContaining('Invalid option: expected one of') },
        ]),
      );
      expect(ctx.authenticate).toHaveBeenCalled();
    });
  });
});
