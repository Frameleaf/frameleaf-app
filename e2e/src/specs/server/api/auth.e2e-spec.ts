import { login, logout } from '@frameleaf/sdk';
import { loginDto, signupDto } from 'src/fixtures.js';
import { errorDto } from 'src/responses.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const accessTokenCookie = (headers: Record<string, unknown>) => {
  const cookies = (headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  const cookie = cookies.find((value) => value.startsWith('immich_access_token='));
  expect(cookie).toBeDefined();
  return cookie as string;
};

// FL-80: the auth lifecycle at the API boundary behind the Frameleaf sign-in screens.
describe('/auth', () => {
  beforeAll(async () => {
    await utils.resetDatabase();
    await utils.adminSetup();
  });

  describe('POST /auth/login', () => {
    // Run this case alone against a disposable server with FRAMELEAF_ENV=production.
    it.runIf(process.env.FRAMELEAF_E2E_SIGN_IN_BACKOFF === '1')(
      'waits after five actual password failures, including a burst of concurrent attempts',
      async () => {
        const fail = () =>
          request(app)
            .post('/auth/login')
            .send({ ...loginDto.admin, password: 'incorrect-password' });
        for (let attempt = 0; attempt < 4; attempt++) {
          await fail().expect(401);
        }
        const results = await Promise.all(Array.from({ length: 5 }, fail));
        expect(results.map(({ status }) => status).toSorted((left, right) => left - right)).toEqual([
          401, 429, 429, 429, 429,
        ]);
        const { body, headers } = await request(app).post('/auth/login').send(loginDto.admin).expect(429);
        expect(body).toMatchObject({ code: 'rate_limited', retryAfter: expect.any(Number) });
        expect(body.retryAfter).toBeGreaterThan(0);
        expect(body.retryAfter).toBeLessThanOrEqual(30);
        expect(headers['retry-after']).toBe(String(body.retryAfter));
      },
    );

    it('should set a session-only access token cookie when rememberMe is false', async () => {
      // FL-80: "Keep me signed in" off → the cookie ends with the browser session.
      const { status, headers } = await request(app)
        .post('/auth/login')
        .send({ ...loginDto.admin, rememberMe: false });
      expect(status).toBe(201);

      const cookie = accessTokenCookie(headers);
      expect(cookie).not.toMatch(/max-age=/i);
      expect(cookie).not.toMatch(/expires=/i);
      expect(cookie).toMatch(/httponly/i);
    });

    it('should set a persistent access token cookie when rememberMe is omitted', async () => {
      // FL-80: the default keeps the session across browser restarts.
      const { status, headers } = await request(app).post('/auth/login').send(loginDto.admin);
      expect(status).toBe(201);

      const cookie = accessTokenCookie(headers);
      expect(cookie).toMatch(/max-age=\d+/i);
      expect(cookie).toMatch(/expires=/i);
    });
  });

  describe('POST /auth/admin-sign-up', () => {
    it('should refuse a second admin sign-up once an admin exists', async () => {
      // FL-80: registration is only offered while the server has no administrator.
      const { status, body } = await request(app)
        .post('/auth/admin-sign-up')
        .send({ ...signupDto.admin, email: 'second-admin@example.com' });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Admin setup is not available'));
    });
  });

  describe('revoked sessions', () => {
    it('should reject a signed-out session token', async () => {
      // FL-80: once a session is revoked its token no longer authenticates.
      const session = await login({ loginCredentialDto: loginDto.admin });
      const before = await request(app).get('/users/me').set('Authorization', `Bearer ${session.accessToken}`);
      expect(before.status).toBe(200);

      await logout({ headers: asBearerAuth(session.accessToken) });

      const { status } = await request(app).get('/users/me').set('Authorization', `Bearer ${session.accessToken}`);
      expect(status).toBe(401);
    });
  });
});
