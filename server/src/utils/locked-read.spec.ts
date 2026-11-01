import { SEGMENT_SIZE, encryptFile, generateKeyPair } from '@frameleaf/locked-crypto';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { QueueExecution } from 'src/queue/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { queueExecution } from 'src/queue/context.js';
import { LOCKED_TEMP_NAME } from 'src/utils/locked-backup.js';
import { lockedKeys } from 'src/utils/locked-key-holder.js';
import {
  LockedKeyUnavailableError,
  LockedTmpTooSmallError,
  LockedTmpUnavailableError,
  RangeNotSatisfiableError,
  assertLockedTmpIsTmpfs,
  clearLockedDeferrals,
  clearLockedKeyOwners,
  clearLockedPathCache,
  deferForLockedKey,
  hashPlainFile,
  isLockedPath,
  isPlainCopyPath,
  makeWorkDir,
  makeWorkDirFor,
  openLockedRead,
  resetLockedTmpCheck,
  rewriteThroughPlainCopy,
  takeLockedDeferrals,
  withPlainCopy,
} from 'src/utils/locked-read.js';

const OWNER = '00000000-0000-4000-8000-000000000001';
const VIEWER = '00000000-0000-4000-8000-000000000002';
const ASSET = '00000000-0000-4000-8000-0000000000a1';

const readAll = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

