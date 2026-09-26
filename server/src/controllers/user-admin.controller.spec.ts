import request from 'supertest';
import { UserAdminController } from 'src/controllers/user-admin.controller.js';
import { UserAdminCreateDto } from 'src/dtos/user.dto.js';
import { Permission } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserAdminService } from 'src/services/user-admin.service.js';
import { errorDto } from 'test/medium/responses.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

describe(UserAdminController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(UserAdminService);

  beforeAll(async () => {
    ctx = await controllerSetup(UserAdminController, [
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
      { provide: UserAdminService, useValue: service },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('POST /admin/users', () => {
    it('should allow a null pinCode', async () => {
      await request(ctx.getHttpServer()).post(`/admin/users`).send({
        name: 'Test user',
        email: 'test@example.com',
        password: 'password',
        pinCode: null,
      });
      expect(service.create).toHaveBeenCalledWith(undefined, expect.objectContaining({ pinCode: null }));
    });

    it('should allow a null avatarColor', async () => {
      await request(ctx.getHttpServer()).post(`/admin/users`).send({
        name: 'Test user',
        email: 'test@example.com',
        password: 'password',
        avatarColor: null,
      });
      expect(service.create).toHaveBeenCalledWith(undefined, expect.objectContaining({ avatarColor: null }));
    });

    for (const [key, message] of [
      ['password', 'Invalid input: expected string, received null'],
      ['email', 'Invalid input: expected email, received object'],
      ['name', 'Invalid input: expected string, received null'],
      ['shouldChangePassword', 'Invalid input: expected boolean, received null'],
      ['notify', 'Invalid input: expected boolean, received null'],
    ] as const) {
      it(`should not allow null ${key}`, async () => {
        const { status, body } = await request(ctx.getHttpServer())
          .post(`/admin/users`)
          .set('Authorization', `Bearer token`)
          .send({ email: 'user@immich.app', password: 'test', name: 'Test User', [key]: null });
        expect(status).toBe(400);
        expect(body).toEqual(errorDto.validationError([{ path: [key], message }]));
      });
    }

    it(`should not allow decimal quota`, async () => {
      const dto: UserAdminCreateDto = {
        email: 'user@immich.app',
        password: 'test',
        name: 'Test User',
        quotaSizeInBytes: 1.2,
      };

      const { status, body } = await request(ctx.getHttpServer())
        .post(`/admin/users`)
        .set('Authorization', `Bearer token`)
        .send(dto);
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['quotaSizeInBytes'], message: 'Invalid input: expected int, received number' },
        ]),
      );
    });
  });

  describe('PUT /admin/users/:id', () => {
    it(`should not allow decimal quota`, async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/admin/users/${factory.uuid()}`)
        .set('Authorization', `Bearer token`)
        .send({ quotaSizeInBytes: 1.2 });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['quotaSizeInBytes'], message: 'Invalid input: expected int, received number' },
        ]),
      );
    });

    it('should allow a null pinCode', async () => {
      const id = factory.uuid();
      await request(ctx.getHttpServer()).put(`/admin/users/${id}`).send({ pinCode: null });
      expect(service.update).toHaveBeenCalledWith(undefined, id, expect.objectContaining({ pinCode: null }));
    });

    it('should allow a null avatarColor', async () => {
      const id = factory.uuid();
      await request(ctx.getHttpServer()).put(`/admin/users/${id}`).send({ avatarColor: null });
      expect(service.update).toHaveBeenCalledWith(undefined, id, expect.objectContaining({ avatarColor: null }));
    });

    for (const [key, message] of [
      ['password', 'Invalid input: expected string, received null'],
      ['email', 'Invalid input: expected email, received object'],
      ['name', 'Invalid input: expected string, received null'],
      ['shouldChangePassword', 'Invalid input: expected boolean, received null'],
    ] as const) {
      it(`should not allow null ${key}`, async () => {
        const { status, body } = await request(ctx.getHttpServer())
          .put(`/admin/users/${factory.uuid()}`)
          .set('Authorization', `Bearer token`)
          .send({ [key]: null });
        expect(status).toBe(400);
        expect(body).toEqual(errorDto.validationError([{ path: [key], message }]));
      });
    }
  });

  describe('GET /admin/users/:id/history (FL-76)', () => {
    it('should pass the page to the service', async () => {
      const id = factory.uuid();

      const { status } = await request(ctx.getHttpServer()).get(`/admin/users/${id}/history`).query({ take: 20 });

      expect(status).toBe(200);
      expect(service.getHistory).toHaveBeenCalledWith(undefined, id, { take: 20 });
    });

    it('should reject a page size over 200', async () => {
      const { status } = await request(ctx.getHttpServer())
        .get(`/admin/users/${factory.uuid()}/history`)
        .query({ take: 201 })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
    });

    it('should reject a cursor that is not an event id', async () => {
      const { status } = await request(ctx.getHttpServer())
        .get(`/admin/users/${factory.uuid()}/history`)
        .query({ before: 'not-a-uuid' })
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
    });
  });

  describe('DELETE /admin/users/:id/sessions/:sessionId (FL-76)', () => {
    it('should call the service with both ids', async () => {
      const id = factory.uuid();
      const sessionId = factory.uuid();

      const { status } = await request(ctx.getHttpServer()).delete(`/admin/users/${id}/sessions/${sessionId}`);

      expect(status).toBe(204);
      expect(service.deleteSession).toHaveBeenCalledWith(undefined, id, sessionId);
    });

    it('should reject a non-uuid session id', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .delete(`/admin/users/${factory.uuid()}/sessions/not-a-uuid`)
        .set('Authorization', `Bearer token`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.validationError([{ path: ['sessionId'], message: 'Invalid UUID' }]));
    });
  });

  describe('GET /admin/users/:id/pin-code (FL-76)', () => {
    it('returns whether the account has a PIN', async () => {
      const id = factory.uuid();
      service.getPinCodeState.mockResolvedValue({ pinCode: true });

      const { status, body } = await request(ctx.getHttpServer()).get(`/admin/users/${id}/pin-code`);

      expect(status).toBe(200);
      expect(body).toEqual({ pinCode: true });
      expect(service.getPinCodeState).toHaveBeenCalledWith(undefined, id);
    });

    it('asks for an administrator with adminUser.read', async () => {
      service.getPinCodeState.mockResolvedValue({ pinCode: false });
      await request(ctx.getHttpServer()).get(`/admin/users/${factory.uuid()}/pin-code`);

      expect(ctx.authenticate).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ adminRoute: true, permission: Permission.AdminUserRead }),
        }),
      );
    });

    it('requires a uuid', async () => {
      const { status } = await request(ctx.getHttpServer()).get(`/admin/users/not-a-uuid/pin-code`);

      expect(status).toBe(400);
      expect(service.getPinCodeState).not.toHaveBeenCalled();
    });
  });
});
