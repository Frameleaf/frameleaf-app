import request from 'supertest';
import { HelpController } from 'src/controllers/help.controller.js';
import { HelpService } from 'src/services/help.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(HelpController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(HelpService);

  beforeAll(async () => {
    ctx = await controllerSetup(HelpController, [{ provide: HelpService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  it('requires authentication for every route', async () => {
    for (const [method, path] of [
      ['get', '/help/index'],
      ['get', '/help/articles/using/sharing'],
      ['post', '/help/ask'],
    ] as const) {
      await request(ctx.getHttpServer())[method](path);
      expect(ctx.authenticate).toHaveBeenCalled();
      ctx.authenticate.mockClear();
    }
  });

  it('reads an article by its section and name', async () => {
    await request(ctx.getHttpServer()).get('/help/articles/using/sharing').expect(200);
    expect(service.getArticle).toHaveBeenCalledWith('using/sharing');
  });

  it('checks a question before it is relayed', async () => {
    for (const body of [
      {},
      { question: ' ' },
      { question: 'x'.repeat(4001) },
      { question: 'Hi', turns: Array.from({ length: 7 }, () => ({ role: 'user', text: 'a' })) },
    ]) {
      await request(ctx.getHttpServer()).post('/help/ask').send(body).expect(400);
    }
    expect(service.ask).not.toHaveBeenCalled();
    await request(ctx.getHttpServer())
      .post('/help/ask')
      .send({ question: 'How do I share?', screen: 'albums' })
      .expect(200);
    const [, dto, signal] = service.ask.mock.calls[0];
    expect(dto).toEqual({ question: 'How do I share?', turns: [], screen: 'albums' });
    // answering must not count as the browser going away
    expect(signal.aborted).toBe(false);
  });
});
