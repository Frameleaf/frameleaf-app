/**
 * FL-721: the rules behind the Locked encryption pages (prototype PR 20,
 * `settings-v2/cloud/LockedEncryption.jsx`), kept free of Svelte so they can be tested on their own.
 * Nothing here stores a PIN, passphrase or recovery key; the recovery key file is made in the browser
 * from the one response that carries it (spec §11).
 */
import { LockedEncryptionMode, LockedEncryptionState, type LockedEncryptionStatusResponseDto } from '@frameleaf/sdk';

/** The server's minimum for a passphrase (`LockedEncryptionEnableDto`). */
export const PASSPHRASE_MIN_LENGTH = 12;
/** Ask-again choices, in hours; `null` is "Only after a restart" (spec §2). */
export const ASK_AGAIN_CHOICES = [8, 24, 72, null] as const;
export type AskAgain = (typeof ASK_AGAIN_CHOICES)[number];

/**
 * Which of the page's states the status is in: the prototype's five (off, pin, advanced, needs,
 * working), plus turning off (`decrypting`) and turning off after a restart (`finish`, spec §4.3).
 */
export type LockedEncryptionView = 'off' | 'pin' | 'advanced' | 'needs' | 'working' | 'decrypting' | 'finish';

export const lockedEncryptionView = (status: LockedEncryptionStatusResponseDto): LockedEncryptionView => {
  if (!status.enabled) {
    return 'off';
  }
  if (status.status === LockedEncryptionState.Decrypting) {
    return status.keyLoaded ? 'decrypting' : 'finish';
  }
  if (status.status === LockedEncryptionState.Encrypting) {
    return 'working';
  }
  if (status.mode === LockedEncryptionMode.Advanced) {
    return status.keyLoaded ? 'advanced' : 'needs';
  }
  return 'pin';
};

export type PassphraseStrength = 'none' | 'weak' | 'good' | 'great';

/** The prototype's strength bar: under 12 is weak, 20 or more is very strong. */
export const passphraseStrength = (passphrase: string): PassphraseStrength =>
  passphrase.length === 0
    ? 'none'
    : passphrase.length < PASSPHRASE_MIN_LENGTH
      ? 'weak'
      : passphrase.length >= 20
        ? 'great'
        : 'good';

/** A new passphrase that can be sent: long enough, and typed the same twice. */
export const passphraseReady = (passphrase: string, again: string) =>
  passphrase.length >= PASSPHRASE_MIN_LENGTH && passphrase === again;

/** `frameleaf-recovery-key-<name>.txt`, with the person's name made safe for a file name. */
export const recoveryKeyFileName = (name: string) => {
  const slug = name
    .normalize('NFKD')
    .replaceAll(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return `frameleaf-recovery-key-${slug || 'account'}.txt`;
};

/** Saves `text` as a file the browser downloads; nothing is sent anywhere. */
export const downloadTextFile = (fileName: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

/** Opens a page with only the key on it and asks the browser to print it. */
export const printRecoveryKey = (title: string, lines: string[]) => {
  const view = window.open('', '_blank');
  if (!view) {
    return false;
  }
  const document_ = view.document;
  document_.title = title;
  const body = document_.body;
  body.style.font = '16px/1.5 system-ui, sans-serif';
  body.style.padding = '32px';
  for (const [index, line] of lines.entries()) {
    const element = document_.createElement(index === 1 ? 'pre' : 'p');
    element.textContent = line;
    if (index === 1) {
      element.style.font = '600 20px/1.4 ui-monospace, monospace';
      element.style.letterSpacing = '1px';
    }
    body.append(element);
  }
  view.focus();
  view.print();
  return true;
};

/** When the open key is asked for again, in the prototype's words: "6:14 PM today", "tomorrow, 10:14 AM", "Tuesday, 10:14 AM". */
export const untilParts = (expiresAt: string, now: Date, locale?: string) => {
  const at = new Date(expiresAt);
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (days <= 0) {
    return { kind: 'today' as const, time };
  }
  if (days === 1) {
    return { kind: 'tomorrow' as const, time };
  }
  if (days < 7) {
    return { kind: 'day' as const, time, day: at.toLocaleDateString(locale, { weekday: 'long' }) };
  }
  return { kind: 'day' as const, time, day: at.toLocaleDateString(locale, { dateStyle: 'medium' }) };
};

/** The 423 a Locked read or action answers while the key isn't open (spec §8, §6.2). */
export type LockedKeyNeed = { reason?: 'owner-passphrase' | 'not-ready'; mode?: 'pin' | 'advanced' };

/**
 * The 423 `locked_key_unavailable` body, read from what the SDK throws (status and parsed data). The
 * check is by shape so it holds wherever the error class comes from.
 */
export const lockedKeyNeedOf = (error: unknown): LockedKeyNeed | undefined => {
  const candidate = error as { status?: unknown; data?: unknown } | undefined;
  if (!candidate || candidate.status !== 423) {
    return;
  }
  let data = candidate.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return;
    }
  }
  const body = data as { code?: unknown; reason?: unknown; mode?: unknown } | undefined;
  if (body?.code !== 'locked_key_unavailable') {
    return;
  }
  return {
    reason: body.reason === 'owner-passphrase' || body.reason === 'not-ready' ? body.reason : undefined,
    mode: body.mode === 'pin' || body.mode === 'advanced' ? body.mode : undefined,
  };
};
