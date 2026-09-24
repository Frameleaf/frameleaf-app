import request from 'supertest';
import { OAuthController } from 'src/controllers/oauth.controller.js';
import { AuthService } from 'src/services/auth.service.js';
import { mediumFactory } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(OAuthController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(AuthService);

  beforeAll(async () => {
    ctx = await controllerSetup(OAuthController, [{ provide: AuthService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /oauth/frameleaf-mobile-redirect (FL-131)', () => {
    it('forwards the callback to the Frameleaf app without authentication', async () => {
      service.getFrameleafMobileRedirect.mockReturnValue('frameleaf-auth:///oauth-callback?code=abc&state=xyz');

      const { status, headers } = await request(ctx.getHttpServer()).get(
        '/oauth/frameleaf-mobile-redirect?code=abc&state=xyz',
      );

      expect(status).toBe(307);
      expect(headers.location).toBe('frameleaf-auth:///oauth-callback?code=abc&state=xyz');
      expect(service.getFrameleafMobileRedirect).toHaveBeenCalledWith(
        expect.stringContaining('/oauth/frameleaf-mobile-redirect?code=abc&state=xyz'),
      );
    });
  });

  describe('POST /oauth/authorize', () => {
    it('should require a redirect uri', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/oauth/authorize').send({});

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['redirectUri'], message: 'Invalid input: expected string, received undefined' },
        ]),
      );
      expect(service.authorize).not.toHaveBeenCalled();
    });
  });

  describe('POST /oauth/callback', () => {
    it('rejects a non-boolean cookie preference before authentication', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/oauth/callback')
        .send({ url: 'https://example.test/auth/login?code=test', rememberMe: 'false' });
      expect(status).toBe(400);
      expect(service.callback).not.toHaveBeenCalled();
    });

    it.each([undefined, true, false])('sets callback cookie persistence for rememberMe=%s', async (rememberMe) => {
      service.callback.mockResolvedValue(mediumFactory.loginResponse());
      const { status, headers } = await request(ctx.getHttpServer())
        .post('/oauth/callback')
        .send({ url: 'https://example.test/auth/login?code=test', rememberMe });

      expect(status).toBe(201);
      const cookies = headers['set-cookie'];
      expect(cookies).toHaveLength(5);
      expect(cookies[0]).toContain('immich_oauth_state=;');
      expect(cookies[1]).toContain('immich_oauth_code_verifier=;');
      for (const cookie of cookies.slice(2)) {
        expect(cookie.includes('Max-Age=34560000')).toBe(rememberMe !== false);
        expect(cookie.includes('Expires=')).toBe(rememberMe !== false);
        expect(cookie.includes('HttpOnly')).toBe(!cookie.startsWith('immich_is_authenticated='));
        expect(cookie).toContain('SameSite=Lax');
        expect(cookie).toContain('Path=/');
      }
    });

    it('should require a url', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/oauth/callback').send({});

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['url'], message: 'Invalid input: expected string, received undefined' },
        ]),
      );
    });

    it('should not allow an empty url', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/oauth/callback').send({ url: '' });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['url'], message: 'Too small: expected string to have >=1 characters' },
        ]),
      );
    });
  });

  describe('POST /oauth/backchannel-logout', () => {
    it('should require a logout token', async () => {
      const { status, body } = await request(ctx.getHttpServer()).post('/oauth/backchannel-logout').send({});

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['logout_token'], message: 'Invalid input: expected string, received undefined' },
        ]),
      );
    });
  });
});
