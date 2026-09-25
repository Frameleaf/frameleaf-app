import request from 'supertest';
import { FrameleafAuthController } from 'src/controllers/frameleaf-auth.controller.js';
import { FrameleafAuthService } from 'src/services/frameleaf-auth.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(FrameleafAuthController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(FrameleafAuthService);

  beforeAll(async () => {
    ctx = await controllerSetup(FrameleafAuthController, [{ provide: FrameleafAuthService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  it('requires authentication for the link and handoff routes', async () => {
    for (const [method, path] of [
      ['post', '/oauth/frameleaf/handoff'],
      ['get', '/oauth/frameleaf/link'],
      ['post', '/oauth/frameleaf/link'],
      ['delete', '/oauth/frameleaf/link'],
    ] as const) {
      await request(ctx.getHttpServer())[method](path);
      expect(ctx.authenticate).toHaveBeenCalled();
      ctx.authenticate.mockClear();
    }
  });

  it('starts a sign-in and keeps the state and verifier in cookies', async () => {
    service.authorize.mockResolvedValue({ url: 'https://id.test/auth', state: 'state-1', codeVerifier: 'verifier' });
    const { status, body, headers } = await request(ctx.getHttpServer())
      .post('/oauth/frameleaf/authorize')
      .send({ redirectUri: 'https://photos.example.test/auth/login' });
    expect(status).toBe(201);
    expect(body).toEqual({ url: 'https://id.test/auth' });
    expect(headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('immich_oauth_state=state-1')]),
    );
  });

  it('signs in with a password-type auth cookie, so signing out never reaches the other provider', async () => {
    service.callback.mockResolvedValue({
      accessToken: 'token',
      userId: 'user-1',
      userEmail: 'a@example.test',
      name: 'A',
      isAdmin: false,
      profileImagePath: '',
      shouldChangePassword: false,
      isOnboarded: true,
    });
    const { status, headers } = await request(ctx.getHttpServer())
      .post('/oauth/frameleaf/callback')
      .send({ url: 'https://photos.example.test/auth/login?code=1&state=s' });
    expect(status).toBe(201);
    expect(headers['set-cookie']).toEqual(
      expect.arrayContaining([expect.stringContaining('immich_auth_type=password')]),
    );
  });

  it('requires a handoff code', async () => {
    const { status } = await request(ctx.getHttpServer()).post('/oauth/frameleaf/handoff/redeem').send({});
    expect(status).toBe(400);
    expect(service.redeemHandoff).not.toHaveBeenCalled();
  });
});
