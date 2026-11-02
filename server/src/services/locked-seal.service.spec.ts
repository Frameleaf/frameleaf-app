import {
  type LockedKeyFile,
  decryptFile,
  encryptFile,
  generateKeyPair,
  isLockedFile,
  keyId,
  readHeader,
} from '@frameleaf/locked-crypto';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { QueueExecution } from 'src/queue/types.js';
import { JobName, JobStatus } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { LOCKED_PATH_BUSY, type LockedFileRef, type LockedSealState } from 'src/repositories/locked-file.repository.js';
import { FINISH_CHECK_DELAY_MS, LATE_WAKE_DELAYS_MS, LockedSealService } from 'src/services/locked-seal.service.js';
import { lockedKeys } from 'src/utils/locked-key-holder.js';
import { publishLockedKey } from 'src/utils/locked-key-ipc.js';
import { LockedKeyUnavailableError, deferForLockedKey } from 'src/utils/locked-read.js';
import { ServiceMocks, getMocks, newLockedEncryptionService, newLockedSealService } from 'test/utils.js';

vi.mock('@frameleaf/locked-crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@frameleaf/locked-crypto')>();
  return { ...actual, encryptFile: vi.fn(actual.encryptFile) };
});
vi.mock('src/utils/locked-key-ipc.js', () => ({ publishLockedKey: vi.fn() }));

const OWNER = '00000000-0000-4000-8000-000000000001';
const PARTNER = '00000000-0000-4000-8000-000000000002';
const ASSET = '00000000-0000-4000-8000-0000000000a1';

/** The transaction the path lock runs in, as `withFileLock` hands it to the final step. */
const LOCK_TRX = { lockTransaction: true } as never;

type Row = { userId: string; mode: 'pin' | 'advanced'; status: 'encrypting' | 'on' | 'decrypting' };

