import request from 'supertest';
import { DuplicateReviewController } from 'src/controllers/duplicate-review.controller.js';
import { Permission } from 'src/enum.js';
import { DuplicateDecisionService } from 'src/services/duplicate-decision.service.js';
import { ControllerContext, automock, controllerSetup } from 'test/utils.js';

describe(DuplicateReviewController.name, () => {
  let ctx: ControllerContext;
  const service = automock(DuplicateDecisionService, { args: [{ setContext: () => {} }], strict: false });

  beforeAll(async () => {
    ctx = await controllerSetup(DuplicateReviewController, [{ provide: DuplicateDecisionService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /duplicates/review', () => {
    it('should be an authenticated route that needs duplicate read permission', async () => {
      await request(ctx.getHttpServer()).get('/duplicates/review');

      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ permission: Permission.DuplicateRead, sharedLinkRoute: false }),
        }),
      );
    });
  });

  describe('GET /duplicates/review, a page at a time (FL-1795)', () => {
    it('passes the page on, and refuses one that is not a page', async () => {
      const after = '3fe388e4-2078-44d7-b36c-39d9dee3a657';
      await request(ctx.getHttpServer()).get(`/duplicates/review?take=250&after=${after}`).expect(200);
      expect(service.getReview).toHaveBeenCalledWith(undefined, { take: 250, after });

      await request(ctx.getHttpServer()).get('/duplicates/review?take=0').expect(400);
      await request(ctx.getHttpServer()).get('/duplicates/review?take=501').expect(400);
      await request(ctx.getHttpServer()).get('/duplicates/review?take=10&after=nope').expect(400);
    });
  });

  describe('GET /duplicates/decisions', () => {
    it('should be an authenticated route that needs duplicate read permission', async () => {
      await request(ctx.getHttpServer()).get('/duplicates/decisions');

      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ permission: Permission.DuplicateRead, sharedLinkRoute: false }),
        }),
      );
    });
  });
});
