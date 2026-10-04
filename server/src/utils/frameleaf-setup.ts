import { randomInt, timingSafeEqual } from 'node:crypto';
import type { FrameleafVia } from 'src/utils/frameleaf-sign-in.js';
import { isHomeAddress, isRemoteVia } from 'src/utils/frameleaf-sign-in.js';

/**
 * FL-292 (NAPI-012): setting up a new server from the Frameleaf app, the way a phone sets up new
 * earbuds. While the server has no administrator it holds a setup code, shown only on its console
 * and in its log (with a QR code of the same value); whoever claims the server must prove they can
 * read it. The code is never in a DNS-SD record, `/server/ping`, any API response or web page.
 */

/** Unambiguous: no 0/O, 1/I/L, so a code read off a screen or a log is typed correctly. */
export const SETUP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const SETUP_CODE_LENGTH = 8;
/** Wrong tries before the code is replaced (a pinned code is locked until the next start instead). */
export const SETUP_CODE_MAX_FAILURES = 5;
/** Attempts one source address may make in `SETUP_RATE_WINDOW_MS`, right or wrong. */
export const SETUP_RATE_LIMIT = 10;
export const SETUP_RATE_WINDOW_MS = 10 * 60 * 1000;
/** How long a setup ticket (proof the code was entered) can be used, once. */
export const SETUP_TICKET_TTL_MS = 10 * 60 * 1000;

const SETUP_CODE_PATTERN = new RegExp(`^[${SETUP_CODE_ALPHABET}]{${SETUP_CODE_LENGTH}}$`);

/** A new random setup code. */
export const generateSetupCode = (random: (max: number) => number = randomInt): string =>
  Array.from({ length: SETUP_CODE_LENGTH }, () => SETUP_CODE_ALPHABET[random(SETUP_CODE_ALPHABET.length)]).join('');

/** What a person typed, as a code: upper case, without the dash, spaces or other separators. */
export const normalizeSetupCode = (value: string | undefined | null): string =>
  (value ?? '').toUpperCase().replaceAll(/[^0-9A-Z]/g, '');

export const isSetupCode = (value: string): boolean => SETUP_CODE_PATTERN.test(value);

/** `XXXX-XXXX`, as it is shown. */
export const formatSetupCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Constant-time comparison of a typed code with the server's; a code of another length is a miss. */
export const setupCodeMatches = (typed: string, expected: string): boolean => {
  const given = Buffer.from(normalizeSetupCode(typed));
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length) {
    // spend the same comparison, so the length is not timed either
    timingSafeEqual(wanted, wanted);
    return false;
  }
  return timingSafeEqual(given, wanted);
};

/**
 * The QR code's text: a Frameleaf app link naming the server and its code, so the app that scans it
 * knows which server on the network the code belongs to.
 */
export const setupQrText = (serverId: string, code: string): string =>
  `frameleaf://setup?server=${encodeURIComponent(serverId)}&code=${formatSetupCode(code)}`;

/**
 * Whether a request reached the server from the home network: the edge worker vouched `lan`, or no
 * edge worker was involved and the client address is a home address (private ranges, loopback, and
 * `FRAMELEAF_TRUSTED_LAN_CIDRS`). Remote access (`wan`, `relay`) never is.
 */
export const isLanRequest = (
  via: FrameleafVia | null | undefined,
  clientIp: string | undefined,
  trustedLanCidrs: string[],
): boolean => {
  if (isRemoteVia(via)) {
    return false;
  }
  return via === 'lan' || isHomeAddress(clientIp, trustedLanCidrs);
};
