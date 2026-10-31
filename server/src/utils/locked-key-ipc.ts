import { parentPort } from 'node:worker_threads';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { LockedKeyHolder } from 'src/utils/locked-key-holder.js';

/**
 * FL-721 (spec §4.3): unwrapped Locked keys travel from the API process to the job workers and the
 * edge worker over the supervisor's IPC only (`process.send` to the supervisor, then `process.send`
 * or `worker.postMessage` to each worker), never through Redis, the database or disk.
 *
 * API process ─ publishLockedKey ─▶ supervisor (LockedKeyRelay) ─▶ microservices thread, edge process
 *                                                                   (attachLockedKeyIpc)
 *
 * The API process updates its own `lockedKeys` itself; the supervisor does not echo messages back.
 * A worker announces `locked-key-ready` once it listens, and the supervisor answers with the keys
 * currently loaded, so a worker that (re)starts misses nothing whatever its start-up timing.
 */
export type LockedKeyMessage =
  | {
      type: 'locked-key';
      action: 'load';
      userId: string;
      publicKey: string;
      privateKey: string;
      expiresAt: string | null;
      grants: string[];
    }
  | { type: 'locked-key'; action: 'drop' | 'pin' | 'unpin'; userId: string };

export const LOCKED_KEY_READY = { type: 'locked-key-ready' } as const;

type MessageChannel = {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
  postMessage?: (message: unknown) => void;
  send?: (message: unknown) => unknown;
};

const logger = LoggingRepository.create('LockedKeyIpc');

const isString = (value: unknown): value is string => typeof value === 'string';

export const isLockedKeyReady = (value: unknown) =>
  !!value && typeof value === 'object' && (value as { type?: unknown }).type === LOCKED_KEY_READY.type;

export const isLockedKeyMessage = (value: unknown): value is LockedKeyMessage => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const message = value as Record<string, unknown>;
  if (message.type !== 'locked-key' || !isString(message.userId)) {
    return false;
  }
  switch (message.action) {
    case 'drop':
    case 'pin':
    case 'unpin': {
      return true;
    }
    case 'load': {
      return (
        isString(message.publicKey) &&
        isString(message.privateKey) &&
        (message.expiresAt === null || isString(message.expiresAt)) &&
        Array.isArray(message.grants) &&
        message.grants.every((grant) => isString(grant))
      );
    }
    default: {
      return false;
    }
  }
};

/** Applies one message to a holder. Throws on a malformed load, after zeroing its key bytes. */
export const applyLockedKeyMessage = (holder: LockedKeyHolder, message: LockedKeyMessage) => {
  switch (message.action) {
    case 'load': {
      const privateKey = Buffer.from(message.privateKey, 'base64');
      try {
        holder.load(
          message.userId,
          Buffer.from(message.publicKey, 'base64'),
          privateKey,
          message.expiresAt === null ? null : new Date(message.expiresAt),
        );
      } catch (error) {
        privateKey.fill(0);
        throw error;
      }
      for (const viewerId of message.grants) {
        holder.grant(viewerId, message.userId);
      }
      break;
    }
    case 'drop': {
      holder.drop(message.userId);
      break;
    }
    case 'pin':
    case 'unpin': {
      holder.pin(message.userId, message.action === 'pin');
      break;
    }
  }
};

/**
 * API process → supervisor. A process without a supervisor (tests, the admin CLI) sends nothing; a
 * closed channel means the supervisor is gone, and the workers with it.
 */
export function publishLockedKey(message: LockedKeyMessage): void {
  process.send?.(message, undefined, undefined, () => {});
}

/**
 * Worker side: apply every locked-key message the supervisor sends, then ask it for the keys
 * currently loaded. `channel` is the worker thread's `parentPort`, or `process` in a forked worker.
 */
export function attachLockedKeyIpc(
  holder: LockedKeyHolder,
  channel: MessageChannel | null = parentPort ?? process,
): () => void {
  if (!channel) {
    return () => {};
  }
  const onMessage = (message: unknown) => {
    if (!isLockedKeyMessage(message)) {
      return;
    }
    try {
      applyLockedKeyMessage(holder, message);
    } catch {
      // never the error itself: it could describe the bytes it rejected
      logger.warn(`Ignored a malformed Locked key message (${message.action}) for user ${message.userId}`);
    }
  };
  channel.on('message', onMessage);
  if (channel.postMessage) {
    channel.postMessage(LOCKED_KEY_READY);
  } else {
    channel.send?.(LOCKED_KEY_READY);
  }
  return () => void channel.off('message', onMessage);
}

/**
 * Supervisor side: remembers which keys are loaded, so a job worker or edge worker that (re)starts
 * gets them again. It keeps them in a holder of its own, so they are zero-filled when dropped and
 * expire on the same clock as everywhere else.
 */
export class LockedKeyRelay {
  private holder = new LockedKeyHolder();

  /** Records one message from the API process. Returns false for one that must not be relayed. */
  record(message: LockedKeyMessage): boolean {
    try {
      applyLockedKeyMessage(this.holder, message);
      return true;
    } catch {
      logger.warn(`Ignored a malformed Locked key message (${message.action}) for user ${message.userId}`);
      return false;
    }
  }

  /** The messages that bring a fresh worker to the current state. */
  replay(): LockedKeyMessage[] {
    this.holder.sweepExpired();
    const loads: LockedKeyMessage[] = this.holder.list().map((key) => ({
      type: 'locked-key',
      action: 'load',
      userId: key.userId,
      publicKey: key.publicKey.toString('base64'),
      privateKey: key.privateKey.toString('base64'),
      expiresAt: key.expiresAt?.toISOString() ?? null,
      grants: this.holder.grantsOf(key.userId),
    }));
    const pins: LockedKeyMessage[] = this.holder
      .pinnedUsers()
      .map((userId) => ({ type: 'locked-key', action: 'pin', userId }));
    return [...loads, ...pins];
  }

  /**
   * Forgets everything (the API process restarted, so no key is loaded there any more). Returns the
   * messages that empty the running workers in the same way.
   */
  clear(): LockedKeyMessage[] {
    const users = new Set([...this.holder.pinnedUsers(), ...this.holder.list().map(({ userId }) => userId)]);
    this.holder.clear();
    return [...users].flatMap((userId): LockedKeyMessage[] => [
      { type: 'locked-key', action: 'unpin', userId },
      { type: 'locked-key', action: 'drop', userId },
    ]);
  }
}
