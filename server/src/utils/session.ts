import type { UserAdmin } from 'src/database.js';
import type { CryptoRepository } from 'src/repositories/crypto.repository.js';
import type { SessionRepository } from 'src/repositories/session.repository.js';
import type { LoginDetails } from 'src/services/auth.service.js';
import { mapLoginResponse } from 'src/dtos/auth.dto.js';

/**
 * A new signed-in session for `user` (FL-158: extracted from `AuthService` so Sign in with Frameleaf
 * creates sessions exactly as password and OAuth sign-in do). Only the token's hash is stored; the
 * token itself is returned once, in the login response.
 */
export const createSession = async (
  deps: { sessionRepository: SessionRepository; cryptoRepository: CryptoRepository },
  user: UserAdmin,
  loginDetails: LoginDetails,
  oauth: { sid?: string; bearerToken?: string } = {},
) => {
  const token = deps.cryptoRepository.randomBytesAsText(32);
  const hashed = deps.cryptoRepository.hashSha256(token);

  const session = await deps.sessionRepository.create({
    token: hashed,
    deviceOS: loginDetails.deviceOS,
    deviceType: loginDetails.deviceType,
    appVersion: loginDetails.appVersion,
    userId: user.id,
    oauthSid: oauth.sid ?? null,
    oauthBearerToken: oauth.bearerToken ?? null,
  });

  return { session, response: mapLoginResponse(user, token) };
};
