import request from 'supertest';
import { PartnerController } from 'src/controllers/partner.controller.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerLockedNoticeService } from 'src/services/partner-locked-notice.service.js';
import { PartnerService } from 'src/services/partner.service.js';
import { errorDto } from 'test/medium/responses.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

describe(PartnerController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(PartnerService);
  const noticeService = mockBaseService(PartnerLockedNoticeService);

  beforeAll(async () => {
    ctx = await controllerSetup(PartnerController, [
      { provide: PartnerService, useValue: service },
      { provide: PartnerLockedNoticeService, useValue: noticeService },
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    noticeService.resetAllMocks();
    ctx.reset();
  });

  describe('GET /partners/locked-notice', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get('/partners/locked-notice');
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('is not read as a partner id', async () => {
      noticeService.getNotice.mockResolvedValue({ show: true, flaggedAt: '2026-10-03T00:00:00.000Z' });
      const { status, body } = await request(ctx.getHttpServer())
        .get('/partners/locked-notice')
        .set('Authorization', `Bearer token`);
      expect(status).toBe(200);
      expect(body).toEqual({ show: true, flaggedAt: '2026-10-03T00:00:00.000Z' });
    });
  });

  describe('PUT /partners/locked-notice', () => {
    it('dismisses the notice instead of updating a partner', async () => {
      noticeService.dismiss.mockResolvedValue({ show: false, flaggedAt: '2026-10-03T00:00:00.000Z' });
      const { status } = await request(ctx.getHttpServer())
        .put('/partners/locked-notice')
        .set('Authorization', `Bearer token`);
      expect(status).toBe(200);
      expect(noticeService.dismiss).toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
    });
  });

  describe('GET /partners', () => {
    it(`should require a direction`, async () => {
      const { status, body } = await request(ctx.getHttpServer()).get(`/partners`).set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['direction'], message: expect.stringContaining('Invalid option: expected one of') },
        ]),
      );
    });

    it(`should require direction to be an enum`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .get(`/partners`)
        .query({ direction: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['direction'], message: expect.stringContaining('Invalid option: expected one of') },
        ]),
      );
    });
  });

  describe('POST /partners', () => {
    it(`should require sharedWithId to be a uuid`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post(`/partners`)
        .send({ sharedWithId: 'invalid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['sharedWithId'], message: 'Invalid UUID' }]));
    });
  });

  describe('PUT /partners/:id', () => {
    it(`should require id to be a uuid`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/partners/invalid`)
        .send({ inTimeline: true })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });
  });

  describe('DELETE /partners/:id', () => {
    it(`should require id to be a uuid`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .delete(`/partners/invalid`)
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['id'], message: 'Invalid UUID' }]));
    });
  });
});
