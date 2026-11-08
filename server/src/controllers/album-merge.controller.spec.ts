import request from 'supertest';
import { AlbumMergeController } from 'src/controllers/album-merge.controller.js';
import { AlbumChangeRunService } from 'src/services/album-change-run.service.js';
import { AlbumMergeService } from 'src/services/album-merge.service.js';
import { newUuid } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(AlbumMergeController.name, () => {
  let ctx: ControllerContext;
  const merge = mockBaseService(AlbumMergeService);
  const runs = mockBaseService(AlbumChangeRunService);

  beforeAll(async () => {
    ctx = await controllerSetup(AlbumMergeController, [
      { provide: AlbumMergeService, useValue: merge },
      { provide: AlbumChangeRunService, useValue: runs },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    merge.resetAllMocks();
    runs.resetAllMocks();
    ctx.reset();
  });

  it('requires authentication', async () => {
    await request(ctx.getHttpServer()).get('/albums/change-runs/latest');
    expect(ctx.authenticate).toHaveBeenCalled();
  });

  describe('GET /albums/:id/merge/:otherId', () => {
    it('refuses ids that are not UUIDs', async () => {
      const { status } = await request(ctx.getHttpServer()).get(`/albums/${newUuid()}/merge/not-a-uuid`);
      expect(status).toBe(400);
      expect(merge.getPreview).not.toHaveBeenCalled();
    });

    it('passes both ids through', async () => {
      const [id, otherId] = [newUuid(), newUuid()];
      merge.getPreview.mockResolvedValue({
        winnerId: id,
        total: 1,
        inBoth: 0,
        winnerShared: false,
        loserShared: false,
      });

      const { status } = await request(ctx.getHttpServer()).get(`/albums/${id}/merge/${otherId}`);

      expect(status).toBe(200);
      expect(merge.getPreview).toHaveBeenCalledWith(undefined, id, otherId);
    });
  });

  describe('POST /albums/:id/merge', () => {
    it('requires the other album', async () => {
      const { status } = await request(ctx.getHttpServer()).post(`/albums/${newUuid()}/merge`).send({});
      expect(status).toBe(400);
      expect(merge.merge).not.toHaveBeenCalled();
    });

    it('answers 200 with the run and the winner', async () => {
      const [id, otherId, runId] = [newUuid(), newUuid(), newUuid()];
      merge.merge.mockResolvedValue({ runId, winnerId: otherId });

      const { status, body } = await request(ctx.getHttpServer()).post(`/albums/${id}/merge`).send({ otherId });

      expect(status).toBe(200);
      expect(body).toEqual({ runId, winnerId: otherId });
      expect(merge.merge).toHaveBeenCalledWith(undefined, id, { otherId });
    });
  });

  it('POST /albums/change-runs/latest/undo answers 200 with what it did', async () => {
    runs.undoLatest.mockResolvedValue({ reversed: 3, skipped: ['Beach'] });

    const { status, body } = await request(ctx.getHttpServer()).post('/albums/change-runs/latest/undo').send({});

    expect(status).toBe(200);
    expect(body).toEqual({ reversed: 3, skipped: ['Beach'] });
  });

  it('POST /albums/change-runs/latest/undo passes on which run was meant', async () => {
    runs.undoLatest.mockResolvedValue({ reversed: 1, skipped: [] });
    const runId = '019a0000-0000-7000-8000-000000000001';

    const { status } = await request(ctx.getHttpServer()).post('/albums/change-runs/latest/undo').send({ runId });

    expect(status).toBe(200);
    expect(runs.undoLatest.mock.calls[0][1]).toEqual({ runId });
  });
});
