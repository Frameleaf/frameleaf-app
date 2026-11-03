import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  type LockedKeyFile,
  LockedKeyFileCorruptError,
  LockedPepperError,
  PEPPER_BYTES,
  WrongSecretError,
  generateKeyPair,
  generateRecoveryKey,
  hasUnpepperedPinWrap,
  isKeyFileFormat,
  parseRecoveryKey,
  pepperId,
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
    const file = await wrapKey(
      withPassphrase,
      pair.privateKey,
      'recovery',
      recovery,
    );

    expect(file.wraps.map(({ kind }) => kind)).toEqual([
      'pin',
      'passphrase',
      'recovery',
    ]);
    expect(await unwrapKey(file, 'pin', '482915')).toEqual(pair.privateKey);
    expect(
      await unwrapKey(file, 'passphrase', 'correct horse battery'),
    ).toEqual(pair.privateKey);
    expect(await unwrapKey(file, 'recovery', recovery)).toEqual(
      pair.privateKey,
    );
    expect(JSON.stringify(file)).not.toContain(
      pair.privateKey.toString('base64'),
    );
  });

  it('replaces any wrap of the same kind', async () => {
    const first = await wrapKey(base, pair.privateKey, 'pin', '111111');
    const second = await wrapKey(first, pair.privateKey, 'pin', '222222');
    expect(second.wraps).toHaveLength(1);
    await expect(unwrapKey(second, 'pin', '111111')).rejects.toBeInstanceOf(
      WrongSecretError,
    );
    expect(await unwrapKey(second, 'pin', '222222')).toEqual(pair.privateKey);
  });

  it('wrong secret throws WrongSecretError', async () => {
    const recovery = generateRecoveryKey();
    const withPin = await wrapKey(base, pair.privateKey, 'pin', '482915');
    const file = await wrapKey(withPin, pair.privateKey, 'recovery', recovery);
    await expect(unwrapKey(file, 'pin', '482916')).rejects.toBeInstanceOf(
      WrongSecretError,
    );
    await expect(
      unwrapKey(file, 'recovery', generateRecoveryKey()),
    ).rejects.toBeInstanceOf(WrongSecretError);
    await expect(
      unwrapKey(file, 'recovery', 'FLRK-ABCD'),
    ).rejects.toBeInstanceOf(WrongSecretError);
    await expect(
      unwrapKey(file, 'passphrase', '482915'),
    ).rejects.toBeInstanceOf(WrongSecretError);
    // The wrap is bound to its user and kind.
    await expect(
      unwrapKey({ ...file, userId: 'someone-else' }, 'pin', '482915'),
    ).rejects.toBeInstanceOf(WrongSecretError);
  });

  it('scrypt params are N=131072 r=8 p=1', async () => {
    const file = await wrapKey(base, pair.privateKey, 'pin', '482915');
    const [wrap] = file.wraps;
    expect(wrap).toMatchObject({
      kind: 'pin',
      kdf: 'scrypt',
      N: 131_072,
      r: 8,
      p: 1,
    });
    expect(Buffer.from(wrap!.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(wrap!.nonce, 'base64')).toHaveLength(12);
    expect(Buffer.from(wrap!.ciphertext, 'base64')).toHaveLength(48);

    const recovery = await wrapKey(
      base,
      pair.privateKey,
      'recovery',
      generateRecoveryKey(),
    );
    expect(recovery.wraps[0]).toMatchObject({
      kind: 'recovery',
      kdf: 'hkdf-sha256',
    });
    expect(recovery.wraps[0]).not.toHaveProperty('N');
  });

  it('generateRecoveryKey matches /^FLRK(-[A-Z2-7]{4}){8}$/, and parseRecoveryKey accepts it in lower case with spaces', () => {
    const key = generateRecoveryKey();
    expect(key).toMatch(/^FLRK(-[A-Z2-7]{4}){8}$/);
    expect(generateRecoveryKey()).not.toBe(key);
    const raw = parseRecoveryKey(key);
    expect(raw).toHaveLength(20);
    expect(parseRecoveryKey(key.toLowerCase().replaceAll('-', ' '))).toEqual(
      raw,
    );
    expect(parseRecoveryKey(key.slice(5))).toEqual(raw);
    expect(() => parseRecoveryKey(key.slice(0, -1))).toThrow();
    expect(() => parseRecoveryKey(`${key}A`)).toThrow();
    expect(() => parseRecoveryKey(key.replace(/.$/, '1'))).toThrow();
  });

  it("removeWrap('pin') leaves the passphrase and recovery wraps", async () => {
    let file = await wrapKey(base, pair.privateKey, 'pin', '482915');
    file = await wrapKey(
      file,
      pair.privateKey,
      'passphrase',
      'correct horse battery',
    );
    file = await wrapKey(
      file,
      pair.privateKey,
      'recovery',
      generateRecoveryKey(),
    );
    const removed = removeWrap(file, 'pin');
    expect(removed.wraps.map(({ kind }) => kind)).toEqual([
      'passphrase',
      'recovery',
    ]);
    expect(file.wraps).toHaveLength(3);
    expect(
      await unwrapKey(removed, 'passphrase', 'correct horse battery'),
    ).toEqual(pair.privateKey);
  });

  it('refuses a private key that does not match the file', async () => {
    await expect(
      wrapKey(base, generateKeyPair().privateKey, 'pin', '482915'),
    ).rejects.toThrow(/does not match/);
  });

  it('never adds a pin wrap in advanced mode', async () => {
    await expect(
      wrapKey({ ...base, mode: 'advanced' }, pair.privateKey, 'pin', '482915'),
    ).rejects.toThrow(/advanced/);
  });

  describe('format 2: peppered PIN wraps', () => {
    const pepper = randomBytes(PEPPER_BYTES);

    it('a PIN wrap made with a pepper records the pepper id, bumps the file to format 2 and opens only with that pepper', async () => {
      const file = await wrapKey(base, pair.privateKey, 'pin', '482915', {
        pepper,
      });
      expect(file.format).toBe('frameleaf-locked-key/2');
      expect(file.wraps[0]).toMatchObject({
        kind: 'pin',
        kdf: 'scrypt',
        pepper: { kdf: 'hkdf-sha256', id: pepperId(pepper) },
      });
      expect(hasUnpepperedPinWrap(file)).toBe(false);
      expect(JSON.stringify(file)).not.toContain(pepper.toString('base64'));

      expect(await unwrapKey(file, 'pin', '482915', { pepper })).toEqual(
        pair.privateKey,
      );
      await expect(
        unwrapKey(file, 'pin', '482916', { pepper }),
      ).rejects.toBeInstanceOf(WrongSecretError);
      await expect(unwrapKey(file, 'pin', '482915')).rejects.toMatchObject({
        name: 'LockedPepperError',
        reason: 'missing',
      });
      await expect(
        unwrapKey(file, 'pin', '482915', { pepper: randomBytes(PEPPER_BYTES) }),
      ).rejects.toMatchObject({
        name: 'LockedPepperError',
        reason: 'mismatch',
      });
      // a planted id does not turn a wrong pepper into a wrong-PIN answer: the tag still fails
      const other = randomBytes(PEPPER_BYTES);
      const planted = {
        ...file,
        wraps: [
          {
            ...file.wraps[0],
            pepper: { kdf: 'hkdf-sha256', id: pepperId(other) },
          },
        ],
      };
      await expect(
        unwrapKey(planted as LockedKeyFile, 'pin', '482915', { pepper: other }),
      ).rejects.toBeInstanceOf(WrongSecretError);
    });

    it('a format-1 file (no pepper record) still opens, with or without a pepper offered', async () => {
      const legacy = await wrapKey(base, pair.privateKey, 'pin', '482915');
      expect(legacy.format).toBe('frameleaf-locked-key/1');
      expect(legacy.wraps[0]).not.toHaveProperty('pepper');
      expect(hasUnpepperedPinWrap(legacy)).toBe(true);
      expect(await unwrapKey(legacy, 'pin', '482915')).toEqual(pair.privateKey);
      expect(await unwrapKey(legacy, 'pin', '482915', { pepper })).toEqual(
        pair.privateKey,
      );
      await expect(
        unwrapKey(legacy, 'pin', '482916', { pepper }),
      ).rejects.toBeInstanceOf(WrongSecretError);
    });

    it('rewrapping a format-1 PIN wrap with a pepper keeps the other wraps as they were', async () => {
      const recovery = generateRecoveryKey();
      let legacy = await wrapKey(base, pair.privateKey, 'pin', '482915');
      legacy = await wrapKey(legacy, pair.privateKey, 'recovery', recovery);
      const upgraded = await wrapKey(legacy, pair.privateKey, 'pin', '482915', {
        pepper,
      });
      expect(upgraded.format).toBe('frameleaf-locked-key/2');
      expect(upgraded.wraps.find(({ kind }) => kind === 'recovery')).toEqual(
        legacy.wraps.find(({ kind }) => kind === 'recovery'),
      );
      expect(await unwrapKey(upgraded, 'pin', '482915', { pepper })).toEqual(
        pair.privateKey,
      );
      expect(await unwrapKey(upgraded, 'recovery', recovery)).toEqual(
        pair.privateKey,
      );
      // the format stays 2 once bumped, even when the peppered wrap is removed again
      expect(removeWrap(upgraded, 'pin').format).toBe('frameleaf-locked-key/2');
      expect(isKeyFileFormat('frameleaf-locked-key/2')).toBe(true);
      expect(isKeyFileFormat('frameleaf-locked-key/3')).toBe(false);
    });

    it('the pepper only ever applies to PIN wraps', async () => {
      const recovery = generateRecoveryKey();
      const passphrase = await wrapKey(
        { ...base, mode: 'advanced' },
        pair.privateKey,
        'passphrase',
        'correct horse',
        {
          pepper,
        },
      );
      expect(passphrase.format).toBe('frameleaf-locked-key/1');
      expect(passphrase.wraps[0]).not.toHaveProperty('pepper');
      const withRecovery = await wrapKey(
        passphrase,
        pair.privateKey,
        'recovery',
        recovery,
        { pepper },
      );
      expect(withRecovery.wraps[1]).not.toHaveProperty('pepper');
      expect(
        await unwrapKey(withRecovery, 'passphrase', 'correct horse'),
      ).toEqual(pair.privateKey);
      await expect(
        wrapKey(base, pair.privateKey, 'pin', '482915', {
          pepper: randomBytes(8),
        }),
      ).rejects.toThrow(/at least 16 bytes/);
    });
  });

  describe('hostile key files', () => {
    const tamper = async (
      change: (wrap: LockedKeyFile['wraps'][number]) => object,
    ) => {
      const file = await wrapKey(base, pair.privateKey, 'pin', '482915');
      return {
        ...file,
        wraps: [{ ...file.wraps[0], ...change(file.wraps[0]) }],
      } as LockedKeyFile;
    };

    it('refuses scrypt parameters other than the fixed ones before deriving anything', async () => {
      for (const change of [
        { p: 100_000_000 },
        { N: 1 << 25 },
        { N: 1024 },
        { r: 1 },
        { r: 1024, N: 1024 },
        { kdf: 'argon2' },
      ]) {
        const started = Date.now();
        await expect(
          unwrapKey(await tamper(() => change), 'pin', '482915'),
        ).rejects.toBeInstanceOf(LockedKeyFileCorruptError);
        // a hostile p of 10^8 would spin for hours; the check must reject it at once
        expect(Date.now() - started).toBeLessThan(1000);
      }
    });

    it('refuses salts, nonces, ciphertexts and pepper records of the wrong shape', async () => {
      for (const change of [
        { salt: randomBytes(8).toString('base64') },
        { nonce: randomBytes(16).toString('base64') },
        { ciphertext: randomBytes(47).toString('base64') },
        { pepper: { kdf: 'hkdf-sha256', id: 'short' } },
        { pepper: { kdf: 'pbkdf2', id: randomBytes(8).toString('base64') } },
      ]) {
        await expect(
          unwrapKey(await tamper(() => change), 'pin', '482915'),
        ).rejects.toBeInstanceOf(LockedKeyFileCorruptError);
      }
      const recovery = await wrapKey(
        base,
        pair.privateKey,
        'recovery',
        generateRecoveryKey(),
      );
      const peppered = {
        ...recovery,
        wraps: [
          {
            ...recovery.wraps[0],
            pepper: {
              kdf: 'hkdf-sha256',
              id: randomBytes(8).toString('base64'),
            },
          },
        ],
      } as LockedKeyFile;
      await expect(
        unwrapKey(peppered, 'recovery', generateRecoveryKey()),
      ).rejects.toBeInstanceOf(LockedKeyFileCorruptError);
    });

    it('refuses an unknown file format', async () => {
      const file = await wrapKey(base, pair.privateKey, 'pin', '482915');
      await expect(
        unwrapKey(
          { ...file, format: 'frameleaf-locked-key/3' as never },
          'pin',
          '482915',
        ),
      ).rejects.toThrow(/Unsupported key file format/);
    });
  });
});
