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
