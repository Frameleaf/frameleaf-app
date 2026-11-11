import { UnauthorizedException } from '@nestjs/common';
import type { UserAdmin } from 'src/database.js';
import type { CryptoRepository } from 'src/repositories/crypto.repository.js';
import type { SessionRepository } from 'src/repositories/session.repository.js';
import type { LoginDetails } from 'src/services/auth.service.js';
import { mapLoginResponse } from 'src/dtos/auth.dto.js';
import { type SignInLevel, type SignInSource, levelFromMethods } from 'src/utils/sign-in-level.js';

export const VERIFICATION_CAPABILITY = 'verification';

/** How a session was made (unified sign-in): the methods used, where, and when it last reached its level. */
export type SessionSignIn = {
  methods: string[];
  source: SignInSource;
  /** The level Frameleaf Cloud vouched for; local sign-ins derive it from `methods`. */
  level?: SignInLevel;
  authTime?: Date;
};

/** The client's declared capabilities: the request header and any `capabilities` in the request body. */
export const withCapabilities = (details: LoginDetails, bodyCapabilities?: string[]): LoginDetails =>
  bodyCapabilities?.length
    ? { ...details, capabilities: [...new Set([...(details.capabilities ?? []), ...bodyCapabilities])] }
    : details;

/**
 * A new signed-in session for `user` (FL-158: extracted from `AuthService` so Sign in with Frameleaf
 * creates sessions exactly as password and OAuth sign-in do). Only the token's hash is stored; the
 * token itself is returned once, in the login response.
 */
export const createSession = async (
  deps: { sessionRepository: SessionRepository; cryptoRepository: CryptoRepository },
  user: UserAdmin,
  loginDetails: LoginDetails,
  signIn: SessionSignIn,
  oauth: { sid?: string; bearerToken?: string } = {},
  expectedPassword?: string,
) => {
  if (user.importClaimPending) throw new UnauthorizedException('This account must be claimed before signing in');
  const token = deps.cryptoRepository.randomBytesAsText(32);
  const hashed = deps.cryptoRepository.hashSha256(token);

  const dto = {
    token: hashed,
    deviceOS: loginDetails.deviceOS,
    deviceType: loginDetails.deviceType,
    appVersion: loginDetails.appVersion,
    userId: user.id,
    oauthSid: oauth.sid ?? null,
    oauthBearerToken: oauth.bearerToken ?? null,
  };
  // sessions from clients that do not declare the `verification` capability keep today's rights (legacy)
  const record = {
    methods: signIn.methods,
    level: signIn.level ?? levelFromMethods(signIn.methods),
    source: signIn.source,
    authTime: signIn.authTime ?? new Date(),
    legacy: !loginDetails.capabilities?.includes(VERIFICATION_CAPABILITY),
  };
  const session =
    expectedPassword === undefined
      ? await deps.sessionRepository.create(dto, undefined, record)
      : await deps.sessionRepository.create(dto, expectedPassword, record);

  return { session, response: mapLoginResponse(user, token) };
};
