import { HttpException, HttpStatus } from '@nestjs/common';
import type { ConfigRepository } from 'src/repositories/config.repository.js';
import type { DatabaseRepository } from 'src/repositories/database.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { UserRepository } from 'src/repositories/user.repository.js';
import type { FrameleafVia } from 'src/utils/frameleaf-sign-in.js';
import { FrameleafSetupErrorCode } from 'src/dtos/frameleaf-server-setup.dto.js';
import { DatabaseLock } from 'src/enum.js';
import { isLanRequest } from 'src/utils/frameleaf-setup.js';

/**
 * FL-292 (NAPI-012): the gate every way of claiming a new server goes through: the web first-run
 * sign-up, the app's link and password claims, and the restore onto a new server. Only from the home
 * network and only while the server has no administrator; no setup code (owner, 2026-10-14). Linking
 * to Frameleaf Cloud stays optional, with a single-use link token. One claim at a time.
 */

export type SetupGateDeps = {
  configRepository: ConfigRepository;
  databaseRepository: DatabaseRepository;
  logger: LoggingRepository;
  userRepository: UserRepository;
};

/** Where a setup request came from. */
export type SetupClient = { ip: string; via: FrameleafVia | null };

const STATUS: Record<FrameleafSetupErrorCode, HttpStatus> = {
  [FrameleafSetupErrorCode.LanOnly]: HttpStatus.FORBIDDEN,
  [FrameleafSetupErrorCode.Complete]: HttpStatus.CONFLICT,
  [FrameleafSetupErrorCode.CloudUnavailable]: HttpStatus.BAD_REQUEST,
  [FrameleafSetupErrorCode.AlreadyLinked]: HttpStatus.CONFLICT,
  [FrameleafSetupErrorCode.LinkTokenInvalid]: HttpStatus.BAD_REQUEST,
  [FrameleafSetupErrorCode.LinkTokenUsed]: HttpStatus.BAD_REQUEST,
  [FrameleafSetupErrorCode.LinkFailed]: HttpStatus.BAD_GATEWAY,
};

const MESSAGES: Record<FrameleafSetupErrorCode, string> = {
  [FrameleafSetupErrorCode.LanOnly]: 'A new server can only be set up from its home network',
  [FrameleafSetupErrorCode.Complete]: 'This server is already set up',
  [FrameleafSetupErrorCode.CloudUnavailable]:
    'This server has no Frameleaf Cloud address. Set it up with an email and password instead',
  [FrameleafSetupErrorCode.AlreadyLinked]: 'This server is already linked to a Frameleaf account',
  [FrameleafSetupErrorCode.LinkTokenInvalid]: 'That is not a Frameleaf link token',
  [FrameleafSetupErrorCode.LinkTokenUsed]: 'That link was already used or has expired. Try again from the app',
  [FrameleafSetupErrorCode.LinkFailed]: 'Frameleaf Cloud did not link this server',
};

const ERROR_NAMES: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
};

/** A setup refusal with its code. */
export const setupRefusal = (code: FrameleafSetupErrorCode, extra: { message?: string } = {}) => {
  const status = STATUS[code];
  return new HttpException(
    { message: extra.message ?? MESSAGES[code], error: ERROR_NAMES[status] ?? 'Error', statusCode: status, code },
    status,
  );
};

/** Run `claim` while the server is claimable: from the home network, without an administrator. */
export const whileClaimable = <T>(deps: SetupGateDeps, client: SetupClient, claim: () => Promise<T>): Promise<T> =>
  deps.databaseRepository.withLock(DatabaseLock.FrameleafServerClaim, async () => {
    if (!isLanRequest(client.via, client.ip, deps.configRepository.getEnv().frameleafCloud.trustedLanCidrs)) {
      deps.logger.warn(`Refused a setup request from outside the home network (${client.ip})`);
      throw setupRefusal(FrameleafSetupErrorCode.LanOnly);
    }
    if (!deps.configRepository.getEnv().setup.allow || (await deps.userRepository.getAdmin())) {
      throw setupRefusal(FrameleafSetupErrorCode.Complete);
    }
    return claim();
  });
