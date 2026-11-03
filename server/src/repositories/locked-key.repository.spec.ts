import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockedKeyFile } from '@frameleaf/locked-crypto';
import type { ConfigRepository } from 'src/repositories/config.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import {
  LOCKED_PEPPER_FILE,
  LockedKeyRepository,
  LockedPepperFileError,
} from 'src/repositories/locked-key.repository.js';

const userId = '7d3c2a1e-4b5f-4c6d-8e9f-0a1b2c3d4e5f';

const keyFile = (overrides: Partial<LockedKeyFile> = {}): LockedKeyFile => ({
  format: 'frameleaf-locked-key/1',
  userId,
  label: 'Taylor',
  publicKey: Buffer.alloc(32, 1).toString('base64'),
  mode: 'pin',
  encrypting: true,
  wraps: [
    {
      kind: 'pin',
      kdf: 'scrypt',
      N: 131_072,
      r: 8,
      p: 1,
      salt: Buffer.alloc(16, 2).toString('base64'),
      nonce: Buffer.alloc(12, 3).toString('base64'),
      ciphertext: Buffer.alloc(48, 4).toString('base64'),
    },
  ],
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
  ...overrides,
});

describe(LockedKeyRepository.name, () => {
  let media: string;
  let identityDir: string | null;
  let sut: LockedKeyRepository;

  const config = () => ({ getEnv: () => ({ frameleafCloud: { identityDir } }) }) as unknown as ConfigRepository;

  beforeEach(async () => {
    media = await fs.mkdtemp(join(tmpdir(), 'locked-keys-'));
    identityDir = null;
    StorageCore.setMediaLocation(media);
    sut = new LockedKeyRepository(config());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    StorageCore.reset();
    await fs.rm(media, { recursive: true, force: true });
  });

  it('write then read returns the same object', async () => {
    const file = keyFile();
    await sut.write(file);
    await expect(sut.read(userId)).resolves.toEqual(file);
    await expect(sut.list()).resolves.toEqual([file]);
  });

  it('exists is true for any key file, even one read() cannot use, and false when there is none', async () => {
    await expect(sut.exists(userId)).resolves.toBe(false);
    await fs.mkdir(join(media, 'locked-keys'), { recursive: true });
    await fs.writeFile(join(media, 'locked-keys', `${userId}.json`), JSON.stringify({ format: 'something-else' }));
    await expect(sut.read(userId)).resolves.toBeNull();
    await expect(sut.exists(userId)).resolves.toBe(true);
    await sut.write(keyFile());
    await expect(sut.exists(userId)).resolves.toBe(true);
  });

  it('userIds names every key file on disk, readable or not', async () => {
    await expect(sut.userIds()).resolves.toEqual([]);
    await fs.mkdir(join(media, 'locked-keys'), { recursive: true });
    await fs.writeFile(join(media, 'locked-keys', `${userId}.json`), 'not json');
    await fs.writeFile(join(media, 'locked-keys', 'notes.txt'), '');
    await expect(sut.userIds()).resolves.toEqual([userId]);
    await expect(sut.list()).resolves.toEqual([]);
  });

  it('reads null when no key file exists', async () => {
    await expect(sut.read(userId)).resolves.toBeNull();
    await expect(sut.list()).resolves.toEqual([]);
  });

  it('file mode is 0600', async () => {
    await sut.write(keyFile());
    const stat = await fs.stat(join(media, 'locked-keys', `${userId}.json`));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('a crash between tmp write and rename leaves the old file readable', async () => {
    const old = keyFile();
    await sut.write(old);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('crash'));

    await expect(sut.write(keyFile({ mode: 'advanced', updatedAt: '2026-11-01T00:00:00.000Z' }))).rejects.toThrow(
      'crash',
    );

    await expect(sut.read(userId)).resolves.toEqual(old);
  });

  it('removeStaleTemp removes temporary files left by a crash', async () => {
    await sut.write(keyFile());
    await fs.writeFile(join(media, 'locked-keys', `${userId}.json.abc.tmp`), 'partial');

    await expect(sut.removeStaleTemp()).resolves.toBe(1);
    await expect(fs.readdir(join(media, 'locked-keys'))).resolves.toEqual([`${userId}.json`]);
    await expect(sut.removeStaleTemp()).resolves.toBe(0);
  });

  it('delete removes the file', async () => {
    await sut.write(keyFile());
    const writeFile = vi.spyOn(fs, 'open');

    await sut.delete(userId);

    expect(writeFile).toHaveBeenCalledWith(join(media, 'locked-keys', `${userId}.json`), 'r+');
    await expect(sut.read(userId)).resolves.toBeNull();
    await expect(sut.delete(userId)).resolves.toBeUndefined();
  });

  it('delete overwrites every byte even when the disk takes a few at a time', async () => {
    await sut.write(keyFile());
    const path = join(media, 'locked-keys', `${userId}.json`);
    const original = await fs.readFile(path);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      const write = handle.write.bind(handle) as (...args: unknown[]) => Promise<unknown>;
      handle.write = ((buffer: Buffer, offset: number, length: number, position: number) =>
        write(buffer, offset, Math.min(length, 7), position)) as typeof handle.write;
      return handle;
    });
    const unlink = fs.unlink.bind(fs);
    let overwritten: Buffer | undefined;
    vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
      overwritten = await fs.readFile(target);
      return unlink(target);
    });

    await sut.delete(userId);

    expect(overwritten).toHaveLength(original.length);
    expect(overwritten!.toString('latin1')).not.toContain('frameleaf-locked-key');
    expect(overwritten!.subarray(-7).equals(original.subarray(-7))).toBe(false);
  });

  it('reads a format-2 key file (peppered PIN wrap)', async () => {
    const file = keyFile({
      format: 'frameleaf-locked-key/2',
      wraps: [{ ...keyFile().wraps[0], pepper: { kdf: 'hkdf-sha256', id: Buffer.alloc(8, 9).toString('base64') } }],
    });
    await sut.write(file);
    await expect(sut.read(userId)).resolves.toEqual(file);
  });

  describe('pepper', () => {
    it('is made once, as 32 base64 bytes in a 0600 file in the identity directory, and read back by every instance', async () => {
      const pepper = await sut.pepper();
      expect(pepper).toHaveLength(32);
      const path = join(media, 'frameleaf', 'identity', LOCKED_PEPPER_FILE);
      const stat = await fs.stat(path);
      expect(stat.mode & 0o777).toBe(0o600);
      expect((await fs.stat(join(media, 'frameleaf', 'identity'))).mode & 0o777).toBe(0o700);
      await expect(fs.readFile(path, 'utf8')).resolves.toBe(`${pepper.toString('base64')}\n`);
      expect(await sut.pepper()).toEqual(pepper);
      expect(await new LockedKeyRepository(config()).pepper()).toEqual(pepper);
      // never under locked-keys: a copy of the key files must not carry it
      await expect(fs.readdir(join(media, 'locked-keys')).catch(() => [])).resolves.toEqual([]);
    });

    it('lives in FRAMELEAF_IDENTITY_DIR when that is set, off the media root', async () => {
      identityDir = await fs.mkdtemp(join(tmpdir(), 'locked-identity-'));
      try {
        const pepper = await sut.pepper();
        await expect(fs.readFile(join(identityDir, LOCKED_PEPPER_FILE), 'utf8')).resolves.toBe(
          `${pepper.toString('base64')}\n`,
        );
        await expect(fs.stat(join(media, 'frameleaf'))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await fs.rm(identityDir, { recursive: true, force: true });
      }
    });

    it('reads a pepper an operator restored, and refuses a damaged one instead of replacing it', async () => {
      const directory = join(media, 'frameleaf', 'identity');
      await fs.mkdir(directory, { recursive: true });
      const restored = Buffer.alloc(32, 5);
      await fs.writeFile(join(directory, LOCKED_PEPPER_FILE), `${restored.toString('base64')}\n`);
      expect(await sut.pepper()).toEqual(restored);

      await fs.writeFile(join(directory, LOCKED_PEPPER_FILE), 'not base64 at all!!\n');
      const fresh = new LockedKeyRepository(config());
      await expect(fresh.pepper()).rejects.toThrow(/damaged/);
      await expect(fresh.pepper()).rejects.toMatchObject({ name: 'LockedPepperFileError', reason: 'damaged' });
      await expect(fs.readFile(join(directory, LOCKED_PEPPER_FILE), 'utf8')).resolves.toBe('not base64 at all!!\n');
      await fs.writeFile(join(directory, LOCKED_PEPPER_FILE), `${Buffer.alloc(8, 1).toString('base64')}\n`);
      await expect(fresh.pepper()).rejects.toThrow(/damaged/);
      // a failure is not remembered
      await fs.writeFile(join(directory, LOCKED_PEPPER_FILE), `${restored.toString('base64')}\n`);
      expect(await fresh.pepper()).toEqual(restored);
    });

    it('refuses to make a pepper while a key file holds a wrap made with the lost one', async () => {
      const peppered = keyFile({
        format: 'frameleaf-locked-key/2',
        wraps: [{ ...keyFile().wraps[0], pepper: { kdf: 'hkdf-sha256', id: Buffer.alloc(8, 9).toString('base64') } }],
      });
      await sut.write(peppered);
      // another person's unpeppered file does not hide the peppered one
      await sut.write(keyFile({ userId: 'a1b2c3d4-0000-4000-8000-000000000001' }));
      const path = join(media, 'frameleaf', 'identity', LOCKED_PEPPER_FILE);

      await expect(sut.pepper()).rejects.toThrow(/missing.*Restore it from a backup/);
      await expect(sut.pepper()).rejects.toBeInstanceOf(LockedPepperFileError);
      await expect(sut.pepper()).rejects.toMatchObject({ reason: 'missing', message: expect.stringContaining(path) });
      await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      // the operator restores the file; nothing is remembered from the failure
      await fs.mkdir(join(path, '..'), { recursive: true });
      const restored = Buffer.alloc(32, 5);
      await fs.writeFile(path, `${restored.toString('base64')}\n`);
      expect(await sut.pepper()).toEqual(restored);
    });

    it('makes a pepper when the key files hold only unpeppered (format-1) wraps', async () => {
      await sut.write(keyFile());
      const pepper = await sut.pepper();
      expect(pepper).toHaveLength(32);
      await expect(fs.readFile(join(media, 'frameleaf', 'identity', LOCKED_PEPPER_FILE), 'utf8')).resolves.toBe(
        `${pepper.toString('base64')}\n`,
      );
    });

    it('two workers making the pepper at once end with one pepper', async () => {
      const other = new LockedKeyRepository(config());
      const [a, b] = await Promise.all([sut.pepper(), other.pepper()]);
      expect(a).toEqual(b);
    });
  });

  it('reads null for a file that is not a version-1 key file for that person', async () => {
    const other = 'a1b2c3d4-0000-4000-8000-000000000001';
    await sut.write(keyFile());
    await sut.write(keyFile({ userId: other }));
    const directory = join(media, 'locked-keys');
    await fs.writeFile(join(directory, `${other}.json`), JSON.stringify(keyFile({ userId })));
    const third = 'a1b2c3d4-0000-4000-8000-000000000002';
    await fs.writeFile(
      join(directory, `${third}.json`),
      JSON.stringify({ ...keyFile({ userId: third }), format: 'x/2' }),
    );
    const broken = 'a1b2c3d4-0000-4000-8000-000000000003';
    await fs.writeFile(join(directory, `${broken}.json`), '{ not json');

    await expect(sut.read(other)).resolves.toBeNull();
    await expect(sut.read(third)).resolves.toBeNull();
    await expect(sut.list()).resolves.toEqual([keyFile()]);
  });

  it('keeps the key folder private even if it already existed wider', async () => {
    const directory = join(media, 'locked-keys');
    await fs.mkdir(directory, { mode: 0o755 });
    await fs.chmod(directory, 0o755);

    await sut.write(keyFile());

    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('refuses a user id that is not a UUID', async () => {
    await expect(sut.read('../etc/passwd')).rejects.toThrow('Invalid user id');
    await expect(sut.write(keyFile({ userId: '../x' }))).rejects.toThrow('Invalid user id');
  });
});
