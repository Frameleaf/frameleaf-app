import { HttpException, HttpStatus } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { toString as qrToString } from 'qrcode';
import type { ConfigRepository } from 'src/repositories/config.repository.js';
import type { CryptoRepository } from 'src/repositories/crypto.repository.js';
import type { DatabaseRepository } from 'src/repositories/database.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import type { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import type { UserRepository } from 'src/repositories/user.repository.js';
import type { FrameleafSetupCodeState } from 'src/types.js';
import type { FrameleafVia } from 'src/utils/frameleaf-sign-in.js';
import { FrameleafSetupErrorCode } from 'src/dtos/frameleaf-server-setup.dto.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { serverIdentity } from 'src/utils/frameleaf-server-identity.js';
import {
  SETUP_CODE_MAX_FAILURES,
  SETUP_TICKET_TTL_MS,
  formatSetupCode,
  generateSetupCode,
  isLanRequest,
  normalizeSetupCode,
  setupCodeMatches,
  setupQrText,
} from 'src/utils/frameleaf-setup.js';

/**
 * FL-292 (NAPI-012): the setup code gate every way of claiming a new server goes through: the
 * app's code check (which hands out a setup ticket), the app's link and password claims (which take
 * the ticket), and the web first-run sign-up (which takes the code itself). Shared by the services
 * that own those routes; all of it runs under one database lock.
 *
 * - The code exists only while the server has no administrator. It is replaced at every start and
 *   after `SETUP_CODE_MAX_FAILURES` wrong tries (a pinned `FRAMELEAF_SETUP_CODE` locks until the
 *   next start instead), and shown only on the console and in the log, with a QR code.
 * - Only from the home network, compared in constant time, and every try is logged with its address.
 */

export type SetupGateDeps = {
  configRepository: ConfigRepository;
  cryptoRepository: CryptoRepository;
  databaseRepository: DatabaseRepository;
  logger: LoggingRepository;
  systemMetadataRepository: SystemMetadataRepository;
  userRepository: UserRepository;
};

/** Where a setup request came from. */
export type SetupClient = { ip: string; via: FrameleafVia | null };

const STATUS: Record<FrameleafSetupErrorCode, HttpStatus> = {
  [FrameleafSetupErrorCode.LanOnly]: HttpStatus.FORBIDDEN,
  [FrameleafSetupErrorCode.Complete]: HttpStatus.CONFLICT,
  [FrameleafSetupErrorCode.CodeRequired]: HttpStatus.BAD_REQUEST,
  [FrameleafSetupErrorCode.CodeInvalid]: HttpStatus.UNAUTHORIZED,
  [FrameleafSetupErrorCode.CodeReplaced]: HttpStatus.UNAUTHORIZED,
  [FrameleafSetupErrorCode.CodeLocked]: HttpStatus.UNAUTHORIZED,
  [FrameleafSetupErrorCode.TicketInvalid]: HttpStatus.UNAUTHORIZED,
  [FrameleafSetupErrorCode.CloudUnavailable]: HttpStatus.BAD_REQUEST,
  [FrameleafSetupErrorCode.AlreadyLinked]: HttpStatus.CONFLICT,
  [FrameleafSetupErrorCode.LinkTokenInvalid]: HttpStatus.BAD_REQUEST,
  [FrameleafSetupErrorCode.LinkTokenUsed]: HttpStatus.BAD_REQUEST,
  [FrameleafSetupErrorCode.LinkFailed]: HttpStatus.BAD_GATEWAY,
};

const MESSAGES: Record<FrameleafSetupErrorCode, string> = {
  [FrameleafSetupErrorCode.LanOnly]: 'A new server can only be set up from its home network',
  [FrameleafSetupErrorCode.Complete]: 'This server is already set up',
  [FrameleafSetupErrorCode.CodeRequired]: "Enter the setup code shown on the server's console or in its log",
  [FrameleafSetupErrorCode.CodeInvalid]:
    "That setup code is wrong. Check the code on the server's console or in its log",
  [FrameleafSetupErrorCode.CodeReplaced]:
    'Too many wrong setup codes: the server shows a new code on its console and in its log',
  [FrameleafSetupErrorCode.CodeLocked]:
    'Too many wrong setup codes for the code set with FRAMELEAF_SETUP_CODE. Restart the server to try again',
  [FrameleafSetupErrorCode.TicketInvalid]:
    'Setting up took too long or started on another device. Enter the setup code again',
  [FrameleafSetupErrorCode.CloudUnavailable]:
    'This server has no Frameleaf Cloud address. Set it up with an email and password instead',
  [FrameleafSetupErrorCode.AlreadyLinked]: 'This server is already linked to a Frameleaf account',
  [FrameleafSetupErrorCode.LinkTokenInvalid]: 'That is not a Frameleaf link token',
  [FrameleafSetupErrorCode.LinkTokenUsed]: 'That link was already used or has expired. Try again from the app',
  [FrameleafSetupErrorCode.LinkFailed]: 'Frameleaf Cloud did not link this server',
};