describe('locked-read', () => {
  let dir: string;
  let tmp: string;
  let owner: ReturnType<typeof generateKeyPair>;
  let plain: Buffer;
  let sealed: string;

  const loadOwner = () => lockedKeys.load(OWNER, owner.publicKey, Buffer.from(owner.privateKey), null);

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'locked-read-'));
    tmp = join(dir, 'shm', 'frameleaf-locked');
    vi.stubEnv('FRAMELEAF_LOCKED_TMP', tmp);
    vi.stubEnv('FRAMELEAF_LOCKED_TMP_ALLOW_DISK', 'true');
    resetLockedTmpCheck();
    clearLockedPathCache();
    clearLockedKeyOwners();
    clearLockedDeferrals();
    StorageCore.setMediaLocation(dir);
    owner = generateKeyPair();
    // two full segments and a short third one
    plain = randomBytes(2 * SEGMENT_SIZE + 1234);
    await fs.writeFile(join(dir, 'IMG_0001.jpg.src'), plain);
    sealed = join(dir, 'IMG_0001.jpg');
    await encryptFile(join(dir, 'IMG_0001.jpg.src'), sealed, [{ publicKey: owner.publicKey }], {
      assetId: ASSET,
      kind: 'original',
      originalFileName: 'IMG_0001.jpg',
      mime: 'image/jpeg',
    });
    await fs.mkdir(join(dir, 'locked-keys'));
    await fs.writeFile(
      join(dir, 'locked-keys', `${OWNER}.json`),
      JSON.stringify({
        format: 'frameleaf-locked-key/1',
        userId: OWNER,
        publicKey: owner.publicKey.toString('base64'),
      }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    lockedKeys.clear();
    vi.unstubAllEnvs();
    resetLockedTmpCheck();
    StorageCore.reset();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe(isLockedPath.name, () => {
    it('tells sealed from plain files, and a missing file is not sealed', async () => {
      await expect(isLockedPath(sealed)).resolves.toBe(true);
      await expect(isLockedPath(join(dir, 'IMG_0001.jpg.src'))).resolves.toBe(false);
      await expect(isLockedPath(join(dir, 'missing.jpg'))).resolves.toBe(false);
    });

    it('notices a file replaced at the same path', async () => {
      await expect(isLockedPath(sealed)).resolves.toBe(true);
      await fs.rm(sealed);
      await fs.copyFile(join(dir, 'IMG_0001.jpg.src'), sealed);
      await expect(isLockedPath(sealed)).resolves.toBe(false);
    });
  });

  describe(openLockedRead.name, () => {
    beforeEach(loadOwner);

    it('streams the whole file with its length and MIME type', async () => {
      const { stream, plaintextLength, mime } = await openLockedRead(sealed, OWNER);
      expect(plaintextLength).toBe(plain.length);
      expect(mime).toBe('image/jpeg');
      expect((await readAll(stream)).equals(plain)).toBe(true);
    });

    it.each([
      ['in segment 0', 100, 199],
      ['across a boundary', SEGMENT_SIZE - 10, SEGMENT_SIZE + 9],
      ['in the last short segment', 2 * SEGMENT_SIZE + 5, 2 * SEGMENT_SIZE + 1233],
    ])('streams the right bytes for a range %s', async (_, start, end) => {
      const { stream } = await openLockedRead(sealed, OWNER, { start, end });
      expect((await readAll(stream)).equals(plain.subarray(start, end + 1))).toBe(true);
    });

    it('streams the right bytes for bytes=-500 (the last 500)', async () => {
      const start = plain.length - 500;
      const { stream } = await openLockedRead(sealed, OWNER, { start, end: plain.length - 1 });
      expect((await readAll(stream)).equals(plain.subarray(start))).toBe(true);
    });

    it('a range past the end is rejected with RangeNotSatisfiable', async () => {
      await expect(openLockedRead(sealed, OWNER, { start: plain.length, end: plain.length + 10 })).rejects.toThrow(
        RangeNotSatisfiableError,
      );
      await expect(openLockedRead(sealed, OWNER, { start: 0, end: plain.length })).rejects.toThrow(
        RangeNotSatisfiableError,
      );
    });

    it('a background job (no viewer) may use any loaded key', async () => {
      const { stream } = await openLockedRead(sealed, null);
      expect((await readAll(stream)).equals(plain)).toBe(true);
    });
  });

  it('without a loaded key, openLockedRead throws LockedKeyUnavailableError naming the owner', async () => {
    const error = await openLockedRead(sealed, OWNER).catch((error_) => error_);
    expect(error).toBeInstanceOf(LockedKeyUnavailableError);
    expect(error.ownerIds).toEqual([OWNER]);
    expect(error.code).toBe('locked_key_unavailable');
  });

  it('names a person who turned encryption on within a minute of the last key file read', async () => {
    // the first lookup reads the key files, which hold only OWNER's
    await openLockedRead(sealed, OWNER).catch(() => {});

    const other = generateKeyPair();
    await fs.writeFile(
      join(dir, 'locked-keys', `${VIEWER}.json`),
      JSON.stringify({
        format: 'frameleaf-locked-key/1',
        userId: VIEWER,
        publicKey: other.publicKey.toString('base64'),
      }),
    );
    await fs.writeFile(join(dir, 'other.src'), plain);
    const otherSealed = join(dir, 'other.jpg');
    await encryptFile(join(dir, 'other.src'), otherSealed, [{ publicKey: other.publicKey }], {
      assetId: ASSET,
      kind: 'original',
      originalFileName: 'other.jpg',
      mime: 'image/jpeg',
    });

    // a job deferred without its owner is never woken by their unlock, only by the hourly sweep
    const error = await openLockedRead(otherSealed, null).catch((error_) => error_);
    expect(error.ownerIds).toEqual([VIEWER]);
  });

  it("a viewer without a grant can't read an Advanced owner's file", async () => {
    loadOwner();
    await expect(openLockedRead(sealed, VIEWER)).rejects.toThrow(LockedKeyUnavailableError);
    // the header's key ids are not an access list: a grant is what lets the viewer use the key
    lockedKeys.grant(VIEWER, OWNER);
    const { stream } = await openLockedRead(sealed, VIEWER);
    expect((await readAll(stream)).equals(plain)).toBe(true);
  });

  describe(withPlainCopy.name, () => {
    it('gives the tool a plain file under FRAMELEAF_LOCKED_TMP and deletes it after fn resolves', async () => {
      loadOwner();
      let seen = '';
      const result = await withPlainCopy(sealed, async (plainPath) => {
        seen = plainPath;
        expect(plainPath.startsWith(tmp + '/')).toBe(true);
        expect(plainPath.endsWith('/IMG_0001.jpg')).toBe(true);
        expect((await fs.readFile(plainPath)).equals(plain)).toBe(true);
        expect((await fs.stat(plainPath)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(join(plainPath, '..'))).mode & 0o777).toBe(0o700);
        return 'done';
      });
      expect(result).toBe('done');
      await expect(fs.stat(seen)).rejects.toThrow();
      expect(await fs.readdir(tmp)).toEqual([]);
      expect((await fs.stat(tmp)).mode & 0o777).toBe(0o700);
    });

    it('deletes the plain copy after fn throws', async () => {
      loadOwner();
      let seen = '';
      await expect(
        withPlainCopy(sealed, (plainPath) => {
          seen = plainPath;
          return Promise.reject(new Error('tool failed'));
        }),
      ).rejects.toThrow('tool failed');
      await expect(fs.stat(seen)).rejects.toThrow();
      expect(await fs.readdir(tmp)).toEqual([]);
    });

    it('passes a plain path through untouched', async () => {
      const source = join(dir, 'IMG_0001.jpg.src');
      await expect(withPlainCopy(source, (plainPath) => Promise.resolve(plainPath))).resolves.toBe(source);
      await expect(fs.stat(tmp)).rejects.toThrow();
    });

    it('without a key, throws LockedKeyUnavailableError and writes nothing', async () => {
      await expect(withPlainCopy(sealed, () => Promise.resolve())).rejects.toThrow(LockedKeyUnavailableError);
      await expect(fs.readdir(tmp)).rejects.toThrow();
    });

    it('fails with a clear, lasting error when the temporary folder cannot hold the file', async () => {
      loadOwner();
      await fs.mkdir(tmp, { recursive: true });
      // 4 KiB free: far less than the three segments the file decrypts to
      vi.spyOn(fs, 'statfs').mockResolvedValue({ bsize: 4096, bavail: 1 } as never);
      const fn = vi.fn();
      const execution = {
        claim: { id: 'job-1', attempt: 1, data: {} },
        signal: new AbortController().signal,
      } as unknown as QueueExecution;

      const error = await queueExecution.run(execution, () =>
        withPlainCopy(sealed, fn).catch((error: unknown) => error),
      );

      expect(error).toBeInstanceOf(LockedTmpTooSmallError);
      // never mistaken for waiting for the key
      expect(error).not.toBeInstanceOf(LockedKeyUnavailableError);
      expect(execution.dependencyReason).toBeUndefined();
      expect((error as Error).message).toContain('FRAMELEAF_LOCKED_TMP');
      expect((error as Error).message).toContain('4.0 KiB free');
      expect(fn).not.toHaveBeenCalled();
      // nothing written, and never a fallback to another folder
      expect(await fs.readdir(tmp)).toEqual([]);
    });

    it('turns a full temporary folder while decrypting into the same lasting error', async () => {
      loadOwner();
      vi.spyOn(fs, 'statfs').mockResolvedValue({ bsize: 4096, bavail: 1_000_000 } as never);
      const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      vi.spyOn(fs, 'utimes').mockRejectedValueOnce(full);

      await expect(withPlainCopy(sealed, () => Promise.resolve())).rejects.toThrow(LockedTmpTooSmallError);
      expect(await fs.readdir(tmp)).toEqual([]);
    });

    it('refuses (defers) when the temporary folder is not RAM-backed and the override is not set', async () => {
      vi.stubEnv('FRAMELEAF_LOCKED_TMP_ALLOW_DISK', '');
      resetLockedTmpCheck();
      loadOwner();
      const fn = vi.fn();
      // a temporary folder under the OS temp dir is never tmpfs on macOS, nor (in CI) under /tmp on disk
      if (process.platform === 'linux') {
        const mounts = await fs.readFile('/proc/mounts', 'utf8');
        if (mounts.split('\n').some((line) => line.split(' ', 2)[1] === '/tmp' && line.split(' ', 3)[2] === 'tmpfs')) {
          return;
        }
      }
      await expect(withPlainCopy(sealed, fn)).rejects.toThrow(LockedTmpUnavailableError);
      await expect(assertLockedTmpIsTmpfs()).rejects.toThrow(LockedTmpUnavailableError);
      expect(fn).not.toHaveBeenCalled();
      expect(await fs.readdir(tmp)).toEqual([]);
    });

    it('checks the temporary folder again after a failed check, so a repaired folder is used without a restart', async () => {
      // a file where the folder should be: it can't be prepared
      const blocker = join(dir, 'not-a-folder');
      await fs.writeFile(blocker, '');
      vi.stubEnv('FRAMELEAF_LOCKED_TMP', join(blocker, 'frameleaf-locked'));
      resetLockedTmpCheck();
      await expect(assertLockedTmpIsTmpfs()).rejects.toThrow(LockedTmpUnavailableError);

      vi.stubEnv('FRAMELEAF_LOCKED_TMP', tmp);
      await expect(assertLockedTmpIsTmpfs()).resolves.toBeUndefined();
    });
  });

  it('rewriteThroughPlainCopy runs the tool on a plain copy and leaves the result plain at the path', async () => {
    loadOwner();
    const changed = await rewriteThroughPlainCopy(sealed, async (plainPath) => {
      await fs.appendFile(plainPath, 'more');
    });
    expect(changed).toBe(true);
    expect((await fs.readFile(sealed)).equals(Buffer.concat([plain, Buffer.from('more')]))).toBe(true);
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  it('rewriteThroughPlainCopy stages the plain result under a .fllk.tmp name the start-up sweep removes (M5)', async () => {
    loadOwner();
    const rename = vi.spyOn(fs, 'rename');
    await rewriteThroughPlainCopy(sealed, (plainPath) => fs.appendFile(plainPath, 'more'));

    const [staging, to] = rename.mock.calls.at(-1)! as [string, string];
    expect(to).toBe(sealed);
    expect(join(staging, '..')).toBe(dir);
    expect(LOCKED_TEMP_NAME.exec(basename(staging))?.[1]).toBe(basename(sealed));
  });

  it('hashPlainFile on a request uses only the keys its viewer may use (M7)', async () => {
    loadOwner();
    const expected = createHash('sha256').update(plain).digest();

    await expect(hashPlainFile(sealed, 'sha256', VIEWER)).rejects.toThrow(LockedKeyUnavailableError);
    await expect(hashPlainFile(sealed, 'sha256', OWNER)).resolves.toEqual(expected);
    // a job may use any loaded key
    await expect(hashPlainFile(sealed, 'sha256', null)).resolves.toEqual(expected);
  });

  describe(deferForLockedKey.name, () => {
    const context = (attempt = 1, data: Record<string, unknown> = {}) =>
      ({ claim: { id: 'job-1', attempt, data }, signal: new AbortController().signal }) as unknown as QueueExecution;

    it('marks the job deferred and remembers it for the owner', () => {
      const execution = context();
      queueExecution.run(execution, () => deferForLockedKey(new LockedKeyUnavailableError([OWNER])));
      expect(execution.dependencyReason).toBe('locked-key-unavailable');
      expect(takeLockedDeferrals(OWNER)).toEqual(['job-1']);
      expect(takeLockedDeferrals(OWNER)).toEqual([]);
    });

    it('a handler that catches the error still defers', async () => {
      loadOwner();
      lockedKeys.clear();
      const execution = context();
      await queueExecution.run(execution, async () => {
        await withPlainCopy(sealed, () => Promise.resolve()).catch(() => 'swallowed');
      });
      expect(execution.dependencyReason).toBe('locked-key-unavailable');
      expect(takeLockedDeferrals(OWNER)).toEqual(['job-1']);
    });

    it('stops deferring after 72 attempts, and never defers operation-owned work', () => {
      const late = context(73);
      queueExecution.run(late, () => deferForLockedKey(new LockedKeyUnavailableError([OWNER])));
      expect(late.dependencyReason).toBeUndefined();
      const owned = context(1, { operationId: 'op' });
      queueExecution.run(owned, () => deferForLockedKey(new LockedKeyUnavailableError([OWNER])));
      expect(owned.dependencyReason).toBeUndefined();
    });

    it('does nothing outside a job or for other errors', () => {
      expect(() => deferForLockedKey(new LockedKeyUnavailableError([OWNER]))).not.toThrow();
      const execution = context();
      queueExecution.run(execution, () => deferForLockedKey(new Error('other')));
      expect(execution.dependencyReason).toBeUndefined();
    });
  });

  describe('makeWorkDir (FL-721)', () => {
    it("puts a sealed source's scratch folder in the locked tmp root, 0700, swept like a plain copy", async () => {
      const root = await fs.mkdtemp(join(tmpdir(), 'locked-workdir-'));
      const lockedTmp = join(root, 'shm');
      vi.stubEnv('FRAMELEAF_LOCKED_TMP', lockedTmp);
      vi.stubEnv('FRAMELEAF_LOCKED_TMP_ALLOW_DISK', 'true');
      resetLockedTmpCheck();
      try {
        const sealed = await makeWorkDir('darktable', true);
        expect(sealed.startsWith(join(lockedTmp, `copy-${process.pid}-darktable-`))).toBe(true);
        expect((await fs.stat(sealed)).mode & 0o777).toBe(0o700);

        const copy = join(lockedTmp, `copy-${process.pid}-x`, 'IMG.CR2');
        expect(isPlainCopyPath(copy)).toBe(true);
        expect(isPlainCopyPath(join(root, 'IMG.CR2'))).toBe(false);
        expect((await makeWorkDirFor(copy, 'tool')).startsWith(lockedTmp)).toBe(true);

        const plain = await makeWorkDir('darktable', false);
        expect(plain.startsWith(join(tmpdir(), 'frameleaf-darktable-'))).toBe(true);
        await fs.rm(plain, { recursive: true, force: true });
      } finally {
        vi.unstubAllEnvs();
        resetLockedTmpCheck();
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('refuses a sealed scratch folder when the locked tmp is not RAM-backed', async () => {
      const folder = join(tmpdir(), `locked-workdir-${randomBytes(4).toString('hex')}`);
      vi.stubEnv('FRAMELEAF_LOCKED_TMP', folder);
      vi.stubEnv('FRAMELEAF_LOCKED_TMP_ALLOW_DISK', 'false');
      resetLockedTmpCheck();
      try {
        // skipped only where the OS temp folder really is tmpfs
        if (process.platform === 'linux') {
          const mounts = await fs.readFile('/proc/mounts', 'utf8');
          if (
            mounts.split('\n').some((line) => line.split(' ', 2)[1] === '/tmp' && line.split(' ', 3)[2] === 'tmpfs')
          ) {
            return;
          }
        }
        await expect(makeWorkDir('darktable', true)).rejects.toBeInstanceOf(LockedTmpUnavailableError);
      } finally {
        vi.unstubAllEnvs();
        resetLockedTmpCheck();
        await fs.rm(folder, { recursive: true, force: true });
      }
    });
  });
});

describe('dynamic imports in the built server', () => {
  // FL-721 Task 12: the build rewrites the `src/` alias of static imports only, so `import('src/…')`
  // throws in the built server (vitest resolves the alias, so the other specs never saw it). The key
  // owners lookup swallowed the error: a job deferred for a Locked key named no owner, and a key load
  // never woke it.
  it('never imports through the src/ alias', async () => {
    const root = join(import.meta.dirname, '..');
    const offenders: string[] = [];
    for (const name of await fs.readdir(root, { recursive: true })) {
      if (!name.endsWith('.ts') || name.endsWith('.spec.ts')) {
        continue;
      }
      const text = await fs.readFile(join(root, name), 'utf8');
      // a runtime import (awaited or chained); `import('src/…').Type` in a type is erased
      if (/\bawait\s+import\(\s*['"`]src\/|\bimport\(\s*['"`]src\/[^'"`]*['"`]\s*\)\s*\.(?:then|catch)\b/.test(text)) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
