import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { PreservationFileRepository } from 'src/repositories/preservation-files.repository.js';
import { PreservationPackageError } from 'src/utils/preservation.js';

const digests = (bytes: Buffer) => ({
  sha1: createHash('sha1').update(bytes).digest('hex'),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  bytes: bytes.length,
});

describe(PreservationFileRepository.name, () => {
  let sut: PreservationFileRepository;
  let root: string;

  beforeEach(async () => {
    sut = new PreservationFileRepository();
    root = await mkdtemp(join(tmpdir(), 'preservation-'));
    StorageCore.setMediaLocation(join(root, 'media'));
    await mkdir(join(root, 'media'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('copyOriginal', () => {
    it('copies the original and measures exactly what it copied', async () => {
      const bytes = Buffer.from('original bytes');
      await writeFile(join(root, 'lake.jpg'), bytes);

      const result = await sut.copyOriginal(join(root, 'lake.jpg'), join(root, 'package', 'originals', 'a.jpg'));

      expect(result).toEqual(digests(bytes));
      expect(await readFile(join(root, 'package', 'originals', 'a.jpg'))).toEqual(bytes);
      // Nothing half-written is left beside it.
      expect(await readdir(join(root, 'package', 'originals'))).toEqual(['a.jpg']);
    });

    it('refuses to follow a symbolic link to the original', async () => {
      await writeFile(join(root, 'secret.jpg'), 'secret');
      await symlink(join(root, 'secret.jpg'), join(root, 'link.jpg'));
      await expect(sut.copyOriginal(join(root, 'link.jpg'), join(root, 'package', 'a.jpg'))).rejects.toBeDefined();
    });
  });

  describe('directory packages', () => {
    const write = async (name: string, bytes: Buffer | string) => {
      await mkdir(join(root, 'package', name, '..'), { recursive: true });
      await writeFile(join(root, 'package', name), bytes);
    };

    it('streams a member through both digests', async () => {
      const bytes = Buffer.from('photo');
      await write('originals/a.jpg', bytes);
      const source = await sut.openPackage('directory', join(root, 'package'));

      expect(await source.stream('originals/a.jpg')).toEqual(digests(bytes));
      expect(await source.has('originals/b.jpg')).toBe(false);
      expect(await source.listEntries()).toEqual(['originals/a.jpg']);
    });

    it('refuses traversal and a symbolic-linked member at any level', async () => {
      await writeFile(join(root, 'outside.json'), '{}');
      await mkdir(join(root, 'package'), { recursive: true });
      await symlink(root, join(root, 'package', 'metadata'));
      const source = await sut.openPackage('directory', join(root, 'package'));

      await expect(source.readDocument('../outside.json', 1024)).rejects.toBeInstanceOf(PreservationPackageError);
      await expect(source.readDocument('metadata/outside.json', 1024)).rejects.toMatchObject({
        code: 'package_entry_link',
      });
    });

    it('refuses a document larger than it may be', async () => {
      await write('albums.json', 'x'.repeat(2048));
      const source = await sut.openPackage('directory', join(root, 'package'));
      await expect(source.readDocument('albums.json', 1024)).rejects.toMatchObject({ code: 'package_too_large' });
    });
  });

  describe('extractVerified', () => {
    it('keeps a copy only when it matches its checksum', async () => {
      const bytes = Buffer.from('photo');
      await mkdir(join(root, 'package', 'originals'), { recursive: true });
      await writeFile(join(root, 'package', 'originals', 'a.jpg'), bytes);
      const source = await sut.openPackage('directory', join(root, 'package'));

      await sut.extractVerified(source, 'originals/a.jpg', join(root, 'upload', 'a.jpg'), digests(bytes));
      expect(await readFile(join(root, 'upload', 'a.jpg'))).toEqual(bytes);

      await expect(
        sut.extractVerified(source, 'originals/a.jpg', join(root, 'upload', 'b.jpg'), digests(Buffer.from('other'))),
      ).rejects.toMatchObject({ code: 'original_changed' });
      expect(await readdir(join(root, 'upload'))).toEqual(['a.jpg']);
    });
  });

  describe('lines', () => {
    it('writes an index atomically and reads it back line by line with its digest', async () => {
      const pages = [['{"a":1}', '{"b":2}'], [], ['{"c":3}']];
      const indexPages: AsyncIterable<string[]> = {
        [Symbol.asyncIterator]: () => {
          let next = 0;
          return {
            next: () =>
              Promise.resolve(
                next < pages.length
                  ? { value: pages[next++], done: false as const }
                  : { value: undefined, done: true as const },
              ),
          };
        },
      };
      const written = await sut.writeLines(join(root, 'package', 'assets.jsonl'), indexPages);
      expect(written.lines).toBe(3);

      const source = await sut.openPackage('directory', join(root, 'package'));
      const lines: string[] = [];
      const read = await sut.readLines(source, 'assets.jsonl', 1024, (line) => {
        lines.push(line);
        return Promise.resolve();
      });

      expect(lines.filter(Boolean)).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
      expect(read).toEqual({ sha256: written.sha256, bytes: written.bytes });
    });

    it('refuses an index line longer than it may be', async () => {
      await mkdir(join(root, 'package'), { recursive: true });
      await writeFile(join(root, 'package', 'assets.jsonl'), `${'x'.repeat(4096)}\n`);
      const source = await sut.openPackage('directory', join(root, 'package'));
      await expect(sut.readLines(source, 'assets.jsonl', 1024, () => Promise.resolve())).rejects.toMatchObject({
        code: 'package_index_invalid',
      });
    });
  });

  describe('resolveServerPackage', () => {
    it('accepts a package directory or ZIP outside media storage', async () => {
      await mkdir(join(root, 'backups', 'italy'), { recursive: true });
      await writeFile(join(root, 'backups', 'italy.zip'), 'zip');
      expect(await sut.resolveServerPackage(join(root, 'backups', 'italy'))).toMatchObject({ format: 'directory' });
      const zip = await sut.resolveServerPackage(join(root, 'backups', 'italy.zip'));
      expect(zip).toMatchObject({ format: 'zip', size: 3 });
    });

    it('refuses media storage itself, anything inside it, a link and a missing path', async () => {
      await mkdir(join(root, 'media', 'library'), { recursive: true });
      await expect(sut.resolveServerPackage(join(root, 'media', 'library'))).rejects.toMatchObject({
        code: 'package_path_managed',
      });
      await expect(sut.resolveServerPackage(root)).rejects.toMatchObject({ code: 'package_path_managed' });
      await symlink(join(root, 'media'), join(root, 'alias'));
      await expect(sut.resolveServerPackage(join(root, 'alias'))).rejects.toMatchObject({ code: 'package_path_link' });
      await expect(sut.resolveServerPackage(join(root, 'nothing'))).rejects.toMatchObject({
        code: 'package_path_missing',
      });
    });
  });
});
