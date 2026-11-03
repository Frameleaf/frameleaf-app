import { generateKeyPair, keyId } from '@frameleaf/locked-crypto';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LockedKeyHolder, lockedHourMs } from 'src/utils/locked-key-holder.js';

const owner = 'owner';
const viewer = 'viewer';

describe(LockedKeyHolder.name, () => {
  let sut: LockedKeyHolder;

  beforeEach(() => {
    // the expiry dates below are all after this moment
    vi.useFakeTimers({ now: new Date('2026-10-31T00:00:00Z') });
    sut = new LockedKeyHolder();
  });

  afterEach(() => {
    sut.clear();
    vi.useRealTimers();
  });

  it('drop zero-fills the private key buffer', () => {
    const { publicKey, privateKey } = generateKeyPair();
    sut.load(owner, publicKey, privateKey, null);
    expect(privateKey.equals(Buffer.alloc(32))).toBe(false);

    sut.drop(owner);

    expect(privateKey.equals(Buffer.alloc(32))).toBe(true);
    expect(sut.has(owner)).toBe(false);
  });

  it('loading a new key zero-fills the one it replaces', () => {
    const first = generateKeyPair();
    sut.load(owner, first.publicKey, first.privateKey, null);
    const second = generateKeyPair();
    sut.load(owner, second.publicKey, second.privateKey, null);

    expect(first.privateKey.equals(Buffer.alloc(32))).toBe(true);
    expect(sut.forKeyId(keyId(second.publicKey))?.privateKey).toBe(second.privateKey);
  });

  it('pinned keys survive drop and sweepExpired', () => {
    const { publicKey, privateKey } = generateKeyPair();
    sut.load(owner, publicKey, privateKey, new Date('2026-10-31T01:00:00Z'));
    sut.pin(owner, true);

    sut.drop(owner);
    expect(sut.sweepExpired(new Date('2026-10-31T02:00:00Z'))).toEqual([]);
    expect(sut.has(owner)).toBe(true);
    expect(sut.forKeyId(keyId(publicKey))?.pinned).toBe(true);

    sut.pin(owner, false);
    expect(sut.sweepExpired(new Date('2026-10-31T02:00:00Z'))).toEqual([owner]);
    expect(privateKey.equals(Buffer.alloc(32))).toBe(true);
  });

  it('sweepExpired drops keys past expiresAt and returns their ids', () => {
    const expiring = generateKeyPair();
    const later = generateKeyPair();
    const forever = generateKeyPair();
    sut.load('a', expiring.publicKey, expiring.privateKey, new Date('2026-10-31T01:00:00Z'));
    sut.load('b', later.publicKey, later.privateKey, new Date('2026-10-31T05:00:00Z'));
    sut.load('c', forever.publicKey, forever.privateKey, null);

    expect(sut.sweepExpired(new Date('2026-10-31T02:00:00Z'))).toEqual(['a']);
    expect(sut.has('a')).toBe(false);
    expect(expiring.privateKey.equals(Buffer.alloc(32))).toBe(true);
    expect(sut.has('b')).toBe(true);
    expect(sut.expiresAt('b')).toEqual(new Date('2026-10-31T05:00:00Z'));
    expect(sut.has('c')).toBe(true);
    expect(sut.expiresAt('c')).toBeNull();
  });

  it('sweeps expired keys every minute on its own', () => {
    vi.useFakeTimers({ now: new Date('2026-10-31T00:00:00Z') });
    const { publicKey, privateKey } = generateKeyPair();
    sut.load(owner, publicKey, privateKey, new Date('2026-10-31T00:01:30Z'));

    vi.advanceTimersByTime(60_000);
    expect(sut.has(owner)).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(sut.has(owner)).toBe(false);
  });

  it('canRead is true for the owner, true for a granted viewer, false otherwise, and false after drop', () => {
    expect(sut.canRead(owner, owner)).toBe(false);
    const { publicKey, privateKey } = generateKeyPair();
    sut.load(owner, publicKey, privateKey, null);
    sut.grant(viewer, owner);

    expect(sut.canRead(owner, owner)).toBe(true);
    expect(sut.canRead(viewer, owner)).toBe(true);
    expect(sut.canRead('stranger', owner)).toBe(false);
    expect(sut.grantsOf(owner)).toEqual([viewer]);

    sut.drop(owner);

    expect(sut.canRead(owner, owner)).toBe(false);
    expect(sut.canRead(viewer, owner)).toBe(false);
    expect(sut.grantsOf(owner)).toEqual([]);
  });

  it('forKeyId finds by the 8-byte id', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    sut.load('a', a.publicKey, a.privateKey, null);
    sut.load('b', b.publicKey, b.privateKey, null);

    const id = keyId(b.publicKey);
    expect(id).toHaveLength(8);
    expect(sut.forKeyId(id)).toMatchObject({ userId: 'b', privateKey: b.privateKey, expiresAt: null, pinned: false });
    expect(sut.forKeyId(Buffer.alloc(8))).toBeUndefined();
  });

  it('never prints or serializes a private key', () => {
    const { publicKey, privateKey } = generateKeyPair();
    sut.load(owner, publicKey, privateKey, null);
    const secrets = [privateKey.toString('hex'), privateKey.toString('base64')];
    const bytes = [...privateKey].join(',');
    const held = sut.forKeyId(keyId(publicKey))!;

    for (const text of [
      JSON.stringify(held),
      JSON.stringify(sut.list()),
      JSON.stringify(sut),
      inspect(held, { depth: 10 }),
      inspect(sut.list(), { depth: 10 }),
      inspect(sut, { depth: 10, showHidden: true }),
      inspect({ wrapped: held }),
    ]) {
      for (const secret of secrets) expect(text).not.toContain(secret);
      expect(text).not.toContain(bytes);
      expect(text).not.toMatch(/<Buffer/);
    }
    expect(JSON.parse(JSON.stringify(held))).toEqual({
      userId: owner,
      keyId: keyId(publicKey).toString('hex'),
      expiresAt: null,
      pinned: false,
      privateKey: '[redacted]',
    });
    expect(held.privateKey).toBe(privateKey);
  });

  it('setGrants replaces the grants, so a viewer can lose access', () => {
    const { publicKey, privateKey } = generateKeyPair();
    sut.load(owner, publicKey, privateKey, null);
    sut.setGrants(owner, ['a', 'b']);
    sut.setGrants(owner, ['b']);

    expect(sut.canRead('a', owner)).toBe(false);
    expect(sut.canRead('b', owner)).toBe(true);
    expect(sut.grantsOf(owner)).toEqual(['b']);
  });

  it('refuses a private key that does not belong to the public key', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(() => sut.load(owner, a.publicKey, b.privateKey, null)).toThrow('does not match');
    expect(sut.has(owner)).toBe(false);
  });

  it('refuses a key whose expiry has already passed', () => {
    const { publicKey, privateKey } = generateKeyPair();
    expect(() => sut.load(owner, publicKey, privateKey, new Date('2026-10-30T23:59:59Z'))).toThrow('already expired');
    expect(sut.has(owner)).toBe(false);
  });

  it('onLoad tells listeners until they unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = sut.onLoad(listener);
    const first = generateKeyPair();
    sut.load(owner, first.publicKey, first.privateKey, null);
    unsubscribe();
    const second = generateKeyPair();
    sut.load(viewer, second.publicKey, second.privateKey, null);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(owner);
  });
});

