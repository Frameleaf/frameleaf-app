import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { PushController } from 'src/controllers/push.controller.js';
import { Permission } from 'src/enum.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';
import { PushService } from 'src/services/push.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

const reflector = new Reflector();
const key = Buffer.alloc(32, 9).toString('base64url');

describe(PushController.name, () => {
  let ctx: ControllerContext;
  const service = {
    getStatus: vi.fn(),
    listDevices: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    unregisterCurrent: vi.fn(),
    remove: vi.fn(),
    setActivityToken: vi.fn(),
    removeActivityToken: vi.fn(),
    sendTest: vi.fn(),
  };

  beforeAll(async () => {
    ctx = await controllerSetup(PushController, [{ provide: PushService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    for (const mock of Object.values(service)) {
      mock.mockReset();
    }
    ctx.reset();
  });

  it('keeps reads and registry changes on session scopes, never admin', () => {
    const options = (method: keyof PushController) =>
      getAuthenticatedOptions(reflector, PushController.prototype[method]);
    expect(options('getPushStatus')).toMatchObject({ permission: Permission.SessionRead });
    expect(options('listPushDevices')).toMatchObject({ permission: Permission.SessionRead });
    expect(options('registerPushDevice')).toMatchObject({ permission: Permission.SessionUpdate });
    expect(options('updatePushDevice')).toMatchObject({ permission: Permission.SessionUpdate });
    expect(options('setPushActivityToken')).toMatchObject({ permission: Permission.SessionUpdate });
    expect(options('removePushActivityToken')).toMatchObject({ permission: Permission.SessionUpdate });
    expect(options('unregisterPushDevice')).toMatchObject({ permission: Permission.SessionDelete });
    expect(options('removePushDevice')).toMatchObject({ permission: Permission.SessionDelete });
    expect(options('testPushDevice')).toMatchObject({ permission: Permission.SessionUpdate });
    for (const method of ['getPushStatus', 'registerPushDevice', 'removePushDevice', 'testPushDevice'] as const) {
      expect(options(method)).not.toMatchObject({ admin: true });
    }
  });

  describe('GET /push/status', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).get('/push/status');
      expect(ctx.authenticate).toHaveBeenCalled();
    });
  });

  describe('PUT /push/devices/current', () => {
    it('should require a known platform and a push token', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put('/push/devices/current')
        .send({ platform: 'windows', pushToken: '', publicKey: key });
      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['platform'], message: expect.any(String) },
          { path: ['pushToken'], message: expect.any(String) },
        ]),
      );
    });

    it('should register the current device', async () => {
      service.register.mockResolvedValue({});
      const dto = { platform: 'ios', pushToken: 'apns', publicKey: key, preferences: { memories: false } };
      const { status } = await request(ctx.getHttpServer()).put('/push/devices/current').send(dto);
      expect(status).toBe(200);
      expect(service.register).toHaveBeenCalledWith(undefined, dto);
    });
  });

  describe('PUT /push/devices/current/activities/:activityId', () => {
    it('should accept only a known Live Activity type', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put('/push/devices/current/activities/abc-123')
        .send({ kind: 'something-else', token: 'update' });
      expect(status).toBe(400);
    });

    it('should refuse an activity id with characters ActivityKit never uses', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put('/push/devices/current/activities/a%20b')
        .send({ kind: 'cloud-backup-activation', token: 'update' });
      expect(status).toBe(400);
    });
  });

  describe('DELETE /push/devices/:id', () => {
    it('should require a UUID', async () => {
      const { status } = await request(ctx.getHttpServer()).delete('/push/devices/123');
      expect(status).toBe(400);
    });
  });

  describe('POST /push/devices/:id/test (FL-926)', () => {
    it('should require a UUID', async () => {
      const { status } = await request(ctx.getHttpServer()).post('/push/devices/123/test');
      expect(status).toBe(400);
    });

    it('should send a test to the device and answer what happened', async () => {
      const id = '00000000-0000-4000-8000-000000000001';
      service.sendTest.mockResolvedValue({ transport: 'unifiedpush', status: 'sent', message: null });
      const { status, body } = await request(ctx.getHttpServer()).post(`/push/devices/${id}/test`);
      expect(status).toBe(200);
      expect(body).toEqual({ transport: 'unifiedpush', status: 'sent', message: null });
      expect(service.sendTest).toHaveBeenCalledWith(undefined, id);
    });
  });

  describe('PUT /push/devices/current (FL-926)', () => {
    it('should refuse a UnifiedPush endpoint that is not an http(s) URL', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put('/push/devices/current')
        .send({ platform: 'android', publicKey: key, unifiedPushEndpoint: 'ftp://ntfy.example.net/up' });
      expect(status).toBe(400);
      expect(service.register).not.toHaveBeenCalled();
    });
  });
});
