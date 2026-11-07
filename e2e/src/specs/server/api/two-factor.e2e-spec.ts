import { LoginResponseDto } from '@frameleaf/sdk';
import { createHmac } from 'node:crypto';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 6238 code for a base32 secret, the way an authenticator app makes it. */
const totp = (secret: string, offsetSteps = 0) => {
  let bits = '';
  for (const char of secret) {
    bits += BASE32.indexOf(char).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offsetSteps));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest.at(-1)! & 15;
  return String((digest.readUInt32BE(offset) & 0x7f_ff_ff_ff) % 1_000_000).padStart(6, '0');
};

const email = 'two-step@example.com';
const password = 'two-step-password';
const bearer = (token: string) => `Bearer ${token}`;
const signIn = () => request(app).post('/auth/login').send({ email, password, twoFactor: true });

// FL-793: two-step sign-in at the API boundary
describe('/auth/two-factor', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;
  let secret: string;
  let recoveryCodes: string[];

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    user = await utils.userSetup(admin.accessToken, { email, name: 'Two Step', password });
  });

  it('turns on with the password and a first code, and returns ten recovery codes once', async () => {
    const wrongPassword = await request(app)
      .post('/auth/two-factor/setup')
      .set('Authorization', bearer(user.accessToken))
      .send({ password: 'nope' });
    expect(wrongPassword.status).toBe(400);

    const setup = await request(app)
      .post('/auth/two-factor/setup')
      .set('Authorization', bearer(user.accessToken))
      .send({ password });
    expect(setup.status).toBe(201);
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/Frameleaf/);
    secret = setup.body.secret;

    const enable = await request(app)
      .post('/auth/two-factor/enable')
      .set('Authorization', bearer(user.accessToken))
      .send({ code: totp(secret) });
    expect(enable.status).toBe(201);
    recoveryCodes = enable.body.recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);

    const status = await request(app).get('/auth/status').set('Authorization', bearer(user.accessToken));
    expect(status.body).toMatchObject({ twoFactorEnabled: true, recoveryCodesRemaining: 10 });
  });

  it('refuses a client that cannot show the code step with a clear 403', async () => {
    const { status, body } = await request(app).post('/auth/login').send({ email, password });
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: 'two_factor_required' });
  });

  it('gives no session for the password alone', async () => {
    const { status, body, headers } = await signIn();
    expect(status).toBe(201);
    expect(body).toMatchObject({ twoFactorRequired: true, accessToken: '' });
    expect(body.twoFactorToken).toEqual(expect.any(String));
    expect(headers['set-cookie']).toBeUndefined();

    const withEmptyToken = await request(app).get('/users/me').set('Authorization', bearer(body.accessToken));
    expect(withEmptyToken.status).toBe(401);
  });

  it('refuses a wrong code and signs in with the next code once', async () => {
    const { body } = await signIn();
    const wrong = await request(app)
      .post('/auth/login/two-factor')
      .send({ twoFactorToken: body.twoFactorToken, code: totp(secret) === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(401);

    // the setup used the current step; the next one is still within the accepted drift
    const code = totp(secret, 1);
    const ok = await request(app).post('/auth/login/two-factor').send({ twoFactorToken: body.twoFactorToken, code });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).not.toBe('');
    const me = await request(app).get('/users/me').set('Authorization', bearer(ok.body.accessToken));
    expect(me.status).toBe(200);

    const replay = await request(app)
      .post('/auth/login/two-factor')
      .send({ twoFactorToken: body.twoFactorToken, code });
    expect(replay.status).toBe(401);
  });

  it('accepts a recovery code once', async () => {
    const { body } = await signIn();
    const recoveryCode = recoveryCodes[0];
    const first = await request(app)
      .post('/auth/login/two-factor')
      .send({ twoFactorToken: body.twoFactorToken, recoveryCode });
    expect(first.status).toBe(200);

    const again = await request(app)
      .post('/auth/login/two-factor')
      .send({ twoFactorToken: body.twoFactorToken, recoveryCode });
    expect(again.status).toBe(401);
  });

  it('moves to a new phone (old phone gone: a recovery code), keeping the other recovery codes', async () => {
    const start = await request(app)
      .post('/auth/two-factor/move')
      .set('Authorization', bearer(user.accessToken))
      .send({ password, recoveryCode: recoveryCodes[1] });
    expect(start.status).toBe(201);
    const newSecret: string = start.body.secret;
    expect(newSecret).not.toBe(secret);

    const confirm = await request(app)
      .post('/auth/two-factor/move/confirm')
      .set('Authorization', bearer(user.accessToken))
      .send({ code: totp(newSecret) });
    expect(confirm.status).toBe(204);
    secret = newSecret;

    const status = await request(app).get('/auth/status').set('Authorization', bearer(user.accessToken));
    expect(status.body).toMatchObject({ twoFactorEnabled: true, recoveryCodesRemaining: 8 });
  });

  it('lets an administrator turn it off for a lost phone, and records it', async () => {
    const pinState = await request(app)
      .get(`/admin/users/${user.userId}/pin-code`)
      .set('Authorization', bearer(admin.accessToken));
    expect(pinState.body).toMatchObject({ twoFactorEnabled: true });

    const reset = await request(app)
      .delete(`/admin/users/${user.userId}/two-factor`)
      .set('Authorization', bearer(admin.accessToken));
    expect(reset.status).toBe(204);

    const history = await request(app)
      .get(`/admin/users/${user.userId}/history`)
      .set('Authorization', bearer(admin.accessToken));
    expect(history.body.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'account-updated', detail: 'two-factor-reset' })]),
    );

    const { body } = await signIn();
    expect(body.twoFactorRequired).toBeUndefined();
    expect(body.accessToken).not.toBe('');
  });
});
