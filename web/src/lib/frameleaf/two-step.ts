/**
 * FL-831: two-step sign-in on the web (the approved FL-776 prototype, `src/two-step.mjs`). The rules
 * the screens follow, as the server (FL-793) applies them: 6-digit codes, the code within 5 minutes of
 * the password, 5 wrong codes per sign-in then a 10-minute pause, "Trust this browser" for 30 days and
 * 10 recovery codes in the form `xxxxx-xxxxx`, shown once.
 */
import { isHttpError } from '@frameleaf/sdk';

export const CODE_LENGTH = 6;
export const TRUST_DAYS = 30;
export const SIGN_IN_MINUTES = 5;
export const WRONG_CODES_ALLOWED = 5;
export const LOCK_MINUTES = 10;
export const RECOVERY_CODE_COUNT = 10;

/** What the person typed, as a code: digits only, at most six. Spaces and dashes from a paste go. */
export const cleanCode = (value: string | null | undefined) =>
  (value ?? '').replaceAll(/\D/g, '').slice(0, CODE_LENGTH);
const CODE_PATTERN = new RegExp(String.raw`^\d{${CODE_LENGTH}}$`);
export const isCode = (value: string) => CODE_PATTERN.test(value);

/**
 * A recovery code as typed: lower case, the dash put back after five characters. A line pasted from
 * the codes file ("1. aaaaa-bbbbb") loses its number first.
 */
export const cleanRecoveryCode = (value: string | null | undefined) => {
  const raw = (value ?? '')
    .replace(/^\s*\d+[.)]\s+/, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, '')
    .slice(0, 10);
  return raw.length > 5 ? `${raw.slice(0, 5)}-${raw.slice(5)}` : raw;
};
export const isRecoveryCode = (value: string) => /^[a-z0-9]{5}-[a-z0-9]{5}$/.test(value);

/** "JBSW Y3DP EHPK …": the setup key in fours, easier to type into an app. */
export const groupKey = (key: string) => (key.match(/.{1,4}/g) ?? []).join(' ');

/** Tries left before the pause, after `wrong` wrong codes in this sign-in. */
export const triesLeft = (wrong: number) => Math.max(0, WRONG_CODES_ALLOWED - wrong);

/**
 * What a refused code means. `locked` is the server's rate limit (429 with `retryAfter` seconds);
 * `expired` is a sign-in whose password step ran out (401 with the server's expired message);
 * any other 400 or 401 is a code (or password) that didn't work. `null` is not an answer from the
 * server at all (offline, a crash), said as a general failure.
 */
export type TwoStepRefusal = { kind: 'wrong' } | { kind: 'expired' } | { kind: 'locked'; minutes: number } | null;

const EXPIRED_MESSAGE = /expired/i;

const errorData = (error: unknown): Record<string, unknown> | undefined => {
  if (!isHttpError(error)) {
    return;
  }
  let data: unknown = error.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return;
    }
  }
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
};

/** Whole minutes to wait, at least one, from a 429's `retryAfter` seconds. */
export const waitMinutes = (error: unknown) => {
  const seconds = Number(errorData(error)?.retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : LOCK_MINUTES;
};

export const twoStepRefusal = (error: unknown): TwoStepRefusal => {
  if (!isHttpError(error)) {
    return null;
  }
  if (error.status === 429) {
    return { kind: 'locked', minutes: waitMinutes(error) };
  }
  const message = errorData(error)?.message;
  if (error.status === 401 && typeof message === 'string' && EXPIRED_MESSAGE.test(message)) {
    return { kind: 'expired' };
  }
  if (error.status === 400 || error.status === 401) {
    return { kind: 'wrong' };
  }
  return null;
};

/** The text file of recovery codes: the codes, numbered, with the account and the server they're for. */
export const recoveryCodesText = (
  codes: string[],
  { email, server, heading, note }: { email: string; server: string; heading: string; note: string },
) => [heading, '', email, server, '', ...codes.map((code, index) => `${index + 1}. ${code}`), '', note, ''].join('\n');

/** Saves the recovery codes as frameleaf-recovery-codes.txt. */
export const downloadRecoveryCodes = (text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'frameleaf-recovery-codes.txt';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

/**
 * Opens the print window with only the codes, the account and the server: a hidden frame holds a
 * page built from a text node (nothing in it is read as markup), prints, then goes.
 */
export const printRecoveryCodes = (text: string, title: string) => {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.position = 'fixed';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.append(frame);
  const page = frame.contentDocument;
  const view = frame.contentWindow;
  if (!page || !view) {
    frame.remove();
    return;
  }
  page.title = title;
  const pre = page.createElement('pre');
  pre.style.font = '16px/1.6 system-ui, sans-serif';
  pre.textContent = text;
  page.body.append(pre);
  const remove = () => frame.remove();
  view.addEventListener('afterprint', remove, { once: true });
  view.focus();
  view.print();
  // Browsers without afterprint still lose the frame once printing has had its moment.
  setTimeout(remove, 60_000);
};
