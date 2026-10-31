import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LockedKeyFile } from '@frameleaf/locked-crypto';
import { StorageCore } from 'src/cores/storage.core.js';
import { LockedKeyRepository } from 'src/repositories/locked-key.repository.js';

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
  let sut: LockedKeyRepository;

  beforeEach(async () => {
    media = await fs.mkdtemp(join(tmpdir(), 'locked-keys-'));
    StorageCore.setMediaLocation(media);
    sut = new LockedKeyRepository();
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
