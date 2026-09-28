import request from 'supertest';
import { UserController } from 'src/controllers/user.controller.js';
import { Permission } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { FrameleafLicenseService } from 'src/services/frameleaf-license.service.js';
import { UserService } from 'src/services/user.service.js';
import { errorDto } from 'test/medium/responses.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

describe(UserController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(UserService);

  beforeAll(async () => {
    ctx = await controllerSetup(UserController, [
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
      { provide: UserService, useValue: service },
      { provide: FrameleafLicenseService, useValue: mockBaseService(FrameleafLicenseService) },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('PUT /users/me', () => {
    for (const [key, message] of [
      ['email', 'Invalid input: expected email, received object'],
      ['name', 'Invalid input: expected string, received null'],
    ] as const) {
      it(`should not allow null ${key}`, async () => {
        const { status, body } = await request(ctx.getHttpServer())
          .put(`/users/me`)
          .set('Authorization', `Bearer token`)
          .send({ [key]: null });
        expect(status).toBe(400);
        expect(body).toEqual(errorDto.validationError([{ path: [key], message }]));
      });
    }

    it('should allow an empty avatarColor', async () => {
      await request(ctx.getHttpServer())
        .put(`/users/me`)
        .set('Authorization', `Bearer token`)
        .send({ avatarColor: null });
      expect(service.updateMe).toHaveBeenCalledWith(undefined, expect.objectContaining({ avatarColor: null }));
    });
  });

  describe('PUT /users/me/preferences', () => {
    it('should require an integer for download archive size', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/users/me/preferences`)
        .set('Authorization', `Bearer token`)
        .send({ download: { archiveSize: 1_234_567.89 } });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['download', 'archiveSize'], message: 'Invalid input: expected int, received number' },
        ]),
      );
    });

    it('should require a boolean for download include embedded videos', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/users/me/preferences`)
        .set('Authorization', `Bearer token`)
        .send({ download: { includeEmbeddedVideos: 1_234_567.89 } });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['download', 'includeEmbeddedVideos'], message: 'Invalid input: expected boolean, received number' },
        ]),
      );
    });
  });

  describe('PUT /users/me/preferences savedSearches (FL-49)', () => {
    const put = (savedSearches: unknown) =>
      request(ctx.getHttpServer())
        .put(`/users/me/preferences`)
        .set('Authorization', `Bearer token`)
        .send({ savedSearches });

    it('accepts named search bodies', async () => {
      const { status } = await put([{ name: ' Beach ', query: { filter: { city: { eq: 'Lisbon' } } } }]);
      expect(status).toBe(200);
      expect(service.updateMyPreferences).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ savedSearches: [{ name: 'Beach', query: { filter: { city: { eq: 'Lisbon' } } } }] }),
      );
    });

    it('rejects an empty name, duplicate names and too many searches', async () => {
      expect((await put([{ name: '  ', query: {} }])).status).toBe(400);
      expect(
        (
          await put([
            { name: 'A', query: {} },
            { name: 'a', query: {} },
          ])
        ).status,
      ).toBe(400);
      expect((await put(Array.from({ length: 51 }, (_, index) => ({ name: `s${index}`, query: {} })))).status).toBe(
        400,
      );
    });

    it('rejects an oversized query and a query that is not an object', async () => {
      expect((await put([{ name: 'big', query: { text: 'x'.repeat(9000) } }])).status).toBe(400);
      expect((await put([{ name: 'list', query: ['a'] }])).status).toBe(400);
    });
  });

  describe('GET /users/me/preferences/history (FL-71 CC-10)', () => {
    it("serves the signed-in account's own history with the preference read permission", async () => {
      service.getMyPreferenceHistory.mockResolvedValue({ entries: [] });

      const { status, body } = await request(ctx.getHttpServer()).get('/users/me/preferences/history');

      expect(status).toBe(200);
      expect(body).toEqual({ entries: [] });
      expect(service.getMyPreferenceHistory).toHaveBeenCalledWith(undefined);
      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ adminRoute: false, permission: Permission.UserPreferenceRead }),
        }),
      );
    });
  });
});
