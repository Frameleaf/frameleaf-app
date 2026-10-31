import { type LockedKeyFile, unwrapKey } from '@frameleaf/locked-crypto';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { JobName } from 'src/enum.js';
import { LockedEncryptionService, LockedKeyUnavailableException } from 'src/services/locked-encryption.service.js';
import { lockedKeys } from 'src/utils/locked-key-holder.js';
import { publishLockedKey } from 'src/utils/locked-key-ipc.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { ServiceMocks, getMocks, newLockedEncryptionService } from 'test/utils.js';

vi.mock('src/utils/locked-key-ipc.js', () => ({ publishLockedKey: vi.fn() }));

const RECOVERY_KEY = /^FLRK(-[A-Z2-7]{4}){8}$/;
const PIN = '123456';
const PASSPHRASE = 'correct horse battery staple';
const HOUR = 60 * 60 * 1000;

type Row = { userId: string; mode: 'pin' | 'advanced'; status: 'encrypting' | 'on' | 'decrypting' } & Record<
  string,
  unknown
>;

describe(LockedEncryptionService.name, () => {
  let sut: LockedEncryptionService;
  let mocks: ServiceMocks;
  let auth: AuthDto;
  let userId: string;
  let files: Map<string, LockedKeyFile>;
  let rows: Map<string, Row>;

  const fileOf = () => files.get(userId)!;
  const kinds = () => fileOf().wraps.map(({ kind }) => kind);

  beforeEach(() => {
    mocks = getMocks();
    sut = newLockedEncryptionService(mocks);
    auth = AuthFactory.from({ name: 'Taylor' }).session().build();
    userId = auth.user.id;
    files = new Map();
    rows = new Map();

    mocks.lockedKey.read.mockImplementation((id) => Promise.resolve(files.get(id) ?? null));
    mocks.lockedKey.exists.mockImplementation((id) => Promise.resolve(files.has(id)));
    mocks.lockedKey.write.mockImplementation((file) => {
      files.set(file.userId, structuredClone(file));
      return Promise.resolve();
    });
    mocks.lockedKey.delete.mockImplementation((id) => {
      files.delete(id);
      return Promise.resolve();
    });
    mocks.lockedKey.list.mockImplementation(() => Promise.resolve(files.values().toArray()));
    mocks.lockedEncryption.get.mockImplementation((id) => Promise.resolve(rows.get(id) as never));
    mocks.lockedEncryption.create.mockImplementation((values) => {
      const row = { askAgainHours: 72, enabledAt: new Date(), ...values } as Row;
      if (rows.has(row.userId)) {
        return Promise.reject(new Error('duplicate key value violates unique constraint "locked_encryption_pkey"'));
      }
      rows.set(row.userId, row);
      return Promise.resolve(row as never);
    });
    mocks.lockedEncryption.update.mockImplementation((id, values) => {
      const row = { ...rows.get(id)!, ...values } as Row;
      rows.set(id, row);
      return Promise.resolve(row as never);
    });
    mocks.lockedEncryption.delete.mockImplementation((id) => {
      rows.delete(id);
      return Promise.resolve();
    });
    mocks.lockedEncryption.getAllUserIds.mockImplementation(() => Promise.resolve(rows.keys().toArray()));
    mocks.lockedKey.userIds.mockImplementation(() => Promise.resolve(files.keys().toArray()));
    mocks.lockedEncryption.getLockedAssets.mockResolvedValue([]);
    mocks.user.getForPinCode.mockImplementation(() =>
      Promise.resolve({ pinCode: `${PIN} (hashed)`, password: 'password (hashed)' }),
    );
    mocks.user.get.mockResolvedValue({ name: 'Taylor' } as never);
    mocks.user.setPinCodeAndLockSessions.mockResolvedValue(true);
    mocks.crypto.compareBcrypt.mockImplementation((input, hash) =>
      Promise.resolve(`${String(input)} (hashed)` === hash),
    );
    mocks.session.getPinUnlockedUntil.mockResolvedValue(new Date(Date.now() + HOUR));
    mocks.session.lockAll.mockResolvedValue();
    vi.mocked(publishLockedKey).mockClear();
  });

  afterEach(() => {
    lockedKeys.clear();
    vi.useRealTimers();
  });

  const enablePin = () => sut.enable(auth, { mode: 'pin', pinCode: PIN });
  const enableAdvanced = () => sut.enable(auth, { mode: 'advanced', pinCode: PIN, passphrase: PASSPHRASE });

  describe('enable', () => {
    it('enable(pin) writes a key file with pin+recovery wraps, inserts status encrypting, loads the key, queues LockedSweep and returns an FLRK recovery key', async () => {
      const { recoveryKey } = await enablePin();

      expect(recoveryKey).toMatch(RECOVERY_KEY);
      expect(kinds().toSorted()).toEqual(['pin', 'recovery']);
      expect(fileOf()).toMatchObject({ userId, mode: 'pin', encrypting: true, label: 'Taylor' });
      expect(rows.get(userId)).toMatchObject({ mode: 'pin', status: 'encrypting' });
      expect(lockedKeys.has(userId)).toBe(true);
      expect(publishLockedKey).toHaveBeenCalledWith(expect.objectContaining({ action: 'load', userId }));
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LockedSweep, data: { userId } });
      // both wraps open the same key
      const viaPin = await unwrapKey(fileOf(), 'pin', PIN);
      const viaRecovery = await unwrapKey(fileOf(), 'recovery', recoveryKey);
      expect(viaPin.equals(viaRecovery)).toBe(true);
    });

    it('enable(pin) from a session that is not PIN-unlocked leaves the key closed (sealing needs only the public key)', async () => {
      mocks.session.getPinUnlockedUntil.mockResolvedValue(null);
      await enablePin();
      expect(lockedKeys.has(userId)).toBe(false);
      expect(publishLockedKey).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'load' }));
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LockedSweep, data: { userId } });
    });

    it('enable(advanced) writes passphrase+recovery wraps and no pin wrap', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-31T12:00:00.000Z'));
      await enableAdvanced();

      expect(kinds().toSorted()).toEqual(['passphrase', 'recovery']);
      expect(fileOf().mode).toBe('advanced');
      expect(lockedKeys.expiresAt(userId)).toEqual(new Date('2026-11-03T12:00:00.000Z'));
    });

    it('enable rejects a passphrase shorter than 12 characters (400)', async () => {
      await expect(sut.enable(auth, { mode: 'advanced', pinCode: PIN, passphrase: 'too short' })).rejects.toThrow(
        BadRequestException,
      );
      expect(files.size).toBe(0);
    });

    it('enable rejects a wrong PIN (401) and loads nothing', async () => {
      await expect(sut.enable(auth, { mode: 'pin', pinCode: '000000' })).rejects.toThrow(UnauthorizedException);
      expect(files.size).toBe(0);
      expect(rows.size).toBe(0);
      expect(lockedKeys.has(userId)).toBe(false);
      expect(publishLockedKey).not.toHaveBeenCalled();
    });

    it('never overwrites a key file that exists but cannot be read', async () => {
      mocks.lockedKey.exists.mockResolvedValue(true);

      await expect(enablePin()).rejects.toThrow(ConflictException);
      expect(mocks.lockedKey.write).not.toHaveBeenCalled();
      expect(mocks.lockedEncryption.create).not.toHaveBeenCalled();
    });

    it('refuses when it is already on', async () => {
      await enablePin();
      await expect(enablePin()).rejects.toThrow(ConflictException);
    });

    it('keeps an existing PIN-only key pair, which partners may already use', async () => {
      const undo = await sut.onPinSet(userId, PIN);
      expect(undo).toBeTypeOf('function');
      const before = fileOf().publicKey;

      await enablePin();

      expect(fileOf().publicKey).toBe(before);
      expect(fileOf().encrypting).toBe(true);
    });

    it('writes no key file when the row cannot be stored', async () => {
      mocks.lockedEncryption.create.mockRejectedValue(new Error('db down'));
      await expect(enablePin()).rejects.toThrow('db down');
      expect(files.size).toBe(0);
      expect(lockedKeys.has(userId)).toBe(false);
    });
  });

  describe('one key-file change at a time (fix round 1)', () => {
    it('two enables at once leave exactly one key file, matching the row, and the second gets 409', async () => {
      const results = await Promise.allSettled([enablePin(), enablePin()]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
      expect(mocks.lockedKey.write).toHaveBeenCalledTimes(1);
      expect(mocks.lockedKey.delete).not.toHaveBeenCalled();
      expect(rows.get(userId)).toMatchObject({ mode: 'pin', status: 'encrypting' });
      expect(fileOf()).toMatchObject({ mode: 'pin', encrypting: true });
      // the recovery key the winner returned opens the file on disk, which is the loaded key
      const { recoveryKey } = (fulfilled[0] as PromiseFulfilledResult<{ recoveryKey: string }>).value;
      await expect(unwrapKey(fileOf(), 'recovery', recoveryKey)).resolves.toHaveLength(32);
      expect(lockedKeys.list()[0].publicKey.toString('base64')).toBe(fileOf().publicKey);
    }, 30_000);

    it('a second enable whose claim loses the race gets 409 and writes nothing', async () => {
      // the row appears between the "already on" check and the insert (another server process)
      mocks.lockedEncryption.get.mockResolvedValueOnce(undefined);
      rows.set(userId, { userId, mode: 'advanced', status: 'encrypting' });
      await expect(enablePin()).rejects.toThrow(ConflictException);
      expect(mocks.lockedKey.write).not.toHaveBeenCalled();
      expect(rows.get(userId)!.mode).toBe('advanced');
    });

    it('removes only its own claim when the key file cannot be written', async () => {
      mocks.lockedKey.write.mockRejectedValueOnce(new Error('ENOSPC'));
      await expect(enablePin()).rejects.toThrow('ENOSPC');
      expect(rows.size).toBe(0);
      expect(mocks.lockedKey.delete).not.toHaveBeenCalled();
      expect(lockedKeys.has(userId)).toBe(false);
    });

    it('a wrap that fails after the claim leaves no row and no key file, and a retry succeeds', async () => {
      const crypto = await import('@frameleaf/locked-crypto');
      const wrap = vi.spyOn(crypto, 'wrapKey').mockRejectedValueOnce(new Error('scrypt: memory limit exceeded'));

      await expect(enablePin()).rejects.toThrow('scrypt');
      expect(rows.size).toBe(0);
      expect(files.size).toBe(0);
      expect(mocks.lockedKey.write).not.toHaveBeenCalled();
      expect(lockedKeys.has(userId)).toBe(false);

      wrap.mockRestore();
      const { recoveryKey } = await enablePin();
      expect(rows.get(userId)).toMatchObject({ status: 'encrypting' });
      await expect(unwrapKey(fileOf(), 'recovery', recoveryKey)).resolves.toHaveLength(32);
    }, 20_000);

    it('a new recovery key and a passphrase change at once both survive', async () => {
      await enableAdvanced();
      const [{ recoveryKey }] = await Promise.all([
        sut.newRecoveryKey(auth, { secret: PASSPHRASE }),
        sut.update(auth, { currentSecret: PASSPHRASE, newPassphrase: 'a brand new passphrase' }),
      ]);
      await expect(unwrapKey(fileOf(), 'recovery', recoveryKey)).resolves.toHaveLength(32);
      await expect(unwrapKey(fileOf(), 'passphrase', 'a brand new passphrase')).resolves.toHaveLength(32);
    }, 30_000);

    it('two first PIN unlocks at once create one key pair', async () => {
      await Promise.all([sut.onPinVerified(userId, PIN), sut.onPinVerified(userId, PIN)]);
      expect(mocks.lockedKey.write).toHaveBeenCalledTimes(1);
      expect(lockedKeys.list()[0].publicKey.toString('base64')).toBe(fileOf().publicKey);
    }, 20_000);

    it('an undo never touches a key file another change wrote', async () => {
      const undo = await sut.withKeyFileLock(userId, () => sut.onPinSet(userId, PIN));
      const ours = structuredClone(fileOf());
      files.set(userId, { ...ours, publicKey: Buffer.alloc(32, 9).toString('base64') });
      const theirs = structuredClone(fileOf());

      await undo();

      expect(fileOf()).toEqual(theirs);
      expect(mocks.lockedKey.delete).not.toHaveBeenCalled();
    });
  });

  describe('key-file changes across processes (Task 5, Ruling 12)', () => {
    it('every key-file change also holds the per-user database lock', async () => {
      let inside = false;
      mocks.database.withLockedKeyFileLock.mockImplementation(async (id, fn) => {
        expect(id).toBe(userId);
        inside = true;
        try {
          return await fn();
        } finally {
          inside = false;
        }
      });
      mocks.lockedKey.write.mockImplementation((file) => {
        expect(inside).toBe(true);
        files.set(file.userId, structuredClone(file));
        return Promise.resolve();
      });

      await enablePin();

      expect(mocks.database.withLockedKeyFileLock).toHaveBeenCalledTimes(1);
      expect(mocks.lockedKey.write).toHaveBeenCalled();
    });

    it('the worker finishing turn-off releases the pinned key in the API process once the row is gone', async () => {
      await enablePin();
      await sut.disable(auth, { pinCode: PIN });
      expect(lockedKeys.has(userId)).toBe(true);
      vi.mocked(publishLockedKey).mockClear();

      // still turning off: ignored
      await sut.onLockedEncryptionOff({ userId });
      expect(lockedKeys.has(userId)).toBe(true);

      rows.delete(userId);
      await sut.onLockedEncryptionOff({ userId });

      expect(lockedKeys.has(userId)).toBe(false);
      expect(lockedKeys.pinnedUsers()).not.toContain(userId);
      expect(publishLockedKey).toHaveBeenCalledWith({ type: 'locked-key', action: 'unpin', userId });
      expect(publishLockedKey).toHaveBeenCalledWith({ type: 'locked-key', action: 'drop', userId });
    });
  });

  describe('queue failures after the change is stored (fix round 1)', () => {
    it('enable returns the recovery key when queueing the sweep fails, and logs it', async () => {
      mocks.job.queue.mockRejectedValue(new Error('redis down'));
      const { recoveryKey } = await enablePin();
      expect(recoveryKey).toMatch(RECOVERY_KEY);
      expect(rows.get(userId)!.status).toBe('encrypting');
      await expect(unwrapKey(fileOf(), 'recovery', recoveryKey)).resolves.toHaveLength(32);
      expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('Locked sweep'));
    });

    it('a mode switch is saved when queueing the re-wrap fails, and PUT {mode} queues it again', async () => {
      await enablePin();
      mocks.lockedEncryption.getLockedAssets.mockResolvedValue([
        { id: 'asset-1', originalPath: '/a', encryptable: true, pendingUnlockAt: null },
      ]);
      mocks.job.queueAll.mockRejectedValueOnce(new Error('redis down'));

      await expect(
        sut.update(auth, { mode: 'advanced', currentSecret: PIN, newPassphrase: PASSPHRASE }),
      ).resolves.toBeUndefined();
      expect(fileOf().mode).toBe('advanced');
      expect(rows.get(userId)!.mode).toBe('advanced');
      expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('re-wrap'));

      mocks.job.queueAll.mockClear();
      await sut.update(auth, { mode: 'advanced' });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedRewrap, data: { id: 'asset-1' } }]);
    }, 30_000);

    it('puts the key file back when the new mode cannot be stored', async () => {
      await enablePin();
      const before = structuredClone(fileOf());
      mocks.lockedEncryption.update.mockRejectedValueOnce(new Error('db down'));
      await expect(
        sut.update(auth, { mode: 'advanced', currentSecret: PIN, newPassphrase: PASSPHRASE }),
      ).rejects.toThrow('db down');
      expect(fileOf()).toEqual(before);
    }, 30_000);
  });

  describe('unlock', () => {
    it('unlock with a wrong passphrase is limited after 5 tries', async () => {
      await enableAdvanced();
      lockedKeys.clear();
      for (let attempt = 0; attempt < 5; attempt++) {
        await expect(sut.unlock(auth, { passphrase: 'not the passphrase' })).rejects.toThrow('Wrong passphrase');
      }
      // even the right one is refused now, and nothing is loaded
      await expect(sut.unlock(auth, { passphrase: PASSPHRASE })).rejects.toThrow('Too many failed');
      expect(lockedKeys.has(userId)).toBe(false);
    }, 30_000);

    it('unlock loads the key with expiresAt = now + askAgainHours, and null when askAgainHours is null', async () => {
      await enableAdvanced();
      lockedKeys.clear();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-31T12:00:00.000Z'));
      rows.set(userId, { ...rows.get(userId)!, askAgainHours: 8 });

      await sut.unlock(auth, { passphrase: PASSPHRASE });
      expect(lockedKeys.expiresAt(userId)).toEqual(new Date('2026-10-31T20:00:00.000Z'));

      rows.set(userId, { ...rows.get(userId)!, askAgainHours: null });
      await sut.unlock(auth, { passphrase: PASSPHRASE });
      expect(lockedKeys.has(userId)).toBe(true);
      expect(lockedKeys.expiresAt(userId)).toBeNull();
    }, 20_000);

    it('refuses in PIN mode', async () => {
      await enablePin();
      await expect(sut.unlock(auth, { passphrase: PASSPHRASE })).rejects.toThrow(BadRequestException);
    });
  });

  describe('lock', () => {
    it('lock drops the key and is refused while status is decrypting', async () => {
      await enableAdvanced();
      await sut.lock(auth);
      expect(lockedKeys.has(userId)).toBe(false);
      expect(publishLockedKey).toHaveBeenCalledWith({ type: 'locked-key', action: 'drop', userId });

      rows.set(userId, { ...rows.get(userId)!, status: 'decrypting' });
      await expect(sut.lock(auth)).rejects.toThrow(ConflictException);
    });

    it('also ends the PIN unlocks in PIN mode', async () => {
      await enablePin();
      await sut.lock(auth);
      expect(lockedKeys.has(userId)).toBe(false);
      expect(mocks.session.lockAll).toHaveBeenCalledWith(userId);
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_session_lock', userId);
    });
  });

  describe('update', () => {
    it("update(mode:'advanced') replaces the pin wrap with a passphrase wrap and queues LockedRewrap for every asset in the set", async () => {
      await enablePin();
      mocks.lockedEncryption.getLockedAssets.mockResolvedValue([
        { id: 'asset-1', originalPath: '/a', encryptable: true, pendingUnlockAt: null },
        { id: 'asset-2', originalPath: '/b', encryptable: true, pendingUnlockAt: null },
        { id: 'external', originalPath: '/c', encryptable: false, pendingUnlockAt: null },
      ]);

      await sut.update(auth, { mode: 'advanced', currentSecret: PIN, newPassphrase: PASSPHRASE });

      expect(kinds().toSorted()).toEqual(['passphrase', 'recovery']);
      expect(fileOf().mode).toBe('advanced');
      expect(rows.get(userId)!.mode).toBe('advanced');
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.LockedRewrap, data: { id: 'asset-1' } },
        { name: JobName.LockedRewrap, data: { id: 'asset-2' } },
      ]);
      await expect(unwrapKey(fileOf(), 'passphrase', PASSPHRASE)).resolves.toHaveLength(32);
    }, 20_000);

    it('needs the current secret to switch', async () => {
      await enablePin();
      await expect(sut.update(auth, { mode: 'advanced', newPassphrase: PASSPHRASE })).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        sut.update(auth, { mode: 'advanced', currentSecret: '000000', newPassphrase: PASSPHRASE }),
      ).rejects.toThrow(UnauthorizedException);
      expect(fileOf().mode).toBe('pin');
    }, 20_000);

    it('changes only the ask-again time without a secret', async () => {
      await enableAdvanced();
      await sut.update(auth, { askAgainHours: 24 });
      expect(rows.get(userId)!.askAgainHours).toBe(24);
    });
  });

  describe('recover', () => {
    it('recover with a good recovery key sets a new PIN through setPinCodeAndLockSessions and re-wraps', async () => {
      const { recoveryKey } = await enablePin();

      await sut.recover(auth, { recoveryKey, newPinCode: '654321' });

      expect(mocks.user.setPinCodeAndLockSessions).toHaveBeenCalledWith(
        userId,
        { pinCode: `${PIN} (hashed)`, password: 'password (hashed)' },
        '654321 (hashed)',
      );
      await expect(unwrapKey(fileOf(), 'pin', '654321')).resolves.toHaveLength(32);
      expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_session_lock', userId);
    }, 20_000);

    it('puts the key file back when the new PIN is not stored', async () => {
      const { recoveryKey } = await enablePin();
      const before = structuredClone(fileOf());
      mocks.user.setPinCodeAndLockSessions.mockResolvedValue(false);

      await expect(sut.recover(auth, { recoveryKey, newPinCode: '654321' })).rejects.toThrow(UnauthorizedException);
      expect(fileOf()).toEqual(before);
    }, 20_000);

    it('refuses a wrong recovery key (401)', async () => {
      await enablePin();
      await expect(
        sut.recover(auth, { recoveryKey: 'FLRK-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', newPinCode: '654321' }),
      ).rejects.toThrow(UnauthorizedException);
      expect(mocks.user.setPinCodeAndLockSessions).not.toHaveBeenCalled();
    });
  });

  describe('disable', () => {
    it('disable sets status decrypting, pins the key and queues LockedUnseal for every sealed asset', async () => {
      await enableAdvanced();
      lockedKeys.clear();
      mocks.lockedEncryption.getLockedAssets.mockResolvedValue([
        { id: 'asset-1', originalPath: '/a', encryptable: true, pendingUnlockAt: null },
        { id: 'external', originalPath: '/c', encryptable: false, pendingUnlockAt: null },
      ]);

      await sut.disable(auth, { passphrase: PASSPHRASE });

      expect(rows.get(userId)!.status).toBe('decrypting');
      expect(lockedKeys.has(userId)).toBe(true);
      expect(lockedKeys.pinnedUsers()).toContain(userId);
      expect(publishLockedKey).toHaveBeenCalledWith({ type: 'locked-key', action: 'pin', userId });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedUnseal, data: { id: 'asset-1' } }]);
      // pinned: Lock now and expiry keep it
      lockedKeys.drop(userId);
      expect(lockedKeys.has(userId)).toBe(true);
    }, 20_000);

    it('refuses a wrong PIN and changes nothing', async () => {
      await enablePin();
      await expect(sut.disable(auth, { pinCode: '000000' })).rejects.toThrow(UnauthorizedException);
      expect(rows.get(userId)!.status).toBe('encrypting');
    });
  });

  describe('getStatus', () => {
    it('the recovery key never appears in the status response', async () => {
      const { recoveryKey } = await enablePin();
      const media = await fs.mkdtemp(join(tmpdir(), 'locked-status-'));
      try {
        await fs.writeFile(join(media, 'sealed'), 'FLLK....');
        await fs.writeFile(join(media, 'plain'), 'JPEG....');
        mocks.lockedEncryption.getLockedAssets.mockResolvedValue([
          { id: 'a', originalPath: join(media, 'sealed'), encryptable: true, pendingUnlockAt: null },
          { id: 'b', originalPath: join(media, 'plain'), encryptable: true, pendingUnlockAt: null },
          { id: 'c', originalPath: join(media, 'missing'), encryptable: true, pendingUnlockAt: null },
          { id: 'd', originalPath: '/external', encryptable: false, pendingUnlockAt: null },
        ]);

        const status = await sut.getStatus(auth);

        expect(status).toMatchObject({
          enabled: true,
          mode: 'pin',
          status: 'encrypting',
          keyLoaded: true,
          progress: { done: 1, total: 3 },
          counts: { encrypted: 1, notEncryptable: 1 },
        });
        expect(JSON.stringify(status)).not.toContain(recoveryKey);
        expect(JSON.stringify(status)).not.toContain(recoveryKey.replaceAll('-', ''));
      } finally {
        await fs.rm(media, { recursive: true, force: true });
      }
    });

    it('reports off with the default ask-again time', async () => {
      await expect(sut.getStatus(auth)).resolves.toMatchObject({
        enabled: false,
        mode: null,
        status: null,
        keyLoaded: false,
        askAgainHours: 72,
        progress: null,
      });
    });
  });

  describe('PIN hooks', () => {
    it('onPinSet creates a PIN-only key pair when there is no key file (spec §4.1), with no row', async () => {
      await sut.onPinSet(userId, PIN);
      expect(fileOf()).toMatchObject({ mode: 'pin', encrypting: false });
      expect(kinds()).toEqual(['pin']);
      expect(rows.size).toBe(0);
    });

    it('onPinSet re-wraps the pin wrap with the new PIN in PIN mode, keeping the key pair', async () => {
      await enablePin();
      const before = fileOf().publicKey;
      lockedKeys.clear();

      const undo = await sut.onPinSet(userId, '654321', PIN);

      expect(fileOf().publicKey).toBe(before);
      await expect(unwrapKey(fileOf(), 'pin', '654321')).resolves.toHaveLength(32);
      await undo();
      await expect(unwrapKey(fileOf(), 'pin', PIN)).resolves.toHaveLength(32);
    }, 20_000);

    it('onPinSet refuses while encryption is on and neither the old PIN nor a loaded key opens the file', async () => {
      await enablePin();
      lockedKeys.clear();
      await expect(sut.onPinSet(userId, '654321')).rejects.toThrow(ConflictException);
      await expect(unwrapKey(fileOf(), 'pin', PIN)).resolves.toHaveLength(32);
    });

    it('onPinSet changes nothing in Advanced Security', async () => {
      await enableAdvanced();
      mocks.lockedKey.write.mockClear();
      await sut.onPinSet(userId, '654321');
      expect(mocks.lockedKey.write).not.toHaveBeenCalled();
    });

    it('onPinSet never replaces a key file that exists but cannot be read', async () => {
      mocks.lockedKey.read.mockRejectedValue(new SyntaxError('Unexpected token'));
      mocks.lockedKey.exists.mockResolvedValue(true);
      await expect(sut.onPinSet(userId, PIN)).rejects.toThrow(ConflictException);
      expect(mocks.lockedKey.write).not.toHaveBeenCalled();
    });

    it('onPinVerified loads a PIN-mode key until the last PIN unlock ends', async () => {
      await enablePin();
      lockedKeys.clear();
      const until = new Date(Date.now() + HOUR);
      mocks.session.getPinUnlockedUntil.mockResolvedValue(until);

      await sut.onPinVerified(userId, PIN);

      expect(lockedKeys.expiresAt(userId)).toEqual(until);
    });

    it('onPinVerified creates and loads a key pair for a PIN with no key file', async () => {
      const until = new Date(Date.now() + HOUR);
      mocks.session.getPinUnlockedUntil.mockResolvedValue(until);
      await sut.onPinVerified(userId, PIN);
      expect(fileOf()).toMatchObject({ mode: 'pin', encrypting: false });
      expect(lockedKeys.expiresAt(userId)).toEqual(until);
    });

    it('onPinVerified loads nothing in Advanced Security', async () => {
      await enableAdvanced();
      lockedKeys.clear();
      mocks.session.getPinUnlockedUntil.mockResolvedValue(new Date(Date.now() + HOUR));
      await sut.onPinVerified(userId, PIN);
      expect(lockedKeys.has(userId)).toBe(false);
    });

    it('onPinExtended extends a loaded PIN-mode key, and onSessionsLocked drops it once no unlock remains', async () => {
      await enablePin();
      const until = new Date(Date.now() + 2 * HOUR);

      await sut.onPinExtended(userId, until);
      expect(lockedKeys.expiresAt(userId)).toEqual(until);
      expect(publishLockedKey).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'load', expiresAt: until.toISOString() }),
      );

      mocks.session.getPinUnlockedUntil.mockResolvedValue(null);
      await sut.onSessionsLocked(userId);
      expect(lockedKeys.has(userId)).toBe(false);
      expect(publishLockedKey).toHaveBeenLastCalledWith({ type: 'locked-key', action: 'drop', userId });
    });

    it('onSessionsLocked never throws and drops the key when the key file cannot be read', async () => {
      await enablePin();
      mocks.lockedKey.read.mockRejectedValue(new SyntaxError('Unexpected token'));
      mocks.lockedKey.exists.mockResolvedValue(true);

      await expect(sut.onSessionsLocked(userId)).resolves.toBeUndefined();
      expect(lockedKeys.has(userId)).toBe(false);
      expect(publishLockedKey).toHaveBeenLastCalledWith({ type: 'locked-key', action: 'drop', userId });
    });

    it('onSessionsLocked drops the key when the sessions cannot be read', async () => {
      await enablePin();
      mocks.session.getPinUnlockedUntil.mockRejectedValue(new Error('db down'));
      await expect(sut.onSessionsLocked(userId)).resolves.toBeUndefined();
      expect(lockedKeys.has(userId)).toBe(false);
    });

    it('the boot list includes unreadable key files and rows without one, not readable Advanced files', async () => {
      await enableAdvanced();
      const unreadable = '11111111-1111-4111-8111-111111111111';
      const rowOnly = '22222222-2222-4222-8222-222222222222';
      const pinOnly = '33333333-3333-4333-8333-333333333333';
      mocks.lockedKey.userIds.mockResolvedValue([userId, unreadable, pinOnly]);
      mocks.lockedKey.list.mockResolvedValue([fileOf(), { ...fileOf(), userId: pinOnly, mode: 'pin' }]);
      rows.set(rowOnly, { userId: rowOnly, mode: 'pin', status: 'on' });

      expect((await sut.usersWithKeyFiles()).toSorted()).toEqual([unreadable, rowOnly, pinOnly].toSorted());
    });

    it('onSessionsLocked leaves an Advanced key loaded', async () => {
      await enableAdvanced();
      await sut.onSessionsLocked(userId);
      expect(lockedKeys.has(userId)).toBe(true);
    });

    it('assertPinResettable refuses with "use your recovery key" while encryption is on', async () => {
      await expect(sut.assertPinResettable(userId)).resolves.toBeUndefined();
      await enablePin();
      await expect(sut.assertPinResettable(userId)).rejects.toThrow(/recovery key/);
    });
  });

  it('LockedKeyUnavailableException is a 423 with the code and mode the web app reads', () => {
    const error = new LockedKeyUnavailableException('advanced');
    expect(error.getStatus()).toBe(423);
    expect(error.getResponse()).toEqual({
      code: 'locked_key_unavailable',
      mode: 'advanced',
      message: 'Type your passphrase to open Locked',
    });
    expect(new LockedKeyUnavailableException('pin').getResponse()).toMatchObject({ mode: 'pin' });
  });

  it('never logs a secret', async () => {
    const { recoveryKey } = await enableAdvanced();
    await sut.unlock(auth, { passphrase: PASSPHRASE });
    await expect(sut.unlock(auth, { passphrase: 'not the passphrase' })).rejects.toThrow();
    const logged = JSON.stringify(
      Object.values(mocks.logger).map((fn) => (fn as ReturnType<typeof vi.fn>).mock?.calls),
    );
    for (const secret of [recoveryKey, PASSPHRASE, PIN]) {
      expect(logged).not.toContain(secret);
    }
  }, 20_000);
});