const ERROR_NAMES: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
};

/** A setup refusal with its code (and how many tries are left, for a wrong code). */
export const setupRefusal = (
  code: FrameleafSetupErrorCode,
  extra: { attemptsLeft?: number; message?: string } = {},
) => {
  const status = STATUS[code];
  return new HttpException(
    {
      message: extra.message ?? MESSAGES[code],
      error: ERROR_NAMES[status] ?? 'Error',
      statusCode: status,
      code,
      ...(extra.attemptsLeft !== undefined && { attemptsLeft: extra.attemptsLeft }),
    },
    status,
  );
};

const readState = (deps: SetupGateDeps) => deps.systemMetadataRepository.get(SystemMetadataKey.FrameleafSetupCode);
const writeState = (deps: SetupGateDeps, state: FrameleafSetupCodeState) =>
  deps.systemMetadataRepository.set(SystemMetadataKey.FrameleafSetupCode, state);

/** Show the code on the console and in the log, with a QR code the app can scan. */
const announce = async (deps: SetupGateDeps, code: string, reason: 'start' | 'replaced') => {
  const { id } = await serverIdentity(deps);
  let qr = '';
  try {
    qr = await qrToString(setupQrText(id, code), { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
  } catch (error) {
    deps.logger.warn(`Could not draw the setup QR code: ${error}`);
  }
  const lines = [
    '',
    reason === 'replaced'
      ? 'Too many wrong setup codes: this server has a new one.'
      : 'This server is not set up yet. To set it up from the Frameleaf app or this server’s web page,',
    reason === 'replaced' ? 'Use this code instead:' : 'use this setup code (or scan the QR code with the app):',
    '',
    `    ${formatSetupCode(code)}`,
    '',
    ...qr.split('\n'),
    'The code changes every time the server starts and stops working once the server is set up.',
    '',
  ];
  // straight to the console (the container's log) whatever the log level, so the code is never
  // filtered out; the log line below does not carry it
  process.stdout.write(`${lines.join('\n')}\n`);
  deps.logger.log(
    reason === 'replaced'
      ? 'The setup code was replaced after too many wrong tries; the new one is on the console'
      : 'This server is not set up yet; its setup code is on the console (frameleaf-admin setup-code prints it again)',
  );
};

/**
 * At start, and after too many wrong tries: a new code (or the pinned one) while the server has no
 * administrator, shown on the console; once an administrator exists, nothing is kept.
 */
export const prepareSetup = async (deps: SetupGateDeps, reason: 'start' | 'replaced' = 'start') => {
  if (!deps.configRepository.getEnv().setup.allow || (await deps.userRepository.getAdmin())) {
    await deps.systemMetadataRepository.delete(SystemMetadataKey.FrameleafSetupCode);
    return;
  }
  const pinned = deps.configRepository.getEnv().frameleafCloud.setupCode;
  const state: FrameleafSetupCodeState = {
    code: pinned ?? generateSetupCode(),
    pinned: !!pinned,
    failures: 0,
    locked: false,
    generatedAt: new Date().toISOString(),
  };
  await writeState(deps, state);
  await announce(deps, state.code, reason);
};

/** The current code, for the admin command line only (`frameleaf-admin setup-code`). */
export const currentSetupCode = async (deps: Pick<SetupGateDeps, 'systemMetadataRepository'>) => {
  const state = await deps.systemMetadataRepository.get(SystemMetadataKey.FrameleafSetupCode);
  return state ? formatSetupCode(state.code) : null;
};

/** Refuse a request that is not from the home network, or a server that is already set up. */
const requireClaimable = async (deps: SetupGateDeps, client: SetupClient) => {
  if (!isLanRequest(client.via, client.ip, deps.configRepository.getEnv().frameleafCloud.trustedLanCidrs)) {
    deps.logger.warn(`Refused a setup request from outside the home network (${client.ip})`);
    throw setupRefusal(FrameleafSetupErrorCode.LanOnly);
  }
  if (!deps.configRepository.getEnv().setup.allow || (await deps.userRepository.getAdmin())) {
    throw setupRefusal(FrameleafSetupErrorCode.Complete);
  }
};

/** Check a typed code; a wrong one counts, and the fifth replaces (or locks) the code. */
const checkCode = async (deps: SetupGateDeps, typed: string | undefined, client: SetupClient) => {
  let state = await readState(deps);
  if (!state) {
    await prepareSetup(deps);
    state = await readState(deps);
  }
  if (!state) {
    throw setupRefusal(FrameleafSetupErrorCode.Complete);
  }
  if (state.locked) {
    throw setupRefusal(FrameleafSetupErrorCode.CodeLocked);
  }
  if (!normalizeSetupCode(typed)) {
    throw setupRefusal(FrameleafSetupErrorCode.CodeRequired);
  }
  if (setupCodeMatches(typed ?? '', state.code)) {
    deps.logger.log(`The setup code was entered correctly from ${client.ip}`);
    return state;
  }
  const failures = state.failures + 1;
  deps.logger.warn(`A wrong setup code was entered from ${client.ip} (${failures} of ${SETUP_CODE_MAX_FAILURES})`);
  if (failures < SETUP_CODE_MAX_FAILURES) {
    await writeState(deps, { ...state, failures });
    throw setupRefusal(FrameleafSetupErrorCode.CodeInvalid, { attemptsLeft: SETUP_CODE_MAX_FAILURES - failures });
  }
  if (state.pinned) {
    await writeState(deps, { ...state, failures, locked: true, ticket: undefined });
    deps.logger.warn('The setup code set with FRAMELEAF_SETUP_CODE is locked until the server restarts');
    throw setupRefusal(FrameleafSetupErrorCode.CodeLocked);
  }
  await prepareSetup(deps, 'replaced');
  throw setupRefusal(FrameleafSetupErrorCode.CodeReplaced);
};

/**
 * `POST server/setup/code`: the code is right, so hand out the one setup ticket, bound to this
 * client's address, for `SETUP_TICKET_TTL_MS`. A new ticket replaces any earlier one.
 */
export const issueSetupTicket = (deps: SetupGateDeps, typed: string, client: SetupClient) =>
  deps.databaseRepository.withLock(DatabaseLock.FrameleafServerClaim, async () => {
    await requireClaimable(deps, client);
    const state = await checkCode(deps, typed, client);
    const ticket = deps.cryptoRepository.randomBytesAsText(32);
    const expiresAt = new Date(Date.now() + SETUP_TICKET_TTL_MS);
    await writeState(deps, {
      ...state,
      failures: 0,
      ticket: {
        hash: deps.cryptoRepository.hashSha256(ticket).toString('hex'),
        address: client.ip,
        expiresAt: expiresAt.toISOString(),
      },
    });
    return { ticket, expiresAt: expiresAt.toISOString() };
  });

/**
 * Run `claim` with the server proven claimable: from the home network, without an administrator,
 * and with the setup code (the web first-run sign-up) or the one valid setup ticket from this same
 * client (the app), which is used up. One claim at a time.
 */
export const withSetupProof = <T>(
  deps: SetupGateDeps,
  /** `ticketOnly`: the app's routes, which take the ticket and never the code itself. */
  proof: { code?: string; ticket?: string; ticketOnly?: boolean },
  client: SetupClient,
  claim: () => Promise<T>,
): Promise<T> =>
  deps.databaseRepository.withLock(DatabaseLock.FrameleafServerClaim, async () => {
    await requireClaimable(deps, client);
    if (proof.ticket || proof.ticketOnly) {
      const state = await readState(deps);
      const hash = deps.cryptoRepository.hashSha256(proof.ticket ?? '').toString('hex');
      const ticket = state?.ticket;
      const valid =
        !!proof.ticket &&
        !!ticket &&
        hash.length === ticket.hash.length &&
        timingSafeEqual(Buffer.from(hash), Buffer.from(ticket.hash)) &&
        ticket.address === client.ip &&
        Date.parse(ticket.expiresAt) > Date.now();
      if (!state || !valid) {
        deps.logger.warn(`Refused a setup ticket from ${client.ip}`);
        throw setupRefusal(FrameleafSetupErrorCode.TicketInvalid);
      }
      const result = await claim();
      // used up only once the claim worked: a refused link or a taken email can be tried again
      // once an administrator exists, setup is over and nothing is written back
      const after = (await deps.userRepository.getAdmin()) ? null : await readState(deps);
      if (after) {
        await writeState(deps, { ...after, ticket: undefined });
      }
      return result;
    }
    await checkCode(deps, proof.code, client);
    return claim();
  });

/** Once an administrator exists, the setup state goes. */
export const endSetup = (deps: Pick<SetupGateDeps, 'systemMetadataRepository'>) =>
  deps.systemMetadataRepository.delete(SystemMetadataKey.FrameleafSetupCode);
