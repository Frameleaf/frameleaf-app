import request from 'supertest';
import { AssistantController } from 'src/controllers/assistant.controller.js';
import { AssistantService } from 'src/services/assistant.service.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

describe(AssistantController.name, () => {
  let ctx: ControllerContext;
  const service = { ask: vi.fn() };

  beforeAll(async () => {
    ctx = await controllerSetup(AssistantController, [{ provide: AssistantService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.ask.mockReset();
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
});
