import request from 'supertest';
import { AssistantController } from 'src/controllers/assistant.controller.js';
import { AssistantActionService } from 'src/services/assistant-action.service.js';
import { AssistantService } from 'src/services/assistant.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

describe(AssistantController.name, () => {
  let ctx: ControllerContext;
  const service = { ask: vi.fn() };
  const actions = { propose: vi.fn(), apply: vi.fn(), undo: vi.fn(), getAll: vi.fn() };
  const actionId = '0195e2a0-0000-7000-8000-000000000001';

  beforeAll(async () => {
    ctx = await controllerSetup(AssistantController, [
      { provide: AssistantService, useValue: service },
      { provide: AssistantActionService, useValue: actions },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.ask.mockReset();
    for (const mock of Object.values(actions)) {
      mock.mockReset();
    }
    ctx.reset();
  });

  describe('POST /assistant/ask', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).post('/assistant/ask').send({ query: 'beach' });
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should require a question', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/assistant/ask').send({ query: '  ' });
      expect(status).toBe(400);
      expect(service.ask).not.toHaveBeenCalled();
    });

    it('should cap the result size', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/assistant/ask').send({ query: 'beach', size: 5000 });
      expect(status).toBe(400);
    });
  });

  describe('POST /assistant/actions', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer())
        .post('/assistant/actions')
        .send({ tool: 'favourite', assetIds: [factory.uuid()] });
      expect(ctx.authenticate).toHaveBeenCalled();
      expect(actions.propose).toHaveBeenCalled();
    });

    it('should refuse a tool that is not a write tool', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/assistant/actions')
        .send({ tool: 'delete', assetIds: [factory.uuid()] });
      expect(status).toBe(400);
      expect(actions.propose).not.toHaveBeenCalled();
    });

    it('should require the items', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/assistant/actions')
        .send({ tool: 'favourite', assetIds: [] });
      expect(status).toBe(400);
      expect(actions.propose).not.toHaveBeenCalled();
    });
  });

  describe('POST /assistant/actions/:id/apply', () => {
    it('should need the explicit confirmation', async () => {
      for (const body of [{}, { confirm: false }, { confirm: 'true' }]) {
        const { status } = await request(ctx.getHttpServer()).post(`/assistant/actions/${actionId}/apply`).send(body);
        expect(status).toBe(400);
      }
      expect(actions.apply).not.toHaveBeenCalled();
    });

    it('should apply a confirmed proposal', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post(`/assistant/actions/${actionId}/apply`)
        .send({ confirm: true });
      expect(status).toBe(200);
      expect(ctx.authenticate).toHaveBeenCalled();
      expect(actions.apply).toHaveBeenCalledWith(undefined, actionId);
    });
  });

  describe('POST /assistant/actions/:id/undo', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).post(`/assistant/actions/${actionId}/undo`);
      expect(ctx.authenticate).toHaveBeenCalled();
      expect(actions.undo).toHaveBeenCalledWith(undefined, actionId);
    });

    it('should refuse an id that is not an action id', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/assistant/actions/nope/undo');
      expect(status).toBe(400);
    });
  });

  describe('GET /assistant/actions', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get('/assistant/actions').query({ take: 10 });
      expect(ctx.authenticate).toHaveBeenCalled();
      expect(actions.getAll).toHaveBeenCalledWith(undefined, { take: 10 });
    });
  });
});
