import { LoginResponseDto, Permission } from '@frameleaf/sdk';
import { createHash } from 'node:crypto';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, baseUrl, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/** FL-803: connected apps through OAuth 2.1, end to end against a running server. */

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const verifier = 'e2e-verifier-'.padEnd(64, 'x');
const challenge = createHash('sha256').update(verifier).digest('base64url');

const register = async () => {
  const { status, body } = await request(app)
    .post('/oauth/apps/register')
    .send({ client_name: 'Claude', redirect_uris: [REDIRECT] });
  expect(status).toBe(201);
  return body.client_id as string;
};

describe('/oauth/apps', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;

  const connect = async (scope = 'library:read') => {
    const clientId = await register();
    const dto = {
      responseType: 'code',
      clientId,
      redirectUri: REDIRECT,
      scope,
      state: 'state-1',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    };
    const { body: allowed } = await request(app)
      .post('/oauth/apps/authorize')
      .set(asBearerAuth(user.accessToken))
      .send({ ...dto, allow: true });
    const code = new URL(allowed.redirectUrl).searchParams.get('code')!;
    const { status, body, headers } = await request(app).post('/oauth/apps/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    expect(status).toBe(200);
    expect(headers['cache-control']).toBe('no-store');
    return { clientId, code, tokens: body as { access_token: string; refresh_token: string } };
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    user = await utils.userSetup(admin.accessToken, createUserDto.user1);
  });

  it('publishes authorization server metadata at the root', async () => {
    const { status, body } = await request(baseUrl).get('/.well-known/oauth-authorization-server');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    expect(body.token_endpoint).toBe(`${body.issuer}/api/oauth/apps/token`);
  });

  it('publishes protected resource metadata, also for a path', async () => {
    const { status, body } = await request(baseUrl).get('/.well-known/oauth-protected-resource/api/mcp');
    expect(status).toBe(200);
    expect(body.resource.endsWith('/api/mcp')).toBe(true);
  });

  it('sends an unknown app to the Allow page, never to its return address', async () => {
    const { status, headers } = await request(app).get('/oauth/apps/authorize').query({
      response_type: 'code',
      client_id: '00000000-0000-4000-8000-000000000000',
      redirect_uri: 'https://evil.example/cb',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(status).toBe(302);
    expect(headers.location).toBe('/auth/allow-app?error=invalid_request');
  });

  it('connects an app whose token reads the library but never reaches admin routes', async () => {
    const { tokens } = await connect();
    const bearer = { Authorization: `Bearer ${tokens.access_token}` };

    const timeline = await request(app).get('/timeline/buckets').set(bearer);
    expect(timeline.status).toBe(200);

    const download = await request(app).post('/download/info').set(bearer).send({ assetIds: [] });
    expect(download.status).toBe(403);

    const users = await request(app).get('/admin/users').set(bearer);
    expect(users.status).toBe(403);

    const keys = await request(app).get('/api-keys/me').set(bearer);
    expect(keys.status).toBe(403);
  });

  it('rotates refresh tokens and ends the grant when a used one comes back', async () => {
    const { clientId, tokens } = await connect();
    const refresh = (token: string) =>
      request(app).post('/oauth/apps/token').type('form').send({
        grant_type: 'refresh_token',
        refresh_token: token,
        client_id: clientId,
      });
    const next = await refresh(tokens.refresh_token);
    expect(next.status).toBe(200);
    const reused = await refresh(tokens.refresh_token);
    expect(reused.status).toBe(400);
    expect(reused.body.error).toBe('invalid_grant');

    const after = await request(app)
      .get('/timeline/buckets')
      .set({ Authorization: `Bearer ${next.body.access_token}` });
    expect(after.status).toBe(401);
  });

  it('removing an app from Settings stops its token on the next request', async () => {
    const { tokens } = await connect();
    const { body: grants } = await request(app).get('/oauth/apps/grants').set(asBearerAuth(user.accessToken));
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      const { status } = await request(app)
        .delete(`/oauth/apps/grants/${grant.id}`)
        .set(asBearerAuth(user.accessToken));
      expect(status).toBe(204);
    }
    const { status } = await request(app)
      .get('/timeline/buckets')
      .set({ Authorization: `Bearer ${tokens.access_token}` });
    expect(status).toBe(401);
  });

  it('an API key needs session permissions to see or remove connected apps', async () => {
    const { tokens } = await connect();
    const { secret } = await utils.createApiKey(user.accessToken, [Permission.AssetRead]);
    const { body: grants } = await request(app).get('/oauth/apps/grants').set(asBearerAuth(user.accessToken));
    const listed = await request(app).get('/oauth/apps/grants').set('x-api-key', secret);
    expect(listed.status).toBe(403);
    const removed = await request(app).delete(`/oauth/apps/grants/${grants[0].id}`).set('x-api-key', secret);
    expect(removed.status).toBe(403);
    const still = await request(app)
      .get('/timeline/buckets')
      .set({ Authorization: `Bearer ${tokens.access_token}` });
    expect(still.status).toBe(200);
  });

  it('an API key with session permissions may list and remove connected apps', async () => {
    const { tokens } = await connect();
    const { secret } = await utils.createApiKey(user.accessToken, [Permission.SessionRead, Permission.SessionDelete]);
    const listed = await request(app).get('/oauth/apps/grants').set('x-api-key', secret);
    expect(listed.status).toBe(200);
    for (const grant of listed.body) {
      const removed = await request(app).delete(`/oauth/apps/grants/${grant.id}`).set('x-api-key', secret);
      expect(removed.status).toBe(204);
    }
    const after = await request(app)
      .get('/timeline/buckets')
      .set({ Authorization: `Bearer ${tokens.access_token}` });
    expect(after.status).toBe(401);
  });

  it('an administrator’s narrow API key can’t remove a registered app', async () => {
    const clientId = await register();
    const narrow = await utils.createApiKey(admin.accessToken, [Permission.AssetRead]);
    const refused = await request(app).delete(`/admin/oauth/apps/${clientId}`).set('x-api-key', narrow.secret);
    expect(refused.status).toBe(403);
    const allowed = await utils.createApiKey(admin.accessToken, [Permission.AdminSessionDelete]);
    const removed = await request(app).delete(`/admin/oauth/apps/${clientId}`).set('x-api-key', allowed.secret);
    expect(removed.status).toBe(204);
  });

  it('refuses password and implicit grants', async () => {
    for (const grant_type of ['password', 'implicit', 'client_credentials']) {
      const { status, body } = await request(app).post('/oauth/apps/token').type('form').send({ grant_type });
      expect(status).toBe(400);
      expect(body.error).toBe('unsupported_grant_type');
    }
  });
});
