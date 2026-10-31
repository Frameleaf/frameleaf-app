import { describe, expect, it } from 'vitest';
import {
  type LockedKeyFile,
  WrongSecretError,
  generateKeyPair,
  generateRecoveryKey,
  parseRecoveryKey,
  removeWrap,
  unwrapKey,
  wrapKey,
} from '../src/index.js';

const pair = generateKeyPair();
const base: Omit<LockedKeyFile, 'wraps'> = {
  format: 'frameleaf-locked-key/1',
  userId: '6a1f0c52-2b7e-4d3a-9f0e-1c2d3e4f5a6b',
  label: 'Taylor',
  publicKey: pair.publicKey.toString('base64'),
  mode: 'pin',
  encrypting: true,
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
};

describe('key files', { timeout: 30_000 }, () => {
  it('wrap/unwrap round-trips for pin, passphrase and recovery', async () => {
    const recovery = generateRecoveryKey();
    const withPin = await wrapKey(base, pair.privateKey, 'pin', '482915');
    const withPassphrase = await wrapKey(
      { ...withPin, mode: 'pin' },
      pair.privateKey,
      'passphrase',
      'correct horse battery',
    );
    const file = await wrapKey(withPassphrase, pair.privateKey, 'recovery', recovery);

    expect(file.wraps.map(({ kind }) => kind)).toEqual(['pin', 'passphrase', 'recovery']);
    expect(await unwrapKey(file, 'pin', '482915')).toEqual(pair.privateKey);
    expect(await unwrapKey(file, 'passphrase', 'correct horse battery')).toEqual(pair.privateKey);
    expect(await unwrapKey(file, 'recovery', recovery)).toEqual(pair.privateKey);
    expect(JSON.stringify(file)).not.toContain(pair.privateKey.toString('base64'));
  });

  it('replaces any wrap of the same kind', async () => {
    const first = await wrapKey(base, pair.privateKey, 'pin', '111111');
    const second = await wrapKey(first, pair.privateKey, 'pin', '222222');
    expect(second.wraps).toHaveLength(1);
    await expect(unwrapKey(second, 'pin', '111111')).rejects.toBeInstanceOf(WrongSecretError);
    expect(await unwrapKey(second, 'pin', '222222')).toEqual(pair.privateKey);
  });

  it('wrong secret throws WrongSecretError', async () => {
    const recovery = generateRecoveryKey();
    const withPin = await wrapKey(base, pair.privateKey, 'pin', '482915');
    const file = await wrapKey(withPin, pair.privateKey, 'recovery', recovery);
    await expect(unwrapKey(file, 'pin', '482916')).rejects.toBeInstanceOf(WrongSecretError);
    await expect(unwrapKey(file, 'recovery', generateRecoveryKey())).rejects.toBeInstanceOf(WrongSecretError);
    await expect(unwrapKey(file, 'recovery', 'FLRK-ABCD')).rejects.toBeInstanceOf(WrongSecretError);
    await expect(unwrapKey(file, 'passphrase', '482915')).rejects.toBeInstanceOf(WrongSecretError);
    // The wrap is bound to its user and kind.
    await expect(unwrapKey({ ...file, userId: 'someone-else' }, 'pin', '482915')).rejects.toBeInstanceOf(
      WrongSecretError,
    );
  });

  it('scrypt params are N=131072 r=8 p=1', async () => {
    const file = await wrapKey(base, pair.privateKey, 'pin', '482915');
    const [wrap] = file.wraps;
    expect(wrap).toMatchObject({ kind: 'pin', kdf: 'scrypt', N: 131_072, r: 8, p: 1 });
    expect(Buffer.from(wrap!.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(wrap!.nonce, 'base64')).toHaveLength(12);
    expect(Buffer.from(wrap!.ciphertext, 'base64')).toHaveLength(48);

    const recovery = await wrapKey(base, pair.privateKey, 'recovery', generateRecoveryKey());
    expect(recovery.wraps[0]).toMatchObject({ kind: 'recovery', kdf: 'hkdf-sha256' });
    expect(recovery.wraps[0]).not.toHaveProperty('N');
  });

  it('generateRecoveryKey matches /^FLRK(-[A-Z2-7]{4}){8}$/, and parseRecoveryKey accepts it in lower case with spaces', () => {
    const key = generateRecoveryKey();
    expect(key).toMatch(/^FLRK(-[A-Z2-7]{4}){8}$/);
    expect(generateRecoveryKey()).not.toBe(key);
    const raw = parseRecoveryKey(key);
    expect(raw).toHaveLength(20);
    expect(parseRecoveryKey(key.toLowerCase().replaceAll('-', ' '))).toEqual(raw);
    expect(parseRecoveryKey(key.slice(5))).toEqual(raw);
    expect(() => parseRecoveryKey(key.slice(0, -1))).toThrow();
    expect(() => parseRecoveryKey(`${key}A`)).toThrow();
    expect(() => parseRecoveryKey(key.replace(/.$/, '1'))).toThrow();
  });

  it("removeWrap('pin') leaves the passphrase and recovery wraps", async () => {
    let file = await wrapKey(base, pair.privateKey, 'pin', '482915');
    file = await wrapKey(file, pair.privateKey, 'passphrase', 'correct horse battery');
    file = await wrapKey(file, pair.privateKey, 'recovery', generateRecoveryKey());
    const removed = removeWrap(file, 'pin');
    expect(removed.wraps.map(({ kind }) => kind)).toEqual(['passphrase', 'recovery']);
    expect(file.wraps).toHaveLength(3);
    expect(await unwrapKey(removed, 'passphrase', 'correct horse battery')).toEqual(pair.privateKey);
  });

  it('refuses a private key that does not match the file', async () => {
    await expect(wrapKey(base, generateKeyPair().privateKey, 'pin', '482915')).rejects.toThrow(/does not match/);
  });

  it('never adds a pin wrap in advanced mode', async () => {
    await expect(wrapKey({ ...base, mode: 'advanced' }, pair.privateKey, 'pin', '482915')).rejects.toThrow(/advanced/);
  });
});
