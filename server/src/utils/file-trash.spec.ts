import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorageRepository } from 'src/repositories/storage.repository.js';
import { moveFileWithin, storedCopyChecks, verifyStoredCopy } from 'src/utils/file-trash.js';

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest();
const crypto = {
  hashFileMatching: async (path: string, reference: Buffer) =>
    createHash(reference.length === 32 ? 'sha256' : 'sha1')
      .update(await fs.readFile(path))
      .digest(),
};

/** The storage calls the helpers make, on real files. */
const storageOn = () =>
  ({
    mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
    unlink: (path: string) => fs.unlink(path),
    createPlainReadStream: (path: string) => createReadStream(path),
    stat: (path: string) => fs.stat(path),
  }) as unknown as StorageRepository;

const exists = (path: string) =>
  fs
    .stat(path)
    .then(() => true)
    .catch(() => false);

describe('file trash moves and stored copies (FL-412)', () => {
  let directory: string;
  let source: string;
  const bytes = Buffer.from('the only copy of a photo');

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'fl412-'));
    source = join(directory, 'photo.jpg');
    await fs.writeFile(source, bytes);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  describe(moveFileWithin.name, () => {
    it('moves a file to a folder it creates, holding the same bytes', async () => {
      const target = join(directory, 'trash', 'photo.jpg');

      await moveFileWithin(storageOn(), source, target);

      await expect(fs.readFile(target)).resolves.toEqual(bytes);
      await expect(exists(source)).resolves.toBe(false);
      await expect(fs.readdir(join(directory, 'trash'))).resolves.toEqual(['photo.jpg']);
    });

    it('never replaces a different file at the destination, and keeps the source', async () => {
      const target = join(directory, 'trash', 'photo.jpg');
      await fs.mkdir(join(directory, 'trash'));
      await fs.writeFile(target, 'someone else');

      await expect(moveFileWithin(storageOn(), source, target)).rejects.toThrow('already holds a different file');

      await expect(fs.readFile(target, 'utf8')).resolves.toBe('someone else');
      await expect(fs.readFile(source)).resolves.toEqual(bytes);
    });
  });

  describe(verifyStoredCopy.name, () => {
    const storage = storageOn();

    it('proves a file that holds the bytes, by SHA-256, and returns its identity', async () => {
      const identity = await verifyStoredCopy(storage, crypto, source, {
        checksum: sha256(bytes),
        sizeInBytes: bytes.length,
      });

      expect(identity).toEqual(expect.any(String));
    });

    it('proves an older record by its SHA-1', async () => {
      const sha1 = createHash('sha1').update(bytes).digest();

      await expect(
        verifyStoredCopy(storage, crypto, source, { checksum: sha1, sizeInBytes: bytes.length }),
      ).resolves.toEqual(expect.any(String));
    });

    it('never proves a file with other bytes, another size, or no file at all', async () => {
      await expect(
        verifyStoredCopy(storage, crypto, source, { checksum: sha256('other'), sizeInBytes: bytes.length }),
      ).resolves.toBeNull();
      await expect(
        verifyStoredCopy(storage, crypto, source, { checksum: sha256(bytes), sizeInBytes: bytes.length + 1 }),
      ).resolves.toBeNull();
      await expect(
        verifyStoredCopy(storage, crypto, join(directory, 'gone.jpg'), {
          checksum: sha256(bytes),
          sizeInBytes: bytes.length,
        }),
      ).resolves.toBeNull();
    });

    it('never proves a file that changed while it was read', async () => {
      const changing = {
        hashFileMatching: async (path: string, reference: Buffer) => {
          const digest = await crypto.hashFileMatching(path, reference);
          await fs.utimes(path, new Date(), new Date(Date.now() + 60_000));
          return digest;
        },
      };

      await expect(
        verifyStoredCopy(storage, changing, source, { checksum: sha256(bytes), sizeInBytes: bytes.length }),
      ).resolves.toBeNull();
    });
  });

  describe(storedCopyChecks.name, () => {
    it('hears of a file that is there but holds other bytes, never of one that is gone', async () => {
      const onMismatch = vi.fn();
      const checks = storedCopyChecks(
        storageOn(),
        crypto,
        { checksum: sha256('other'), sizeInBytes: bytes.length },
        onMismatch,
      );

      await expect(checks.verify(source)).resolves.toBeNull();
      await expect(checks.verify(join(directory, 'gone.jpg'))).resolves.toBeNull();

      expect(onMismatch).toHaveBeenCalledExactlyOnceWith(source);
    });

    it('identifies the same unchanged file the same way, and a changed one differently', async () => {
      const checks = storedCopyChecks(
        storageOn(),
        crypto,
        { checksum: sha256(bytes), sizeInBytes: bytes.length },
        vi.fn(),
      );
      const proven = await checks.verify(source);

      await expect(checks.identify(source)).resolves.toBe(proven);
      await fs.utimes(source, new Date(), new Date(Date.now() + 60_000));
      await expect(checks.identify(source)).resolves.not.toBe(proven);
    });
  });
});