describe(lockedHourMs.name, () => {
  it('is an hour on any server that is not under test', () => {
    expect(lockedHourMs({})).toBe(3_600_000);
    expect(lockedHourMs({ FRAMELEAF_LOCKED_TEST_HOUR_MS: '500' })).toBe(3_600_000);
    expect(lockedHourMs({ FRAMELEAF_ENV: 'production', FRAMELEAF_LOCKED_TEST_HOUR_MS: '500' })).toBe(3_600_000);
    expect(lockedHourMs({ FRAMELEAF_ENV: 'development', FRAMELEAF_LOCKED_TEST_HOUR_MS: '500' })).toBe(3_600_000);
  });

  it('follows the test hour only with FRAMELEAF_ENV=testing', () => {
    expect(lockedHourMs({ FRAMELEAF_ENV: 'testing', FRAMELEAF_LOCKED_TEST_HOUR_MS: '500' })).toBe(500);
    expect(lockedHourMs({ FRAMELEAF_ENV: 'testing' })).toBe(3_600_000);
    for (const bad of ['0', '-5', '1.5', 'soon', '']) {
      expect(lockedHourMs({ FRAMELEAF_ENV: 'testing', FRAMELEAF_LOCKED_TEST_HOUR_MS: bad })).toBe(3_600_000);
    }
  });
});
