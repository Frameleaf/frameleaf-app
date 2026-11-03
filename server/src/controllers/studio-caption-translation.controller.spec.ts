import request from 'supertest';
import { StudioCaptionTranslationController } from 'src/controllers/studio-caption-translation.controller.js';
import { StudioCaptionTranslationService } from 'src/services/studio-caption-translation.service.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

const projectId = '0195e2a0-0000-7000-8000-000000000010';

describe(StudioCaptionTranslationController.name, () => {
  let ctx: ControllerContext;
  const service = { translate: vi.fn() };

  beforeAll(async () => {
    ctx = await controllerSetup(StudioCaptionTranslationController, [
      { provide: StudioCaptionTranslationService, useValue: service },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.translate.mockReset();
    ctx.reset();
  });

  describe('POST /studio/projects/:id/caption-translations', () => {
    const url = `/studio/projects/${projectId}/caption-translations`;

    it('needs a signed-in person', async () => {
      await request(ctx.getHttpServer())
        .post(url)
        .send({ source: 'en', target: 'fr', lines: ['Hi'] });
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('translates and answers 200', async () => {
      service.translate.mockResolvedValue({
        source: 'en',
        target: 'fr',
        lines: ['Salut'],
        model: 'm2m100-418m',
        destinationId: '0195e2a0-0000-4000-8000-000000000031',
      });
      const { status, body } = await request(ctx.getHttpServer())
        .post(url)
        .send({ source: 'en', target: 'fr', lines: ['Hi'] });
      expect(status).toBe(200);
      expect(body.lines).toEqual(['Salut']);
      expect(service.translate).toHaveBeenCalledWith(undefined, projectId, {
        source: 'en',
        target: 'fr',
        lines: ['Hi'],
      });
    });

    it('refuses a language Studio does not offer', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post(url)
        .send({ source: 'en', target: 'ja', lines: ['Hi'] });
      expect(status).toBe(400);
      expect(service.translate).not.toHaveBeenCalled();
    });

    it('refuses a project id that is not a UUIDv7', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/studio/projects/not-an-id/caption-translations')
        .send({ source: 'en', target: 'fr', lines: ['Hi'] });
      expect(status).toBe(400);
    });
  });
});
