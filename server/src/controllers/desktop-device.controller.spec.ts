import request from 'supertest';
import { DesktopDeviceController } from 'src/controllers/desktop-device.controller.js';
import { DesktopDeviceService } from 'src/services/desktop-device.service.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { type ControllerContext, controllerSetup } from 'test/utils.js';

it('issues a separate worker session through the validated photo-authenticated desktop route', async () => {
  const issue = vi.fn().mockResolvedValue({
    sessionId: '1117c1ca-0495-46e9-b579-f321520c2b1a',
    workerToken: 'a'.repeat(64),
    authorizationEpoch: 1,
    expiresAt: '2026-10-15T20:00:00Z',
    scopes: ['library-inference'],
    modelKeys: [],
  });
  const ctx: ControllerContext = await controllerSetup(DesktopDeviceController, [
    { provide: DesktopDeviceService, useValue: {} },
    { provide: DesktopWorkerAuthService, useValue: { issue } },
  ]);
  ctx.authenticate.mockResolvedValue({ user: { id: 'account', isAdmin: true }, session: { id: 'photo-session' } });
  try {
    const dto = {
      deviceId: '445bc2b6-f4cd-439e-b8bb-7e84d7ee0550',
      requestId: 'd621bd72-ad35-4199-95ab-76300756a38e',
      timestamp: Date.now(),
      signature: Buffer.alloc(64).toString('base64'),
    };
    const response = await request(ctx.getHttpServer()).post('/desktop/devices/session').send(dto);
    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ workerToken: 'a'.repeat(64), modelKeys: [] });
    expect(issue).toHaveBeenCalledWith(expect.objectContaining({ user: expect.anything() }), dto);
    expect(
      (
        await request(ctx.getHttpServer())
          .post('/desktop/devices/session')
          .send({ ...dto, token: 'photo-secret' })
      ).status,
    ).toBe(400);
    expect(issue).toHaveBeenCalledTimes(1);
  } finally {
    await ctx.close();
  }
});
