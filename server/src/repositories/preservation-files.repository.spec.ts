import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StorageCore } from 'src/cores/storage.core.js';
import { PreservationFileRepository } from 'src/repositories/preservation-files.repository.js';
import { assertExecutionActive, operationExecution } from 'src/utils/execution-signal.js';
import { OperationClaimLostError } from 'src/utils/operation-execution.js';
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

  it.each(['copy', 'document', 'index'])(
    'a stopped %s cannot replace published bytes and removes its partial',
    async (kind) => {
      const source = join(root, 'source.jpg');
      const destination = join(root, 'package', 'result');
      await writeFile(source, 'original bytes');
      await mkdir(join(root, 'package'));
      await writeFile(destination, 'accepted bytes');
      const controller = new AbortController();
      const started = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const commit = async (write: () => Promise<void>) => {
        started.resolve();
        await released.promise;
        assertExecutionActive();
        await write();
      };
      const pages = Readable.from([['replacement']]);
      const work = operationExecution.run(
        { signal: controller.signal, progress: () => {}, settled: false, completed: new Map(), settle: async () => {} },
        () =>
          kind === 'copy'
            ? sut.copyOriginal(source, destination, commit)
            : kind === 'document'
              ? sut.writeDocument(destination, Buffer.from('replacement'), commit)
              : sut.writeLines(destination, pages, commit),
      );
      const rejected = expect(work).rejects.toBeInstanceOf(OperationClaimLostError);
      await started.promise;
      controller.abort(new OperationClaimLostError());
      released.resolve();
      await rejected;
      expect(await readFile(source, 'utf8')).toBe('original bytes');
      expect(await readFile(destination, 'utf8')).toBe('accepted bytes');
      expect(await readdir(join(root, 'package'))).toEqual(['result']);
    },
  );

  it.each(['sha1', 'sha256'] as const)(
    'reuses a renamed original after lost acknowledgement with %s verification',
    async (algorithm) => {
      const source = join(root, 'source.jpg');
      const destination = join(root, 'package', 'original.jpg');
      const bytes = Buffer.from('original bytes');
      await writeFile(source, bytes);
      const checksum = Buffer.from(digests(bytes)[algorithm], 'hex');
      const first = await sut.copyOriginal(source, destination, undefined, checksum);
      const before = await stat(destination);
      const commit = vi.fn(async (write: () => Promise<void>) => write());
      const second = await sut.copyOriginal(source, destination, commit, checksum);
      expect(second).toEqual(first);
      expect(commit).not.toHaveBeenCalled();
      expect((await stat(destination)).ino).toBe(before.ino);
      expect(await readdir(join(root, 'package'))).toEqual(['original.jpg']);
    },
  );

  it('does not reuse an existing copy with the wrong checksum', async () => {
    const source = join(root, 'source.jpg');
    const destination = join(root, 'package', 'original.jpg');
    const bytes = Buffer.from('original bytes');
    await writeFile(source, bytes);
    await mkdir(join(root, 'package'));
    await writeFile(destination, 'incorrect');
    const commit = vi.fn(async (write: () => Promise<void>) => write());
    await sut.copyOriginal(source, destination, commit, Buffer.from(digests(bytes).sha256, 'hex'));
    expect(commit).toHaveBeenCalledOnce();
    expect(await readFile(destination)).toEqual(bytes);
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
