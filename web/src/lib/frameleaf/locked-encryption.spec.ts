import { LockedEncryptionMode, LockedEncryptionState, type LockedEncryptionStatusResponseDto } from '@frameleaf/sdk';
import {
  lockedEncryptionView,
  lockedKeyNeedOf,
  passphraseReady,
  passphraseStrength,
  recoveryKeyFileName,
  untilParts,
} from '$lib/frameleaf/locked-encryption';

const status = (overrides: Partial<LockedEncryptionStatusResponseDto>): LockedEncryptionStatusResponseDto => ({
  enabled: true,
  mode: LockedEncryptionMode.Pin,
  status: LockedEncryptionState.On,
  keyLoaded: true,
  expiresAt: null,
  askAgainHours: 72,
  recoveryKeyCreatedAt: null,
  progress: null,
  counts: { encrypted: 0, notEncryptable: 0 },
  ...overrides,
});

describe('Locked encryption rules (FL-721)', () => {
  it('names the page state from the status', () => {
    expect(lockedEncryptionView(status({ enabled: false }))).toBe('off');
    expect(lockedEncryptionView(status({}))).toBe('pin');
    expect(lockedEncryptionView(status({ mode: LockedEncryptionMode.Advanced }))).toBe('advanced');
    expect(lockedEncryptionView(status({ mode: LockedEncryptionMode.Advanced, keyLoaded: false }))).toBe('needs');
    expect(lockedEncryptionView(status({ status: LockedEncryptionState.Encrypting }))).toBe('working');
    expect(lockedEncryptionView(status({ status: LockedEncryptionState.Decrypting }))).toBe('decrypting');
    expect(lockedEncryptionView(status({ status: LockedEncryptionState.Decrypting, keyLoaded: false }))).toBe('finish');
  });

  it('judges a passphrase as the prototype does', () => {
    expect(passphraseStrength('')).toBe('none');
    expect(passphraseStrength('short')).toBe('weak');
    expect(passphraseStrength('twelve chars')).toBe('good');
    expect(passphraseStrength('twenty characters ok')).toBe('great');
    expect(passphraseReady('twelve chars', 'twelve chars')).toBe(true);
    expect(passphraseReady('twelve chars', 'twelve charz')).toBe(false);
  });

  it('names the recovery key file after the person', () => {
    expect(recoveryKeyFileName('Taylor')).toBe('frameleaf-recovery-key-taylor.txt');
    expect(recoveryKeyFileName('Zoë Ann')).toBe('frameleaf-recovery-key-zoe-ann.txt');
    expect(recoveryKeyFileName('')).toBe('frameleaf-recovery-key-account.txt');
  });

  it('says when the passphrase is asked for again', () => {
    const now = new Date(2026, 9, 31, 10, 0);
    expect(untilParts(new Date(2026, 9, 31, 18, 14).toISOString(), now, 'en-US').kind).toBe('today');
    expect(untilParts(new Date(2026, 10, 1, 10, 14).toISOString(), now, 'en-US').kind).toBe('tomorrow');
    expect(untilParts(new Date(2026, 10, 3, 10, 14).toISOString(), now, 'en-US')).toMatchObject({
      kind: 'day',
      day: 'Tuesday',
    });
  });

  it('reads the 423 the server answers while the key is not open', () => {
    const locked = (data: unknown) => ({ status: 423, data });
    expect(lockedKeyNeedOf(locked({ code: 'locked_key_unavailable', mode: 'advanced' }))).toEqual({
      mode: 'advanced',
      reason: undefined,
    });
    expect(lockedKeyNeedOf(locked(JSON.stringify({ code: 'locked_key_unavailable', reason: 'not-ready' })))).toEqual({
      mode: undefined,
      reason: 'not-ready',
    });
    expect(lockedKeyNeedOf(locked({ code: 'something_else' }))).toBeUndefined();
    expect(lockedKeyNeedOf({ status: 400, data: { code: 'locked_key_unavailable' } })).toBeUndefined();
  });
});
