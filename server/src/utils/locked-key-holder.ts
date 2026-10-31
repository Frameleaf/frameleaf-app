import { keyId as toKeyId } from '@frameleaf/locked-crypto';

/** FL-721 (spec §4.3): how often every process drops the keys whose ask-again time has passed. */
const SWEEP_INTERVAL_MS = 60_000;

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
    const keyId = toKeyId(publicKey);
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
    this.timer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  private toHeld({ grants: _, ...entry }: Entry): HeldKey {
    return { ...entry, pinned: this.pinned.has(entry.userId) };
  }
}

/** The keys of this process (API, a job worker or the edge worker). */
export const lockedKeys = new LockedKeyHolder();
