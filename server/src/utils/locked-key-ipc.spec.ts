import { generateKeyPair } from '@frameleaf/locked-crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { LockedKeyHolder } from 'src/utils/locked-key-holder.js';
import {
  LOCKED_KEY_READY,
  LockedKeyMessage,
  LockedKeyRelay,
  attachLockedKeyIpc,
  isLockedKeyMessage,
  isLockedKeyReady,
  publishLockedKey,
} from 'src/utils/locked-key-ipc.js';

const loadMessage = (userId: string, expiresAt: string | null = null, grants: string[] = []) => {
  const { publicKey, privateKey } = generateKeyPair();
  const message: LockedKeyMessage = {
    type: 'locked-key',
    action: 'load',
    userId,
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
    expiresAt,
    grants,
  };
  return { message, publicKey, privateKey };
};

describe('locked-key IPC', () => {
  let holder: LockedKeyHolder;
  let channel: EventEmitter;

  beforeEach(() => {
    holder = new LockedKeyHolder();
    channel = new EventEmitter();
  });

  afterEach(() => {
    holder.clear();
    vi.restoreAllMocks();
  });

  it('a load message loads the holder and a drop message drops it', () => {
    attachLockedKeyIpc(holder, channel);
    const { message, privateKey } = loadMessage('owner', '2099-11-01T00:00:00.000Z', ['viewer']);

    channel.emit('message', message);

    expect(holder.has('owner')).toBe(true);
    expect(holder.expiresAt('owner')).toEqual(new Date('2099-11-01T00:00:00.000Z'));
    expect(holder.canRead('viewer', 'owner')).toBe(true);
    const held = holder.list()[0];
    expect(held.privateKey.equals(privateKey)).toBe(true);

    channel.emit('message', { type: 'locked-key', action: 'pin', userId: 'owner' });
    channel.emit('message', { type: 'locked-key', action: 'drop', userId: 'owner' });
    expect(holder.has('owner')).toBe(true);

    channel.emit('message', { type: 'locked-key', action: 'unpin', userId: 'owner' });
    channel.emit('message', { type: 'locked-key', action: 'drop', userId: 'owner' });
    expect(holder.has('owner')).toBe(false);
    expect(held.privateKey.equals(Buffer.alloc(32))).toBe(true);
  });

  it('asks the supervisor for the current keys once it listens', () => {
    const thread = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
    attachLockedKeyIpc(holder, thread);
    expect(thread.postMessage).toHaveBeenCalledWith(LOCKED_KEY_READY);

    const fork = Object.assign(new EventEmitter(), { send: vi.fn() });
    attachLockedKeyIpc(new LockedKeyHolder(), fork);
    expect(fork.send).toHaveBeenCalledWith(LOCKED_KEY_READY);
    expect(isLockedKeyReady(LOCKED_KEY_READY)).toBe(true);
  });

  it('ignores messages that are not locked-key messages', () => {
    attachLockedKeyIpc(holder, channel);
    channel.emit('message', 'frameleaf:stop');
    channel.emit('message', { type: 'database-unusable' });
    expect(holder.list()).toEqual([]);
    expect(isLockedKeyMessage({ type: 'locked-key', action: 'explode', userId: 'x' })).toBe(false);
  });

  it('messages never include the key in any logged form', () => {
    const logged: unknown[] = [];
    const capture = (...args: unknown[]) => void logged.push(...args);
    for (const method of ['log', 'debug', 'verbose', 'warn', 'error', 'fatal'] as const) {
      vi.spyOn(LoggingRepository.prototype, method).mockImplementation(capture);
    }
    for (const method of ['log', 'debug', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation(capture);
    }
    attachLockedKeyIpc(holder, channel);
    const good = loadMessage('owner');
    const bad = loadMessage('broken', 'not a date');
    const short = { ...loadMessage('short').message, publicKey: Buffer.alloc(5).toString('base64') };

    channel.emit('message', good.message);
    channel.emit('message', bad.message);
    channel.emit('message', short);
    channel.emit('message', { type: 'locked-key', action: 'drop', userId: 'owner' });

    expect(logged.length).toBeGreaterThan(0);
    const text = logged
      .map((item) => (item instanceof Error ? `${item.message} ${item.stack}` : String(item)))
      .join('\n');
    for (const secret of [good.message.privateKey, bad.message.privateKey, short.privateKey]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(Buffer.from(secret, 'base64').toString('hex'));
    }
    expect(holder.has('broken')).toBe(false);
    expect(holder.has('short')).toBe(false);
  });

  it('publishLockedKey sends the message to the supervisor', () => {
    const send = vi.fn();
    const original = process.send;
    process.send = send as typeof process.send;
    try {
      const { message } = loadMessage('owner');
      publishLockedKey(message);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0][0]).toBe(message);
    } finally {
      process.send = original;
    }
  });

  describe(LockedKeyRelay.name, () => {
    let relay: LockedKeyRelay;

    beforeEach(() => {
      relay = new LockedKeyRelay();
    });

    afterEach(() => relay.clear());

    it('replays the keys currently loaded, with their pins and grants', () => {
      const a = loadMessage('a', '2099-01-01T00:00:00.000Z', ['viewer']);
      const b = loadMessage('b');
      relay.record(a.message);
      relay.record(b.message);
      relay.record({ type: 'locked-key', action: 'pin', userId: 'b' });
      relay.record({ type: 'locked-key', action: 'drop', userId: 'b' });

      const replay = relay.replay();
      expect(replay).toEqual([a.message, b.message, { type: 'locked-key', action: 'pin', userId: 'b' }]);

      const worker = new LockedKeyHolder();
      const workerChannel = new EventEmitter();
      attachLockedKeyIpc(worker, workerChannel);
      for (const message of replay) workerChannel.emit('message', message);
      expect(worker.canRead('viewer', 'a')).toBe(true);
      expect(worker.expiresAt('a')).toEqual(new Date('2099-01-01T00:00:00.000Z'));
      expect(worker.list().find(({ userId }) => userId === 'b')?.pinned).toBe(true);
      worker.clear();
    });

    it('forgets dropped and expired keys', () => {
      vi.useFakeTimers({ now: new Date('2026-10-31T00:00:00Z') });
      try {
        relay.record(loadMessage('a').message);
        relay.record(loadMessage('b', '2026-10-31T00:05:00.000Z').message);
        relay.record({ type: 'locked-key', action: 'drop', userId: 'a' });
        vi.setSystemTime(new Date('2026-10-31T00:06:00Z'));

        expect(relay.replay()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses to relay a load that has already expired', () => {
      const warn = vi.spyOn(LoggingRepository.prototype, 'warn').mockImplementation(() => {});
      expect(relay.record(loadMessage('a', '2000-01-01T00:00:00.000Z').message)).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      expect(relay.replay()).toEqual([]);
    });

    it('a load with fewer grants revokes the others, in the relay and in a worker', () => {
      const { message } = loadMessage('owner', null, ['a', 'b']);
      const worker = new LockedKeyHolder();
      const workerChannel = new EventEmitter();
      attachLockedKeyIpc(worker, workerChannel);
      const revoke = { ...message, grants: ['b'] };
      for (const sent of [message, revoke]) {
        relay.record(sent);
        workerChannel.emit('message', sent);
      }

      expect(worker.canRead('a', 'owner')).toBe(false);
      expect(worker.canRead('b', 'owner')).toBe(true);
      expect(relay.replay()).toEqual([revoke]);
      worker.clear();
    });

    it('clear returns the messages that empty a worker, pins included', () => {
      relay.record(loadMessage('a').message);
      relay.record({ type: 'locked-key', action: 'pin', userId: 'a' });

      expect(relay.clear()).toEqual([
        { type: 'locked-key', action: 'unpin', userId: 'a' },
        { type: 'locked-key', action: 'drop', userId: 'a' },
      ]);
      expect(relay.replay()).toEqual([]);
    });
  });
});
