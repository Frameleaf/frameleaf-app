import { keyId as toKeyId } from '@frameleaf/locked-crypto';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { inspect } from 'node:util';

/** FL-721 (spec §4.3): how often every process drops the keys whose ask-again time has passed. */
const SWEEP_INTERVAL_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * FL-721: how long an ask-again hour is. Always an hour, except for the end-to-end suites: with
 * `FRAMELEAF_ENV=testing`, `FRAMELEAF_LOCKED_TEST_HOUR_MS` makes it that many milliseconds (and the
 * expiry sweep runs at least that often), so a suite can watch an 8-hour key expire. Any other
 * server ignores the variable.
 */
export const lockedHourMs = (env: NodeJS.ProcessEnv = process.env): number => {
  if (env.FRAMELEAF_ENV === 'testing') {
    const ms = Number(env.FRAMELEAF_LOCKED_TEST_HOUR_MS);
    if (Number.isSafeInteger(ms) && ms > 0) {
      return ms;
    }
  }
  return HOUR_MS;
};

export interface HeldKey {
  userId: string;
  keyId: Buffer;
  /** Owned by the holder from `load` on: zero-filled when the key is dropped or replaced. */
  privateKey: Buffer;
  expiresAt: Date | null;
  pinned: boolean;
  publicKey: Buffer;
}

type Entry = Omit<HeldKey, 'pinned'> & { grants: Set<string> };

const REDACTED = '[redacted]';
/** DER prefix of a PKCS#8 X25519 private key (RFC 8410), followed by the 32 raw bytes. */
const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

const derivePublicKey = (privateKey: Buffer) => {
  const der = Buffer.concat([PKCS8_X25519_PREFIX, privateKey]);
  try {
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    return Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x!, 'base64url');
  } finally {
    der.fill(0);
  }
};

/**
 * A held key as handed out by the holder. Printing it (`console.log`, `util.inspect`, a logger) or
 * `JSON.stringify` shows who and until when, never the private key.
 */
class HeldKeyValue implements HeldKey {
  userId: string;
  keyId: Buffer;
  privateKey: Buffer;
  expiresAt: Date | null;
  pinned: boolean;
  publicKey: Buffer;

  constructor(entry: Entry, pinned: boolean) {
    this.userId = entry.userId;
    this.keyId = entry.keyId;
    this.privateKey = entry.privateKey;
    this.expiresAt = entry.expiresAt;
    this.pinned = pinned;
    this.publicKey = entry.publicKey;
  }

  toJSON() {
    return {
      userId: this.userId,
      keyId: this.keyId.toString('hex'),
      expiresAt: this.expiresAt,
      pinned: this.pinned,
      privateKey: REDACTED,
    };
  }

  [inspect.custom]() {
    return `HeldKey ${JSON.stringify(this.toJSON())}`;
  }
}

/**
 * FL-721 (spec §4.3): the unwrapped Locked private keys of this process, in memory only.
 *
 * - `load` takes ownership of the private key buffer; `drop`, a replacing `load` and expiry zero it.
 * - A pinned person (status `decrypting`) keeps their key through `drop` and expiry until unpinned.
 * - Grants say which viewers may read an owner's files while the owner's key is loaded; they end
 *   with the key.
 *
 * Never log or serialize a held key; the only way it leaves the process is the supervisor IPC
 * (`locked-key-ipc.ts`).
 */
export class LockedKeyHolder {
  private keys = new Map<string, Entry>();
  private pinned = new Set<string>();
  private listeners = new Set<(userId: string) => void>();
  private timer?: NodeJS.Timeout;