describe(LockedSealService.name, () => {
  let sut: LockedSealService;
  let mocks: ServiceMocks;
  let dir: string;
  let owner: ReturnType<typeof generateKeyPair>;
  let partner: ReturnType<typeof generateKeyPair>;
  let state: LockedSealState;
  let files: LockedFileRef[];
  let keyFile: LockedKeyFile;
  let row: Row | undefined;
  let plain: Map<string, Buffer>;
  let held: Set<string>;

  const write = async (name: string, kind: LockedFileRef['kind'] = 'thumbnail', table = 'asset_file') => {
    const path = join(dir, name);
    const bytes = randomBytes(70_000 + plain.size);
    await fs.writeFile(path, bytes);
    plain.set(path, bytes);
    files.push({ path, kind, table });
    return path;
  };
  const decrypted = async (path: string, privateKey = owner.privateKey) => {
    const out = `${path}.out`;
    await decryptFile(path, out, privateKey);
    const bytes = await fs.readFile(out);
    await fs.rm(out);
    return bytes;
  };
  const temporaries = async () => (await fs.readdir(dir)).filter((name) => name.endsWith('.fllk.tmp'));
  const loadOwnerKey = () => lockedKeys.load(OWNER, owner.publicKey, Buffer.from(owner.privateKey), null);

  beforeEach(async () => {
    mocks = getMocks();
    sut = newLockedSealService(mocks);
    dir = await fs.mkdtemp(join(tmpdir(), 'locked-seal-'));
    owner = generateKeyPair();
    partner = generateKeyPair();
    plain = new Map();
    files = [];
    state = {
      id: ASSET,
      ownerId: OWNER,
      originalFileName: 'IMG_0001.jpg',
      encryptable: true,
      partnerCopy: false,
      locked: true,
      pendingUnlockAt: null,
      status: 'encrypting',
      mode: 'pin',
    };
    row = { userId: OWNER, mode: 'pin', status: 'encrypting' };
    keyFile = {
      format: 'frameleaf-locked-key/1',
      userId: OWNER,
      label: 'Taylor',
      publicKey: owner.publicKey.toString('base64'),
      mode: 'pin',
      encrypting: true,
      wraps: [
        { kind: 'pin', kdf: 'scrypt', salt: 'c2FsdA==', nonce: 'bm9uY2U=', ciphertext: 'Y2lwaGVy' },
        { kind: 'recovery', kdf: 'hkdf-sha256', salt: 'c2FsdA==', nonce: 'bm9uY2U=', ciphertext: 'Y2lwaGVy' },
      ] as LockedKeyFile['wraps'],
      createdAt: '2026-10-31T00:00:00.000Z',
      updatedAt: '2026-10-31T00:00:00.000Z',
    };

    mocks.lockedFile.getSealState.mockImplementation(() => Promise.resolve({ ...state }));
    mocks.lockedFile.filesOf.mockImplementation(() => Promise.resolve(files.map((file) => ({ ...file }))));
    mocks.lockedFile.partnerRecipients.mockResolvedValue([]);
    mocks.lockedFile.unshareOriginal.mockResolvedValue(false);
    mocks.lockedFile.unshareFile.mockResolvedValue(false);
    mocks.lockedFile.sealedReaders.mockResolvedValue([]);
    mocks.lockedFile.plainReaders.mockResolvedValue([]);
    mocks.lockedFile.finishPendingUnlock.mockResolvedValue(true);
    // the path lock, as Postgres gives it: taken without waiting, busy while another job holds it
    held = new Set();
    mocks.lockedFile.withFileLock.mockImplementation(async (path, _ownerId, work) => {
      if (held.has(path)) {
        return LOCKED_PATH_BUSY;
      }
      held.add(path);
      try {
        return await work((step) => step(LOCK_TRX));
      } finally {
        held.delete(path);
      }
    });
    mocks.lockedKey.read.mockImplementation(() => Promise.resolve(structuredClone(keyFile)));
    mocks.lockedKey.exists.mockResolvedValue(true);
    mocks.lockedKey.write.mockResolvedValue();
    mocks.lockedKey.delete.mockResolvedValue();
    mocks.lockedKey.list.mockResolvedValue([]);
    mocks.cron.create.mockReturnValue();
    mocks.lockedEncryption.get.mockImplementation(() => Promise.resolve(row as never));
    mocks.lockedEncryption.getAllUserIds.mockImplementation(() => Promise.resolve(row ? [OWNER] : []));
    mocks.lockedEncryption.getUnlockedFilePaths.mockResolvedValue([]);
    mocks.lockedEncryption.getLockedAssets.mockImplementation(() =>
      Promise.resolve([
        {
          id: ASSET,
          originalPath: files[0]?.path ?? '',
          encryptable: state.encryptable,
          pendingUnlockAt: state.pendingUnlockAt,
        },
      ]),
    );
    mocks.lockedEncryption.update.mockImplementation((_id, values) => {
      row = { ...row!, ...(values as Partial<Row>) };
      return Promise.resolve(row as never);
    });
    mocks.lockedEncryption.delete.mockImplementation(() => {
      row = undefined;
      return Promise.resolve();
    });
    vi.mocked(publishLockedKey).mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    sut.onShutdown();
    lockedKeys.clear();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('handleSeal', () => {
    it('seal encrypts every path from filesOf and leaves each starting with FLLK', async () => {
      await write('original.jpg', 'original', 'asset');
      await write('thumbnail.webp');
      await write('preview.jpeg', 'preview');

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Success);

      for (const { path } of files) {
        expect((await fs.readFile(path)).subarray(0, 4).toString('latin1')).toBe('FLLK');
        expect((await decrypted(path)).equals(plain.get(path)!)).toBe(true);
      }
      expect(await temporaries()).toEqual([]);
      expect(mocks.lockedFile.unshareOriginal).toHaveBeenCalledWith(ASSET);
      // still turning on: a later sweep turns the status to on
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LockedSweep,
        data: { userId: OWNER, delay: FINISH_CHECK_DELAY_MS },
      });
    });

    it('re-checks the state on the path lock’s own connection, never a second one (N1)', async () => {
      await write('original.jpg', 'original', 'asset');
      await write('thumbnail.webp');

      await sut.handleSeal({ id: ASSET });

      // the first read decides; every read under the lock (one per file) is on the lock's transaction
      const calls = mocks.lockedFile.getSealState.mock.calls;
      expect(calls[0]).toEqual([ASSET]);
      expect(calls.slice(1)).toEqual([
        [ASSET, LOCK_TRX],
        [ASSET, LOCK_TRX],
      ]);
    });

    it('keeps the file mode of each file it replaces', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      await fs.chmod(path, 0o644);

      await sut.handleSeal({ id: ASSET });

      expect((await fs.stat(path)).mode & 0o777).toBe(0o644);
    });

    it('seal skips files already sealed: a second run changes nothing', async () => {
      await write('original.jpg', 'original', 'asset');
      await write('thumbnail.webp');
      await sut.handleSeal({ id: ASSET });
      const before = await Promise.all(files.map(({ path }) => fs.stat(path)));
      vi.mocked(encryptFile).mockClear();

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Success);

      const after = await Promise.all(files.map(({ path }) => fs.stat(path)));
      expect(after.map(({ mtimeMs, ino }) => [mtimeMs, ino])).toEqual(before.map(({ mtimeMs, ino }) => [mtimeMs, ino]));
      expect(encryptFile).not.toHaveBeenCalled();
    });

    it('seal is crash-safe: a failed rename of the second file leaves it plain and readable', async () => {
      const first = await write('original.jpg', 'original', 'asset');
      const second = await write('thumbnail.webp');
      const rename = fs.rename;
      let calls = 0;
      vi.spyOn(fs, 'rename').mockImplementation((from, to) => {
        calls++;
        return calls === 2 ? Promise.reject(new Error('power cut')) : rename(from, to);
      });

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Failed);

      expect(await isLockedFile(first)).toBe(true);
      expect(await isLockedFile(second)).toBe(false);
      expect((await fs.readFile(second)).equals(plain.get(second)!)).toBe(true);
      // a crash that left a temporary file behind: the next start removes it
      await fs.writeFile(`${second}.fllk.tmp`, 'half written');
      await fs.writeFile(`${second}.0b6e5c7e-3f0b-4c8e-9a51-2f1f3c4d5e6f.fllk.tmp`, 'half written');
      const unrelated = join(dir, 'holiday.fllk.tmp');
      await fs.writeFile(unrelated, 'not ours');
      await sut.removeStaleTemp();
      await fs.rm(unrelated);
      expect(await temporaries()).toEqual([]);
      expect((await fs.readFile(second)).equals(plain.get(second)!)).toBe(true);
    });

    it('seal with ENOSPC from encryptFile leaves the source untouched, returns Failed, and removes the tmp file', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      vi.mocked(encryptFile).mockImplementationOnce(async (_src, dst) => {
        await fs.writeFile(dst, 'partial');
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      });

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Failed);

      expect((await fs.readFile(path)).equals(plain.get(path)!)).toBe(true);
      expect(await temporaries()).toEqual([]);
    });

    it('seal of a deleted asset returns Skipped', async () => {
      mocks.lockedFile.getSealState.mockResolvedValue(undefined);
      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.lockedFile.filesOf).not.toHaveBeenCalled();
    });

    it('seal when the path has moved re-reads filesOf once, then Skipped', async () => {
      files.push({ path: join(dir, 'gone.jpg'), kind: 'original', table: 'asset' });

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.lockedFile.filesOf).toHaveBeenCalledTimes(2);
    });

    it('seal re-reads filesOf after a move and seals the new path', async () => {
      const moved = join(dir, 'moved.jpg');
      files.push({ path: join(dir, 'gone.jpg'), kind: 'original', table: 'asset' });
      mocks.lockedFile.filesOf.mockResolvedValueOnce(files.map((file) => ({ ...file })));
      files = [];
      await fs.writeFile(moved, randomBytes(10));
      files.push({ path: moved, kind: 'original', table: 'asset' });

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Success);
      expect(await isLockedFile(moved)).toBe(true);
    });

    it('a listed file that may not exist (a lineage record) is no move', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      files.push({
        path: join(dir, 'master.mp4.lineage.json'),
        kind: 'other',
        table: 'video_edit_version',
        optional: true,
      });

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Success);
      expect(await isLockedFile(path)).toBe(true);
      expect(mocks.lockedFile.filesOf).toHaveBeenCalledTimes(1);
    });

    it('seal un-shares an original shared with a non-locked asset of another user; that asset’s file stays plain and byte-identical', async () => {
      const shared = await write('shared.jpg', 'original', 'asset');
      const ownCopy = join(dir, 'own-copy.jpg');
      mocks.lockedFile.unshareOriginal.mockImplementation(async () => {
        await fs.copyFile(shared, ownCopy);
        files[0] = { path: ownCopy, kind: 'original', table: 'asset' };
        return true;
      });

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Success);

      expect((await fs.readFile(shared)).equals(plain.get(shared)!)).toBe(true);
      expect(await isLockedFile(ownCopy)).toBe(true);
      expect((await decrypted(ownCopy)).equals(plain.get(shared)!)).toBe(true);
    });

    it('seal un-shares a generated file another asset reads before sealing it', async () => {
      await write('original.jpg', 'original', 'asset');
      const shared = await write('thumbnail.webp');
      const ownCopy = join(dir, 'thumbnail.own.webp');
      mocks.lockedFile.unshareFile.mockImplementation(async (_id, ref) => {
        if (ref.path !== shared) {
          return false;
        }
        await fs.copyFile(shared, ownCopy);
        files[1] = { path: ownCopy, kind: 'thumbnail', table: 'asset_file' };
        return true;
      });

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Success);

      expect(await isLockedFile(shared)).toBe(false);
      expect(await isLockedFile(ownCopy)).toBe(true);
    });

    it('seal does not un-share for a partner copy: the copy itself is never sealed', async () => {
      await write('original.jpg', 'original', 'asset');
      state.partnerCopy = true;

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.lockedFile.unshareOriginal).not.toHaveBeenCalled();
      expect(await isLockedFile(files[0].path)).toBe(false);
    });

    it('the partner can open the file with their key in pin mode', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      mocks.lockedFile.partnerRecipients.mockResolvedValue([{ userId: PARTNER, publicKey: partner.publicKey }]);

      await sut.handleSeal({ id: ASSET });

      expect((await decrypted(path, partner.privateKey)).equals(plain.get(path)!)).toBe(true);
      expect((await readHeader(path)).keyIds).toEqual([keyId(owner.publicKey), keyId(partner.publicKey)]);
    });

    it('in Advanced Security a file carries only the owner', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      keyFile.mode = 'advanced';
      mocks.lockedFile.partnerRecipients.mockResolvedValue([{ userId: PARTNER, publicKey: partner.publicKey }]);

      await sut.handleSeal({ id: ASSET });

      expect((await readHeader(path)).keyIds).toEqual([keyId(owner.publicKey)]);
    });

    it('seal needs no private key', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      expect(lockedKeys.has(OWNER)).toBe(false);

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Success);
      expect(await isLockedFile(path)).toBe(true);
    });

    it('seal does nothing while encryption is turning off', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      state.status = 'decrypting';

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Skipped);
      expect(await isLockedFile(path)).toBe(false);
    });

    it('seal stops before the rename when turning off starts meanwhile, leaving the source as it was', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      mocks.lockedFile.getSealState
        .mockResolvedValueOnce({ ...state })
        .mockResolvedValue({ ...state, status: 'decrypting' });

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Skipped);

      expect((await fs.readFile(path)).equals(plain.get(path)!)).toBe(true);
      expect(await temporaries()).toEqual([]);
    });

    it('seal stops before the rename when another user linked to the file meanwhile (M1)', async () => {
      const original = await write('original.jpg', 'original', 'asset');
      const thumbnail = await write('thumbnail.webp');
      // an upload deduplicated onto the original after the un-share looked, before the path lock
      mocks.lockedFile.plainReaders.mockImplementation((_id, path) =>
        Promise.resolve(path === original ? ['their-asset'] : []),
      );

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.lockedFile.plainReaders).toHaveBeenCalledWith(ASSET, original, LOCK_TRX);
      expect((await fs.readFile(original)).equals(plain.get(original)!)).toBe(true);
      expect((await fs.readFile(thumbnail)).equals(plain.get(thumbnail)!)).toBe(true);
      expect(await temporaries()).toEqual([]);
    });

    it('read-only source assets are never sealed and are counted as notEncryptable', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      state.encryptable = false;

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Skipped);
      expect(await isLockedFile(path)).toBe(false);

      mocks.lockedEncryption.getLockedAssets.mockResolvedValue([
        { id: ASSET, originalPath: path, encryptable: false, pendingUnlockAt: null },
      ]);
      row = undefined;
      const status = await newLockedEncryptionService(mocks).getStatus({ user: { id: OWNER } } as never);
      expect(status.counts).toEqual({ encrypted: 0, notEncryptable: 1, missing: 0 });
    });
  });

  describe('handleUnseal', () => {
    const sealAll = async () => {
      await sut.handleSeal({ id: ASSET });
      for (const { path } of files) {
        expect(await isLockedFile(path)).toBe(true);
      }
    };

    it('unseal of a pendingUnlockAt asset removes asset_lock only after the last file is plain', async () => {
      const first = await write('original.jpg', 'original', 'asset');
      const second = await write('thumbnail.webp');
      await sealAll();
      state.pendingUnlockAt = new Date();
      loadOwnerKey();
      const rename = fs.rename;
      let calls = 0;
      const spy = vi.spyOn(fs, 'rename').mockImplementation((from, to) => {
        calls++;
        return calls === 2 ? Promise.reject(new Error('power cut')) : rename(from, to);
      });

      await expect(sut.handleUnseal({ id: ASSET })).resolves.toBe(JobStatus.Failed);
      expect(await isLockedFile(first)).toBe(false);
      expect(await isLockedFile(second)).toBe(true);
      expect(mocks.lockedFile.finishPendingUnlock).not.toHaveBeenCalled();
      expect(await temporaries()).toEqual([]);

      spy.mockRestore();
      await expect(sut.handleUnseal({ id: ASSET })).resolves.toBe(JobStatus.Success);
      expect(mocks.lockedFile.finishPendingUnlock).toHaveBeenCalledExactlyOnceWith(ASSET);
      for (const { path } of files) {
        expect((await fs.readFile(path)).equals(plain.get(path)!)).toBe(true);
      }
    });

    it('unseal without the key returns Skipped; loading the key queues LockedSweep for that user', async () => {
      await write('original.jpg', 'original', 'asset');
      await sealAll();
      state.pendingUnlockAt = new Date();

      await expect(sut.handleUnseal({ id: ASSET })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.lockedFile.finishPendingUnlock).not.toHaveBeenCalled();

      await sut.onBootstrap();
      mocks.job.queue.mockClear();
      loadOwnerKey();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.LockedSweep, data: { userId: OWNER } });
      // an extended PIN unlock loads it again: no second wake-up right away
      loadOwnerKey();
      expect(mocks.job.queue).toHaveBeenCalledTimes(1);
    });

    it('loading the key wakes the jobs this worker deferred for it (FL-721 Task 6)', async () => {
      await sut.onBootstrap();
      const execution = { claim: { id: 'job-deferred', attempt: 1, data: {} } } as unknown as QueueExecution;
      queueExecution.run(execution, () => deferForLockedKey(new LockedKeyUnavailableError([OWNER])));

      loadOwnerKey();

      expect(mocks.job.wakeLockedDeferrals).toHaveBeenCalledWith(['job-deferred']);
    });

    it('wakes the deferred jobs again a little later, for one still running when the key loaded (FL-721 Task 12)', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        await sut.onBootstrap();
        const execution = { claim: { id: 'job-running', attempt: 1, data: {} } } as unknown as QueueExecution;
        queueExecution.run(execution, () => deferForLockedKey(new LockedKeyUnavailableError([OWNER])));

        loadOwnerKey();
        expect(mocks.job.wakeLockedDeferrals).toHaveBeenCalledTimes(1);
        for (const [index, delay] of LATE_WAKE_DELAYS_MS.entries()) {
          await vi.advanceTimersByTimeAsync(delay - (LATE_WAKE_DELAYS_MS[index - 1] ?? 0));
          expect(mocks.job.wakeLockedDeferrals).toHaveBeenCalledTimes(index + 2);
          expect(mocks.job.wakeLockedDeferrals).toHaveBeenLastCalledWith(['job-running']);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('drops the backstop wake-ups when the listener is set up again', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await sut.onBootstrap();
        const execution = { claim: { id: 'job-old', attempt: 1, data: {} } } as unknown as QueueExecution;
        queueExecution.run(execution, () => deferForLockedKey(new LockedKeyUnavailableError([OWNER])));
        loadOwnerKey();
        expect(mocks.job.wakeLockedDeferrals).toHaveBeenCalledTimes(1);

        await sut.onBootstrap();
        await vi.advanceTimersByTimeAsync(LATE_WAKE_DELAYS_MS.at(-1)! + 1);
        expect(mocks.job.wakeLockedDeferrals).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves an item that is still meant to be encrypted alone', async () => {
      await write('original.jpg', 'original', 'asset');
      await sealAll();
      loadOwnerKey();

      await expect(sut.handleUnseal({ id: ASSET })).resolves.toBe(JobStatus.Skipped);
      expect(await isLockedFile(files[0].path)).toBe(true);
    });

    it('stops before the rename when the item is locked again meanwhile', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      await sealAll();
      loadOwnerKey();
      mocks.lockedFile.getSealState
        .mockResolvedValueOnce({ ...state, pendingUnlockAt: new Date() })
        .mockResolvedValue({ ...state });

      await expect(sut.handleUnseal({ id: ASSET })).resolves.toBe(JobStatus.Skipped);
      expect(await isLockedFile(path)).toBe(true);
      expect(mocks.lockedFile.finishPendingUnlock).not.toHaveBeenCalled();
      expect(await temporaries()).toEqual([]);
    });

    it('gives the item its own plain copy of a file another Locked item still reads encrypted', async () => {
      const shared = await write('original.jpg', 'original', 'asset');
      await sealAll();
      state.pendingUnlockAt = new Date();
      loadOwnerKey();
      const ownCopy = join(dir, 'own.jpg');
      mocks.lockedFile.sealedReaders.mockResolvedValue(['00000000-0000-4000-8000-0000000000b2']);
      mocks.lockedFile.siblingPath.mockReturnValue(ownCopy);
      mocks.lockedFile.copyAndRepoint.mockImplementation(async (_id, ref, target, writeCopy) => {
        await writeCopy(target);
        // this asset now names its own copy; the other item keeps the shared file
        files[0] = { ...ref, path: target };
        return true;
      });

      await expect(sut.handleUnseal({ id: ASSET })).resolves.toBe(JobStatus.Success);

      expect(await isLockedFile(shared)).toBe(true);
      expect((await fs.readFile(ownCopy)).equals(plain.get(shared)!)).toBe(true);
      expect(await temporaries()).toEqual([]);
    });

    it('while turning off, asks the sweep to finish once an item is plain', async () => {
      await write('original.jpg', 'original', 'asset');
      await sealAll();
      state.status = 'decrypting';
      loadOwnerKey();

      await expect(sut.handleUnseal({ id: ASSET })).resolves.toBe(JobStatus.Success);
      expect(await isLockedFile(files[0].path)).toBe(false);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LockedSweep,
        data: { userId: OWNER, delay: FINISH_CHECK_DELAY_MS },
      });
    });
  });

  describe('handleRewrap', () => {
    it('adds a partner who got a key pair later, and needs the owner key for it', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      await sut.handleSeal({ id: ASSET });
      mocks.lockedFile.partnerRecipients.mockResolvedValue([{ userId: PARTNER, publicKey: partner.publicKey }]);

      await expect(sut.handleRewrap({ id: ASSET })).resolves.toBe(JobStatus.Skipped);
      expect((await readHeader(path)).keyIds).toHaveLength(1);

      loadOwnerKey();
      await expect(sut.handleRewrap({ id: ASSET })).resolves.toBe(JobStatus.Success);
      expect((await readHeader(path)).keyIds).toEqual([keyId(owner.publicKey), keyId(partner.publicKey)]);
      expect((await decrypted(path, partner.privateKey)).equals(plain.get(path)!)).toBe(true);
      expect(await temporaries()).toEqual([]);
    });

    it('switching to Advanced removes the partner entries', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      mocks.lockedFile.partnerRecipients.mockResolvedValue([{ userId: PARTNER, publicKey: partner.publicKey }]);
      await sut.handleSeal({ id: ASSET });
      keyFile.mode = 'advanced';
      loadOwnerKey();

      await expect(sut.handleRewrap({ id: ASSET })).resolves.toBe(JobStatus.Success);
      expect((await readHeader(path)).keyIds).toEqual([keyId(owner.publicKey)]);
      expect((await decrypted(path)).equals(plain.get(path)!)).toBe(true);
    });
  });

  describe('handleSweep', () => {
    it('queues seals for plain files and turns encrypting into on once nothing is left', async () => {
      await write('original.jpg', 'original', 'asset');

      await sut.handleSweep({ userId: OWNER });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedSeal, data: { id: ASSET } }]);
      expect(row?.status).toBe('encrypting');

      await sut.handleSeal({ id: ASSET });
      mocks.job.queueAll.mockClear();
      await sut.handleSweep({ userId: OWNER });
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(row?.status).toBe('on');
    });

    it('the hourly sweep covers everyone with a row', async () => {
      await write('original.jpg', 'original', 'asset');
      await sut.handleSweep({});
      expect(mocks.lockedEncryption.getAllUserIds).toHaveBeenCalled();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedSeal, data: { id: ASSET } }]);
    });

    it('queues unseals only while the key is loaded', async () => {
      await write('original.jpg', 'original', 'asset');
      await sut.handleSeal({ id: ASSET });
      row = { ...row!, status: 'decrypting' };

      mocks.job.queueAll.mockClear();
      await sut.handleSweep({ userId: OWNER });
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(row).toBeDefined();

      loadOwnerKey();
      await sut.handleSweep({ userId: OWNER });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedUnseal, data: { id: ASSET } }]);
    });

    it('finishes an unlock whose files are all plain', async () => {
      await write('original.jpg', 'original', 'asset');
      state.pendingUnlockAt = new Date();

      await sut.handleSweep({ userId: OWNER });

      expect(mocks.lockedFile.finishPendingUnlock).toHaveBeenCalledWith(ASSET);
    });

    it('queues a rewrap when a file has the wrong recipients and the key is loaded', async () => {
      await write('original.jpg', 'original', 'asset');
      await sut.handleSeal({ id: ASSET });
      mocks.lockedFile.partnerRecipients.mockResolvedValue([{ userId: PARTNER, publicKey: partner.publicKey }]);
      loadOwnerKey();
      mocks.job.queueAll.mockClear();

      await sut.handleSweep({ userId: OWNER });

      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedRewrap, data: { id: ASSET } }]);
    });

    describe('finishing turn-off (Ruling 11)', () => {
      beforeEach(() => {
        row = { userId: OWNER, mode: 'pin', status: 'decrypting' };
        lockedKeys.load(OWNER, owner.publicKey, Buffer.from(owner.privateKey), null);
        lockedKeys.pin(OWNER, true);
      });

      it('keeps a key file with a PIN wrap as a PIN-only key pair that encrypts nothing', async () => {
        await write('original.jpg', 'original', 'asset');

        await sut.handleSweep({ userId: OWNER });

        expect(mocks.database.withLockedKeyFileLock).toHaveBeenCalledWith(OWNER, expect.any(Function));
        expect(mocks.lockedKey.write).toHaveBeenCalledWith(
          expect.objectContaining({
            mode: 'pin',
            encrypting: false,
            wraps: [expect.objectContaining({ kind: 'pin' })],
          }),
        );
        expect(mocks.lockedKey.delete).not.toHaveBeenCalled();
        expect(row).toBeUndefined();
        expect(lockedKeys.has(OWNER)).toBe(false);
        // only the API process tells the supervisor; it hears this
        expect(publishLockedKey).not.toHaveBeenCalled();
        expect(mocks.websocket.serverSend).toHaveBeenCalledWith('LockedEncryptionOff', { userId: OWNER });
      });

      it('deletes a key file without a PIN wrap', async () => {
        keyFile.mode = 'advanced';
        keyFile.wraps = keyFile.wraps.map((wrap) => (wrap.kind === 'pin' ? { ...wrap, kind: 'passphrase' } : wrap));

        await sut.handleSweep({ userId: OWNER });

        expect(mocks.lockedKey.delete).toHaveBeenCalledWith(OWNER);
        expect(mocks.lockedKey.write).not.toHaveBeenCalled();
        expect(row).toBeUndefined();
      });

      it('a deleted key file queues a sweep of the owners who share with this person (Ruling 11, Task 8)', async () => {
        const SHARER = '00000000-0000-4000-8000-000000000003';
        keyFile.mode = 'advanced';
        keyFile.wraps = keyFile.wraps.map((wrap) => (wrap.kind === 'pin' ? { ...wrap, kind: 'passphrase' } : wrap));
        mocks.lockedEncryption.getOwnersSharingWith.mockResolvedValue([SHARER]);

        await sut.handleSweep({ userId: OWNER });

        expect(mocks.lockedEncryption.getOwnersSharingWith).toHaveBeenCalledWith(OWNER);
        expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedSweep, data: { userId: SHARER } }]);
      });

      it('a key file kept as a PIN-only key pair changes no partner entry, so nothing is queued for sharers', async () => {
        mocks.lockedEncryption.getOwnersSharingWith.mockResolvedValue([PARTNER]);

        await sut.handleSweep({ userId: OWNER });

        expect(mocks.lockedEncryption.getOwnersSharingWith).not.toHaveBeenCalled();
      });

      it('a sharer’s re-wrap drops the entry of a partner whose key is gone', async () => {
        row = { userId: OWNER, mode: 'pin', status: 'on' };
        state.status = 'on';
        const path = await write('original.jpg', 'original', 'asset');
        mocks.lockedFile.partnerRecipients.mockResolvedValue([{ userId: PARTNER, publicKey: partner.publicKey }]);
        await sut.handleSeal({ id: ASSET });
        expect((await readHeader(path)).keyIds).toHaveLength(2);

        // the partner's key file was deleted (or replaced): partnerRecipients no longer lists that key
        mocks.lockedFile.partnerRecipients.mockResolvedValue([]);
        mocks.job.queueAll.mockClear();
        await sut.handleSweep({ userId: OWNER });
        expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedRewrap, data: { id: ASSET } }]);
        await expect(sut.handleRewrap({ id: ASSET })).resolves.toBe(JobStatus.Success);
        expect((await readHeader(path)).keyIds).toEqual([keyId(owner.publicKey)]);

        // and a replaced key pair gets the new key instead
        const replaced = generateKeyPair();
        mocks.lockedFile.partnerRecipients.mockResolvedValue([{ userId: PARTNER, publicKey: replaced.publicKey }]);
        await expect(sut.handleRewrap({ id: ASSET })).resolves.toBe(JobStatus.Success);
        expect((await readHeader(path)).keyIds).toEqual([keyId(owner.publicKey), keyId(replaced.publicKey)]);
        expect((await decrypted(path, replaced.privateKey)).equals(plain.get(path)!)).toBe(true);
      });

      it('a re-wrap that waited for the key sweeps on the very next key load (FL-721 Task 12)', async () => {
        row = { userId: OWNER, mode: 'pin', status: 'on' };
        state.status = 'on';
        const path = await write('original.jpg', 'original', 'asset');
        await sut.handleSeal({ id: ASSET });
        expect((await readHeader(path)).keyIds).toHaveLength(1);
        await sut.onBootstrap();
        loadOwnerKey();
        mocks.job.queue.mockClear();

        // a new partner while the owner's key is closed: nothing can be re-wrapped yet
        lockedKeys.clear();
        mocks.lockedFile.partnerRecipients.mockResolvedValue([{ userId: PARTNER, publicKey: partner.publicKey }]);
        mocks.job.queueAll.mockClear();
        await sut.handleSweep({ userId: OWNER });
        expect(mocks.job.queueAll).not.toHaveBeenCalled();

        // the owner's next unlock, a minute after the last: it sweeps, though wake-ups are spaced out
        loadOwnerKey();
        expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith({ name: JobName.LockedSweep, data: { userId: OWNER } });
        await sut.handleSweep({ userId: OWNER });
        expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedRewrap, data: { id: ASSET } }]);
        // and an extension right after that is spaced out again
        loadOwnerKey();
        expect(mocks.job.queue).toHaveBeenCalledTimes(1);
      });

      it('never deletes a key file it cannot read', async () => {
        mocks.lockedKey.read.mockRejectedValue(new SyntaxError('Unexpected token'));

        await sut.handleSweep({ userId: OWNER });

        expect(mocks.lockedKey.delete).not.toHaveBeenCalled();
        expect(mocks.lockedKey.write).not.toHaveBeenCalled();
      });

      it('waits while any file is still encrypted', async () => {
        lockedKeys.clear();
        row = { ...row!, status: 'encrypting' };
        await write('original.jpg', 'original', 'asset');
        await sut.handleSeal({ id: ASSET });
        row = { ...row, status: 'decrypting' };

        await sut.handleSweep({ userId: OWNER });

        expect(row).toBeDefined();
        expect(mocks.lockedKey.write).not.toHaveBeenCalled();
      });
    });
  });

  describe('two jobs on one shared path (fix round 1, C1)', () => {
    const OTHER = '00000000-0000-4000-8000-0000000000b2';
    let states: Map<string, LockedSealState>;

    beforeEach(() => {
      states = new Map([
        [ASSET, state],
        [OTHER, { ...state, id: OTHER }],
      ]);
      mocks.lockedFile.getSealState.mockImplementation((id) =>
        Promise.resolve(states.has(id) ? { ...states.get(id)! } : undefined),
      );
    });

    it('concurrent seal + seal of a shared file leave one valid sealed file and lose no bytes', async () => {
      const path = await write('shared.jpg', 'original', 'asset');

      const results = await Promise.all([sut.handleSeal({ id: ASSET }), sut.handleSeal({ id: OTHER })]);

      expect(results).toContain(JobStatus.Success);
      expect((await decrypted(path)).equals(plain.get(path)!)).toBe(true);
      expect(await temporaries()).toEqual([]);
    });

    it('a seal that finds the path busy skips and asks for a later sweep', async () => {
      const path = await write('shared.jpg', 'original', 'asset');
      held.add(path);

      await expect(sut.handleSeal({ id: ASSET })).resolves.toBe(JobStatus.Skipped);

      expect(await isLockedFile(path)).toBe(false);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.LockedSweep,
        data: { userId: OWNER, delay: FINISH_CHECK_DELAY_MS },
      });
    });

    it('even without the path lock, each job has its own temporary file and none truncates another', async () => {
      mocks.lockedFile.withFileLock.mockImplementation((_path, _ownerId, work) => work((step) => step(LOCK_TRX)));
      const path = await write('shared.jpg', 'original', 'asset');

      await Promise.all([sut.handleSeal({ id: ASSET }), sut.handleSeal({ id: OTHER })]);

      expect((await decrypted(path)).equals(plain.get(path)!)).toBe(true);
      expect(await temporaries()).toEqual([]);
    });

    it('concurrent seal + unseal of a shared file leave a valid file and lose no bytes', async () => {
      const path = await write('shared.jpg', 'original', 'asset');
      await sut.handleSeal({ id: ASSET });
      states.set(OTHER, { ...state, id: OTHER, pendingUnlockAt: new Date() });
      loadOwnerKey();

      await Promise.all([sut.handleSeal({ id: ASSET }), sut.handleUnseal({ id: OTHER })]);

      const bytes = (await isLockedFile(path)) ? await decrypted(path) : await fs.readFile(path);
      expect(bytes.equals(plain.get(path)!)).toBe(true);
      expect(await temporaries()).toEqual([]);
    });

    it('concurrent unseal + seal of a plain shared file leave a valid file', async () => {
      const path = await write('shared.jpg', 'original', 'asset');
      states.set(OTHER, { ...state, id: OTHER, pendingUnlockAt: new Date() });
      loadOwnerKey();

      await Promise.all([sut.handleUnseal({ id: OTHER }), sut.handleSeal({ id: ASSET })]);

      const bytes = (await isLockedFile(path)) ? await decrypted(path) : await fs.readFile(path);
      expect(bytes.equals(plain.get(path)!)).toBe(true);
      expect(await temporaries()).toEqual([]);
    });
  });

  describe('a missing file is never a plain one (fix round 1, C2)', () => {
    it('a missing original during turn-off keeps the key file and the row; once it is back, the sweep finishes', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      await sut.handleSeal({ id: ASSET });
      const sealed = await fs.readFile(path);
      await fs.rm(path); // the volume is offline
      row = { userId: OWNER, mode: 'advanced', status: 'decrypting' };
      keyFile.mode = 'advanced';
      keyFile.wraps = keyFile.wraps.map((wrap) => (wrap.kind === 'pin' ? { ...wrap, kind: 'passphrase' } : wrap));
      state.status = 'decrypting';
      loadOwnerKey();

      await expect(sut.handleUnseal({ id: ASSET })).resolves.toBe(JobStatus.Skipped);
      await sut.handleSweep({ userId: OWNER });

      expect(mocks.lockedKey.delete).not.toHaveBeenCalled();
      expect(mocks.lockedKey.write).not.toHaveBeenCalled();
      expect(row).toBeDefined();

      await fs.writeFile(path, sealed); // back online, still encrypted
      await sut.handleSweep({ userId: OWNER });
      expect(row).toBeDefined();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.LockedUnseal, data: { id: ASSET } }]);

      await expect(sut.handleUnseal({ id: ASSET })).resolves.toBe(JobStatus.Success);
      await sut.handleSweep({ userId: OWNER });
      expect(mocks.lockedKey.delete).toHaveBeenCalledWith(OWNER);
      expect(row).toBeUndefined();
      expect((await fs.readFile(path)).equals(plain.get(path)!)).toBe(true);
    });

    it('turn-off re-reads every file under the exclusive lock before touching the key file', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      row = { userId: OWNER, mode: 'pin', status: 'decrypting' };
      // the sweep read the file plain; a rename lands before the exclusive lock is taken
      mocks.database.withLockedKeyFileLock.mockImplementation(async (_id, fn) => {
        await fs.writeFile(path, Buffer.concat([Buffer.from('FLLK'), randomBytes(40)]));
        return fn();
      });

      await sut.handleSweep({ userId: OWNER });

      expect(mocks.lockedKey.write).not.toHaveBeenCalled();
      expect(mocks.lockedKey.delete).not.toHaveBeenCalled();
      expect(row).toBeDefined();
    });

    it('a pending unlock with a missing file keeps the lock; once it is back, the sweep finishes it', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      await write('thumbnail.webp');
      await sut.handleSeal({ id: ASSET });
      const sealed = await fs.readFile(path);
      await fs.rm(path);
      state.pendingUnlockAt = new Date();
      loadOwnerKey();

      await expect(sut.handleUnseal({ id: ASSET })).resolves.toBe(JobStatus.Skipped);
      await sut.handleSweep({ userId: OWNER });
      expect(mocks.lockedFile.finishPendingUnlock).not.toHaveBeenCalled();

      await fs.writeFile(path, sealed);
      await expect(sut.handleUnseal({ id: ASSET })).resolves.toBe(JobStatus.Success);
      expect(mocks.lockedFile.finishPendingUnlock).toHaveBeenCalledExactlyOnceWith(ASSET);
      expect((await fs.readFile(path)).equals(plain.get(path)!)).toBe(true);
    });

    it('an unseal that leaves a file encrypted does not finish the unlock (M5)', async () => {
      const path = await write('original.jpg', 'original', 'asset');
      await sut.handleSeal({ id: ASSET });
      state.pendingUnlockAt = new Date();
      // a key that is not a recipient of the file
      const stranger = generateKeyPair();
      lockedKeys.load(OWNER, stranger.publicKey, Buffer.from(stranger.privateKey), null);

      await expect(sut.handleUnseal({ id: ASSET })).resolves.toBe(JobStatus.Skipped);

      expect(await isLockedFile(path)).toBe(true);
      expect(mocks.lockedFile.finishPendingUnlock).not.toHaveBeenCalled();
    });
  });

  it('removeStaleTemp also clears leftovers beside items that have since left Locked (FL-721 backups)', async () => {
    const left = join(dir, 'IMG_left.jpg');
    await fs.writeFile(left, 'plain again');
    await fs.writeFile(`${left}.0b6e5c7e-3f0b-4c8e-9a51-2f1f3c4d5e6f.fllk.tmp`, 'half written');
    // someone else's file in the same folder keeps its own temporary file
    await fs.writeFile(join(dir, 'other.jpg.fllk.tmp'), 'not one of theirs');
    mocks.lockedEncryption.getUnlockedFilePaths.mockResolvedValue([left]);

    await sut.removeStaleTemp();

    expect(mocks.lockedEncryption.getUnlockedFilePaths).toHaveBeenCalledWith(OWNER);
    expect(await temporaries()).toEqual(['other.jpg.fllk.tmp']);
    expect(await fs.readFile(left, 'utf8')).toBe('plain again');
  });

  it('matches each row to its live key file at start-up, and never turns encryption back on (FL-721 backups)', async () => {
    const other = '00000000-0000-4000-8000-000000000009';
    mocks.lockedKey.list.mockResolvedValue([
      { ...keyFile, userId: OWNER, mode: 'advanced' },
      // a PIN-only key pair kept for partner shares after turning off: no row, and none is made
      { ...keyFile, userId: other, mode: 'pin', wraps: keyFile.wraps.filter(({ kind }) => kind === 'pin') },
    ]);
    mocks.lockedEncryption.get.mockImplementation((id: string) =>
      Promise.resolve(id === OWNER ? ({ userId: OWNER, mode: 'pin', status: 'on' } as never) : undefined),
    );
    mocks.lockedEncryption.update.mockResolvedValue({} as never);

    await sut.matchRowsToKeyFiles();

    expect(mocks.lockedEncryption.update).toHaveBeenCalledWith(OWNER, { mode: 'advanced' });
    expect(mocks.lockedEncryption.update).toHaveBeenCalledTimes(1);
    expect(mocks.lockedEncryption.create).not.toHaveBeenCalled();
  });

  it('the start-up sweep runs in the background, so job start never waits for it (M9)', async () => {
    const listing = Promise.withResolvers<string[]>();
    mocks.lockedEncryption.getAllUserIds.mockReturnValueOnce(listing.promise);
    const sweep = vi.spyOn(sut, 'removeStaleTemp');

    await expect(sut.onBootstrap()).resolves.toBeUndefined();

    expect(sweep).toHaveBeenCalledWith(expect.any(Date));
    listing.resolve([]);
    await vi.waitFor(() => expect(mocks.lockedEncryption.getAllUserIds).toHaveBeenCalled());
  });

  it('the background sweep leaves temporary files written since start-up: a job is writing them (M9)', async () => {
    const path = await write('original.jpg', 'original', 'asset');
    const stale = `${path}.0b6e5c7e-3f0b-4c8e-9a51-2f1f3c4d5e6f.fllk.tmp`;
    const fresh = `${path}.1c7f6d8f-4a1c-4d9f-8b62-3a2a4d5e6f70.fllk.tmp`;
    await fs.writeFile(stale, 'left by a crash');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(stale, old, old);
    await fs.writeFile(fresh, 'being written');

    await sut.removeStaleTemp(new Date(Date.now() - 1000));

    expect(await temporaries()).toEqual([basename(fresh)]);
  });

  it('removeStaleTemp leaves read-only library folders alone (M4)', async () => {
    const path = await write('original.jpg', 'original', 'asset');
    state.encryptable = false;
    await fs.writeFile(`${path}.fllk.tmp`, 'the person’s own file');

    await sut.removeStaleTemp();

    expect(await temporaries()).toEqual(['original.jpg.fllk.tmp']);
    expect(mocks.lockedFile.filesOf).not.toHaveBeenCalled();
  });
});
