import { LoginResponseDto, login } from '@immich/sdk';
import { errorDto } from 'src/responses.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const password = 'pin-reset-password';
const oldPin = '123456';
const newPin = '654321';

const authStatus = (accessToken: string) =>
  request(app).get('/auth/status').set('Authorization', `Bearer ${accessToken}`);

const unlock = (accessToken: string, pinCode: string) =>
  request(app).post('/auth/session/unlock').set('Authorization', `Bearer ${accessToken}`).send({ pinCode });

describe('/auth/pin-code', () => {
  let admin: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  describe('DELETE /auth/pin-code', () => {
    // FL-67: resetting the PIN with the account password locks every session it had unlocked, and the
    // old PIN no longer unlocks anything
    it('should lock previously unlocked sessions and retire the old PIN', async () => {
      const user = await utils.userSetup(admin.accessToken, {
        email: 'pin-reset@example.com',
        name: 'PIN Reset',
        password,
      });
      const otherDevice = await login({ loginCredentialDto: { email: 'pin-reset@example.com', password } });

      const setup = await request(app)
        .post('/auth/pin-code')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ pinCode: oldPin });
      expect(setup.status).toBe(204);

      for (const session of [user, otherDevice]) {
        const unlocked = await unlock(session.accessToken, oldPin);
        expect(unlocked.status).toBe(204);
        const status = await authStatus(session.accessToken);
        expect(status.body).toMatchObject({ pinCode: true, isElevated: true, pinExpiresAt: expect.any(String) });
      }

      const reset = await request(app)
        .delete('/auth/pin-code')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ password });
      expect(reset.status).toBe(204);

      for (const session of [user, otherDevice]) {
        const { status, body } = await authStatus(session.accessToken);
        expect(status).toBe(200);
        expect(body).toMatchObject({ pinCode: false, password: true, isElevated: false });
      }

      // the old PIN is gone: there is no PIN to unlock with until a new one is set
      const withoutPin = await unlock(user.accessToken, oldPin);
      expect(withoutPin.status).toBe(400);
      expect(withoutPin.body).toEqual(errorDto.badRequest('User does not have a PIN code'));

      const newSetup = await request(app)
        .post('/auth/pin-code')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ pinCode: newPin });
      expect(newSetup.status).toBe(204);

      const withOldPin = await unlock(user.accessToken, oldPin);
      expect(withOldPin.status).toBe(400);
      expect(withOldPin.body).toEqual(errorDto.badRequest('Wrong PIN code'));
      const stillLocked = await authStatus(user.accessToken);
      expect(stillLocked.body).toMatchObject({ isElevated: false });

      const withNewPin = await unlock(user.accessToken, newPin);
      expect(withNewPin.status).toBe(204);
    });

    // FL-67: the reset is refused with a wrong account password and nothing is locked
    it('should refuse a reset with the wrong password', async () => {
      const user = await utils.userSetup(admin.accessToken, {
        email: 'pin-reset-wrong@example.com',
        name: 'PIN Reset Wrong',
        password,
      });
      await request(app)
        .post('/auth/pin-code')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ pinCode: oldPin });
      const unlocked = await unlock(user.accessToken, oldPin);
      expect(unlocked.status).toBe(204);

      const { status, body } = await request(app)
        .delete('/auth/pin-code')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ password: 'not-the-password' });
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('Wrong password'));

      const stillUnlocked = await authStatus(user.accessToken);
      expect(stillUnlocked.body).toMatchObject({ pinCode: true, isElevated: true });
    });
  });
});
