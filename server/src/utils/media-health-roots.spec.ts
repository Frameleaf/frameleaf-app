import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import {
  MANAGED_ROOT_ID,
  MediaHealthRoot,
  isPathWithin,
  libraryRootId,
  parseRecoveryRoots,
  publishVerifiedCopy,
  recoveryRootId,
  resolveInsideRoot,
  retainFile,
  rootForPath,
  rootKindOf,
} from 'src/utils/media-health-roots.js';

describe('media-health-roots (FL-69)', () => {
  describe(parseRecoveryRoots.name, () => {
    it('reads labelled and unlabelled locations', () => {
      expect(parseRecoveryRoots('Verified backup=/mnt/backup/photos; /mnt/photos/recovered/\n')).toEqual([
        { label: 'Verified backup', path: '/mnt/backup/photos' },
        { label: 'recovered', path: '/mnt/photos/recovered' },
      ]);
      expect(parseRecoveryRoots(undefined)).toEqual([]);
      expect(parseRecoveryRoots('  ')).toEqual([]);
    });

    it('refuses relative paths, the filesystem root and repeats', () => {
      expect(() => parseRecoveryRoots('Backup=backup/photos')).toThrow('absolute');
      expect(() => parseRecoveryRoots('/')).toThrow('filesystem root');
      expect(() => parseRecoveryRoots('/mnt/backup;/mnt/backup/')).toThrow('more than once');
    });
  });

  describe('root identity', () => {
    it('names a recovery location by its path, not its position', () => {
      expect(recoveryRootId('/mnt/backup/photos')).toBe(recoveryRootId('/mnt/backup/photos/'));
      expect(recoveryRootId('/mnt/backup/photos')).not.toBe(recoveryRootId('/mnt/backup/other'));
      expect(rootKindOf(recoveryRootId('/mnt/backup'))).toBe('recovery');
      expect(rootKindOf(libraryRootId('library-1'))).toBe('library');
      expect(rootKindOf(MANAGED_ROOT_ID)).toBe('managed');
      expect(rootKindOf('elsewhere')).toBeUndefined();
    });

    it('attributes a path to the most specific root that contains it', () => {
      const roots: MediaHealthRoot[] = [
        { id: MANAGED_ROOT_ID, kind: 'managed', label: 'Library storage', paths: ['/data/upload/user-1'] },
        { id: 'recovery:a', kind: 'recovery', label: 'Backup', paths: ['/mnt/backup'] },
        { id: 'recovery:b', kind: 'recovery', label: 'Nested', paths: ['/mnt/backup/2026'] },
      ];
      expect(rootForPath(roots, '/data/upload/user-1/a/b.jpg')?.id).toBe(MANAGED_ROOT_ID);
      expect(rootForPath(roots, '/mnt/backup/2025/a.jpg')?.id).toBe('recovery:a');
      expect(rootForPath(roots, '/mnt/backup/2026/a.jpg')?.id).toBe('recovery:b');
      expect(rootForPath(roots, '/mnt/backup-other/a.jpg')).toBeUndefined();
      expect(rootForPath(roots, '/mnt/backup/../escape.jpg')).toBeUndefined();
      expect(isPathWithin('/mnt/backup', '/mnt/backup')).toBe(false);
    });
  });

  describe('filesystem fixtures', () => {
    let root: string;
    let backup: string;
    const crypto = new CryptoRepository();
    const hash = (filePath: string) => crypto.hashFileDigests(filePath);
    const digestsOf = (bytes: Buffer) => ({
      sha1: createHash('sha1').update(bytes).digest(),
      sha256: createHash('sha256').update(bytes).digest(),
      sizeInBytes: bytes.length,
    });

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'library-care-roots-'));
      backup = join(root, 'backup');
      await mkdir(join(backup, 'nested'), { recursive: true });
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('resolves a regular file inside its root', async () => {
      const file = join(backup, 'nested', 'a.jpg');
      await writeFile(file, 'a');
      await expect(resolveInsideRoot(backup, file)).resolves.toMatch(/nested\/a\.jpg$/);
    });

    it('refuses a link, a link to a directory outside, a directory and a missing file', async () => {
      const outside = join(root, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'secret.jpg'), 'secret');
      await symlink(join(outside, 'secret.jpg'), join(backup, 'link.jpg'));
      await symlink(outside, join(backup, 'escape'));

      await expect(resolveInsideRoot(backup, join(backup, 'link.jpg'))).resolves.toBeUndefined();
      await expect(resolveInsideRoot(backup, join(backup, 'escape', 'secret.jpg'))).resolves.toBeUndefined();
      await expect(resolveInsideRoot(backup, join(backup, 'nested'))).resolves.toBeUndefined();
      await expect(resolveInsideRoot(backup, join(backup, 'missing.jpg'))).resolves.toBeUndefined();
    });

    it('publishes an exact copy and leaves the source untouched', async () => {
      const bytes = Buffer.from('original bytes');
      const source = join(backup, 'nested', 'a.jpg');
      await writeFile(source, bytes);
      const destination = join(root, 'media', '.library-care', 'asset-finding.jpg');

      await expect(publishVerifiedCopy({ source, destination, expected: digestsOf(bytes), hash })).resolves.toEqual(
        digestsOf(bytes),
      );
      await expect(readFile(destination)).resolves.toEqual(bytes);
      await expect(readFile(source)).resolves.toEqual(bytes);
    });

    it('accepts its own earlier copy but never overwrites a different file', async () => {
      const bytes = Buffer.from('original bytes');
      const source = join(backup, 'nested', 'a.jpg');
      await writeFile(source, bytes);
      const destination = join(root, 'media', 'asset-finding.jpg');
      await mkdir(join(root, 'media'));

      await writeFile(destination, bytes);
      await expect(publishVerifiedCopy({ source, destination, expected: digestsOf(bytes), hash })).resolves.toEqual(
        digestsOf(bytes),
      );

      await writeFile(destination, 'someone else’s file');
      await expect(publishVerifiedCopy({ source, destination, expected: digestsOf(bytes), hash })).rejects.toThrow(
        'does not match',
      );
      await expect(readFile(destination, 'utf8')).resolves.toBe('someone else’s file');
    });

    it('moves a retained file to a new name and never replaces a different file there', async () => {
      const source = join(root, 'damaged.jpg');
      const destination = join(root, 'media', '.library-care', 'asset-finding.damaged.jpg');
      await writeFile(source, 'damaged');

      await retainFile(source, destination);
      await expect(readFile(destination, 'utf8')).resolves.toBe('damaged');
      await expect(readFile(source)).rejects.toThrow();

      const other = join(root, 'other.jpg');
      await writeFile(other, 'other');
      await expect(retainFile(other, destination)).rejects.toThrow('different file');
      await expect(readFile(destination, 'utf8')).resolves.toBe('damaged');
      await expect(readFile(other, 'utf8')).resolves.toBe('other');
    });

    it('finishes a move that was interrupted after the new name was made', async () => {
      const source = join(root, 'damaged.jpg');
      const destination = join(root, 'asset-finding.damaged.jpg');
      await writeFile(source, 'damaged');
      await link(source, destination);

      await retainFile(source, destination);

      await expect(readFile(destination, 'utf8')).resolves.toBe('damaged');
      await expect(readFile(source)).rejects.toThrow();
    });

    it('refuses a source whose content is not the expected original', async () => {
      const source = join(backup, 'nested', 'a.jpg');
      await writeFile(source, 'similar name, different bytes');
      const destination = join(root, 'media', 'asset-finding.jpg');

      await expect(
        publishVerifiedCopy({ source, destination, expected: digestsOf(Buffer.from('original')), hash }),
      ).rejects.toThrow('does not match');
      // Nothing is published under the name, so a later attempt with the right copy can use it.
      await expect(readFile(destination)).rejects.toThrow();
    });
  });
});