  load(userId: string, publicKey: Buffer, privateKey: Buffer, expiresAt: Date | null): void {
    if (privateKey.length !== 32) {
      throw new Error('A Locked private key is 32 bytes');
    }
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      throw new Error('Invalid Locked key expiry');
    }
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new Error('This Locked key has already expired');
    }
    const keyId = toKeyId(publicKey);
    if (!derivePublicKey(privateKey).equals(publicKey)) {
      throw new Error('The Locked private key does not match its public key');
    }
    const previous = this.keys.get(userId);
    const sameKey = previous?.keyId.equals(keyId) ?? false;
    if (previous && previous.privateKey !== privateKey) {
      previous.privateKey.fill(0);
    }
    this.keys.set(userId, {
      userId,
      keyId,
      publicKey: Buffer.from(publicKey),
      privateKey,
      expiresAt,
      grants: sameKey ? previous!.grants : new Set(),
    });
    this.schedule();
    for (const listener of this.listeners) {
      try {
        listener(userId);
      } catch {
        // a listener only wakes deferred work; its failure must not undo the load
      }
    }
  }

  drop(userId: string): void {
    if (this.pinned.has(userId)) {
      return;
    }
    this.remove(userId);
  }

  pin(userId: string, pinned: boolean): void {
    if (pinned) {
      this.pinned.add(userId);
    } else {
      this.pinned.delete(userId);
    }
  }

  forKeyId(keyId: Buffer): HeldKey | undefined {
    for (const entry of this.keys.values()) {
      if (entry.keyId.equals(keyId)) {
        return this.toHeld(entry);
      }
    }
  }

  has(userId: string): boolean {
    return this.keys.has(userId);
  }

  expiresAt(userId: string): Date | null {
    return this.keys.get(userId)?.expiresAt ?? null;
  }

  grant(viewerId: string, ownerId: string): void {
    this.keys.get(ownerId)?.grants.add(viewerId);
  }

  /** Replaces the owner's grants with exactly these viewers (an IPC `load` is authoritative). */
  setGrants(ownerId: string, viewerIds: string[]): void {
    const entry = this.keys.get(ownerId);
    if (entry) {
      entry.grants = new Set(viewerIds);
    }
  }

  canRead(viewerId: string, ownerId: string): boolean {
    const entry = this.keys.get(ownerId);
    return !!entry && (viewerId === ownerId || entry.grants.has(viewerId));
  }

  grantsOf(ownerId: string): string[] {
    return [...(this.keys.get(ownerId)?.grants ?? [])];
  }

  list(): HeldKey[] {
    return this.keys
      .values()
      .map((entry) => this.toHeld(entry))
      .toArray();
  }

  pinnedUsers(): string[] {
    return [...this.pinned];
  }

  onLoad(listener: (userId: string) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  sweepExpired(now = new Date()): string[] {
    const dropped: string[] = [];
    for (const { userId, expiresAt } of this.keys.values()) {
      if (expiresAt && expiresAt <= now && !this.pinned.has(userId)) {
        this.remove(userId);
        dropped.push(userId);
      }
    }
    return dropped;
  }

  /** Drops every key, pinned or not, and forgets the pins. */
  clear(): void {
    this.pinned.clear();
    for (const userId of this.keys.keys()) {
      this.remove(userId);
    }
  }

  private remove(userId: string) {
    const entry = this.keys.get(userId);
    if (!entry) {
      return;
    }
    entry.privateKey.fill(0);
    entry.grants.clear();
    this.keys.delete(userId);
    if (this.keys.size === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private schedule() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => this.sweepExpired(), Math.min(SWEEP_INTERVAL_MS, lockedHourMs()));
    this.timer.unref();
  }

  private toHeld(entry: Entry): HeldKey {
    return new HeldKeyValue(entry, this.pinned.has(entry.userId));
  }

  /** Printing or serializing the holder names the people whose keys are loaded, never the keys. */
  toJSON() {
    return { keys: this.list().map((key) => (key as HeldKeyValue).toJSON()) };
  }

  [inspect.custom]() {
    return `LockedKeyHolder ${JSON.stringify(this.toJSON())}`;
  }
}

/** The keys of this process (the API, the supervisor's relay or a job worker; never the edge worker). */
export const lockedKeys = new LockedKeyHolder();
