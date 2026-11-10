import { LoginResponseDto, Permission } from '@frameleaf/sdk';
import { app, baseUrl, utils } from 'src/utils.js';
import { SoftPasskey } from 'src/webauthn.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const email = 'passkey@example.com';
const password = 'passkey-password';
const bearer = (token: string) => `Bearer ${token}`;
// a page on localhost: the one plain http address browsers (and the server) allow passkeys on
const origin = `http://localhost:${new URL(baseUrl).port}`;

const loginOptions = async () => {
  const { status, body } = await request(app).post('/auth/passkeys/login/options').set('Origin', origin);
  expect(status).toBe(200);
  return body.options;
};

// FL-836: passkeys for local accounts at the API boundary, with a software passkey
describe('/auth/passkeys', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;
  let passkey: SoftPasskey;
  let passkeyId: string;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    user = await utils.userSetup(admin.accessToken, { email, name: 'Passkey Person', password });
  });

  it('says why passkeys are unavailable on a plain http home address', async () => {
    const { status, body } = await request(app)
      .post('/auth/passkeys/login/options')
      .set('Origin', 'http://192.168.1.20:2283');
    expect(status).toBe(200);
    expect(body).toEqual({ passkeysAvailable: false, reason: 'insecure', options: null });
  });

  it('needs the password before adding a passkey, and refuses an API key', async () => {
    const { status, body } = await request(app)
      .post('/auth/passkeys/register/options')
      .set('Origin', origin)
      .set('Authorization', bearer(user.accessToken))
      .send({});
    expect(status).toBe(403);
    expect(body.code).toBe('passkey_password_required');

    const apiKey = await utils.createApiKey(user.accessToken, [Permission.All]);
    const withKey = await request(app)
      .post('/auth/passkeys/register/options')
      .set('Origin', origin)
      .set('x-api-key', apiKey.secret)
      .send({ password });
    expect(withKey.status).toBe(403);
  });

  it('adds a passkey and lists it', async () => {
    const start = await request(app)
      .post('/auth/passkeys/register/options')
      .set('Origin', origin)
      .set('Authorization', bearer(user.accessToken))
      .send({ password });
    expect(start.status).toBe(200);
    expect(start.body.options.rp.id).toBe('localhost');

    passkey = new SoftPasskey({ origin });
    const saved = await request(app)
      .post('/auth/passkeys/register')
      .set('Authorization', bearer(user.accessToken))
      .send({ credential: passkey.register(start.body.options), name: 'Test key' });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ name: 'Test key', rpId: 'localhost', lastUsedAt: null });
    passkeyId = saved.body.id;

    const list = await request(app).get('/auth/passkeys').set('Authorization', bearer(user.accessToken));
    expect(list.body).toEqual([expect.objectContaining({ id: passkeyId })]);

    const status = await request(app)
      .get('/auth/status')
      .set('Host', `localhost:${new URL(baseUrl).port}`)
      .set('Authorization', bearer(user.accessToken));
    expect(status.body).toMatchObject({ passkeysAvailable: true, hasPasskeys: true });
  });

  it('signs in with the passkey, and refuses the same answer twice', async () => {
    const credential = passkey.signIn(await loginOptions());
    const signedIn = await request(app).post('/auth/passkeys/login').send({ credential });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toMatchObject({ userId: user.userId, accessToken: expect.any(String) });

    const replay = await request(app).post('/auth/passkeys/login').send({ credential });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('passkey_expired');
  });

  it('refuses a counter that went backwards', async () => {
    const credential = passkey.signIn(await loginOptions(), { counter: 0 });
    const { status, body } = await request(app).post('/auth/passkeys/login').send({ credential });
    expect(status).toBe(401);
    expect(body.code).toBe('passkey_failed');
  });

  it('refuses a removed passkey, and its sessions are signed out', async () => {
    const credential = passkey.signIn(await loginOptions(), { counter: 10 });
    const signedIn = await request(app).post('/auth/passkeys/login').send({ credential });
    expect(signedIn.status).toBe(200);

    const removed = await request(app)
      .delete(`/auth/passkeys/${passkeyId}`)
      .set('Authorization', bearer(user.accessToken));
    expect(removed.status).toBe(204);

    const after = await request(app).get('/auth/passkeys').set('Authorization', bearer(signedIn.body.accessToken));
    expect(after.status).toBe(401);

    const again = await request(app)
      .post('/auth/passkeys/login')
      .send({ credential: passkey.signIn(await loginOptions()) });
    expect(again.status).toBe(401);
    expect(again.body.code).toBe('passkey_not_recognised');
  });

  it('lets an administrator remove every passkey of an account', async () => {
    const start = await request(app)
      .post('/auth/passkeys/register/options')
      .set('Origin', origin)
      .set('Authorization', bearer(user.accessToken))
      .send({});
    expect(start.status).toBe(200);
    const another = new SoftPasskey({ origin });
    await request(app)
      .post('/auth/passkeys/register')
      .set('Authorization', bearer(user.accessToken))
      .send({ credential: another.register(start.body.options) });

    const state = await request(app)
      .get(`/admin/users/${user.userId}/pin-code`)
      .set('Authorization', bearer(admin.accessToken));
    expect(state.body).toMatchObject({ passkeys: 1 });

    const removed = await request(app)
      .delete(`/admin/users/${user.userId}/passkeys`)
      .set('Authorization', bearer(admin.accessToken));
    expect(removed.status).toBe(204);
    const list = await request(app).get('/auth/passkeys').set('Authorization', bearer(user.accessToken));
    expect(list.body).toEqual([]);
  });
});
