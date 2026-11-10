import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import {
  CloudBackupRestoreFile,
  CloudBackupRestoreResult,
  CloudBackupRestorer,
  emptyRestoreResult,
} from 'src/services/cloud-backup-restore.js';
import * as ownerPath from 'src/utils/cloud-backup-owner-path.js';
import { CloudBackupManifest } from 'src/utils/cloud-backup.js';
import { LOCKED_KEY_BACKUP_ROLE } from 'src/utils/locked-backup.js';
import { retainFile } from 'src/utils/media-health-roots.js';

// Real filesystem calls by default; single cases simulate a drive without hard links through `link`.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});
vi.mock('src/utils/media-health-roots.js', async (original) => {
  const module = await original<typeof import('src/utils/media-health-roots.js')>();
  return { ...module, retainFile: vi.fn(module.retainFile) };
});
vi.mock('src/utils/cloud-backup-owner-path.js', async (original) => {
  const module = await original<typeof import('src/utils/cloud-backup-owner-path.js')>();
  return { ...module, assertOwnerRestoreFile: vi.fn(module.assertOwnerRestoreFile) };
});

describe('admin restore publication on a real filesystem', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'cloud-restore-publication-'));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  const setup = () => {
    const target = join(folder, 'photo.jpg');
    const bytes = Buffer.from('backup');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const logger = LoggingRepository.create();
    const storage = new StorageRepository(logger);
    const file = {
      fileKey: 'asset:000',
      assetId: 'asset',
      role: 'original',
      sha256,
      size: bytes.length,
      target,
      inPlace: true,
    };
    const options = {
      manifest: { database: null } as CloudBackupManifest,
      scope: 'asset' as const,
      files: [file],
      destination: null,
      mediaLocation: folder,
      backupsFolder: folder,
      operationId: 'operation',
      start: emptyRestoreResult(),
      checkpoint: () => Promise.resolve(true),
      read: async (_key: string, staged: string) => {
        await writeFile(staged, bytes);
        return { size: bytes.length, sha256 };
      },
    };
    const sut = new CloudBackupRestorer(null, storage, new CryptoRepository(), logger);
    return { sut, storage, options, target };
  };

  it.each(['download', 'move-aside'])('preserves a new destination appearing during %s', async (phase) => {
    const { sut, options, target } = setup();
    if (phase === 'download') {
      const read = options.read;
      options.read = async (key, staged) => {
        const result = await read(key, staged);
        await writeFile(target, 'new occupant');
        return result;
      };
    } else {
      await writeFile(target, 'original occupant');
      const move = vi.mocked(retainFile).getMockImplementation()!;
      vi.mocked(retainFile).mockImplementationOnce(async (from, to) => {
        await move(from, to);
        if (from === target) await writeFile(target, 'new occupant');
      });
    }
    // refused as an owner restore refuses it (FL-1347): the link found the name taken by a different file
    await expect(sut.restore(options)).rejects.toMatchObject({
      message: expect.stringContaining('already holds a different file'),
      cause: { code: 'EEXIST' },
    });
    expect(await readFile(target, 'utf8')).toBe('new occupant');
    expect((await readdir(folder)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('retains every displaced version when the same admin restore is replayed', async () => {
    const { sut, options, target } = setup();
    await writeFile(target, 'first occupant');
    await sut.restore(options);
    await writeFile(target, 'second occupant');
    await sut.restore(options);
    const aside = join(folder, 'frameleaf/restore/replaced/operation');
    const entries = await readdir(aside, { recursive: true, withFileTypes: true });
    const contents = await Promise.all(
      entries.filter((entry) => entry.isFile()).map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
    );
    expect(contents.sort()).toEqual(['first occupant', 'second occupant']);
    expect(await readFile(target, 'utf8')).toBe('backup');
  });

  // FL-1320: <media>/thumbs can be its own drive. An owner restore stages in <media>/frameleaf/restore, so a
  // thumbnail staged there could never be renamed into place.
  it('puts an owner-restored thumbnail in place when the thumbnails folder is another drive', async () => {
    const { sut, options } = setup();
    const thumbs = join(folder, 'thumbs');
    const target = join(thumbs, 'owner', 'as', 'se', 'asset-thumbnail.webp');
    options.files = [{ ...options.files[0], role: 'thumbnail', target }];
    await sut.restore({ ...options, publish: (_file, _staged, publish) => publish() });
    expect(await readFile(target, 'utf8')).toBe('backup');
    expect((await readdir(join(thumbs, 'owner', 'as', 'se'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  // FL-1333: a move aside never replaces a file already at its name, and keeps what it was moving.
  it('refuses to move a file aside onto a different file, and leaves both as they were', async () => {
    const { sut, target } = setup();
    await writeFile(target, 'original occupant');
    const aside = join(folder, 'frameleaf/restore/replaced/operation/photo.jpg');
    await mkdir(join(folder, 'frameleaf/restore/replaced/operation'), { recursive: true });
    await writeFile(aside, 'already set aside');
    await expect(
      (sut as unknown as { moveAside: (...args: unknown[]) => Promise<void> }).moveAside(target, folder, 'operation'),
    ).rejects.toThrow('already holds a different file');
    expect(await readFile(target, 'utf8')).toBe('original occupant');
    expect(await readFile(aside, 'utf8')).toBe('already set aside');
  });

  it('never replaces a file that appears after the owner restore checked the destination', async () => {
    const { sut, options, target } = setup();
    let calls = 0;
    vi.mocked(ownerPath.assertOwnerRestoreFile).mockImplementation(async (...args) => {
      await vi
        .importActual<typeof import('src/utils/cloud-backup-owner-path.js')>('src/utils/cloud-backup-owner-path.js')
        .then((module) => module.assertOwnerRestoreFile(...args));
      // The checks run staged, target, target (empty), staged; a file appears once the last has passed.
      if (++calls === 4) await writeFile(target, 'new occupant');
    });
    await expect(sut.restore({ ...options, publish: (_file, _staged, publish) => publish() })).rejects.toThrow(
      'already holds a different file',
    );
    expect(await readFile(target, 'utf8')).toBe('new occupant');
    vi.mocked(ownerPath.assertOwnerRestoreFile).mockReset();
  });
});

// FL-1333: on a drive without hard links the verified staged file is copied into place, so the published file has
// an identity of its own. It is kept only as a copy of the checked bytes, and a resumed restore counts what an
// earlier attempt published as restored.
describe('owner restore publication on a drive without hard links (FL-1333)', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'cloud-restore-copy-'));
    vi.mocked(link).mockImplementation(() => Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' })));
  });
  afterEach(async () => {
    vi.mocked(link).mockReset();
    vi.mocked(retainFile).mockReset();
    await rm(folder, { recursive: true, force: true });
  });

  const owned = (count: number) => {
    const contents = new Map<string, Buffer>();
    const files: CloudBackupRestoreFile[] = [];
    for (let index = 1; index <= count; index++) {
      const bytes = Buffer.from(`backed-up photo ${index}`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      contents.set(sha256, bytes);
      files.push({
        fileKey: `asset-${index}:000`,
        assetId: `asset-${index}`,
        role: 'original',
        sha256,
        size: bytes.length,
        target: join(folder, 'library', `photo-${index}.jpg`),
        inPlace: true,
      });
    }
    const logger = LoggingRepository.create();
    const sut = new CloudBackupRestorer(null, new StorageRepository(logger), new CryptoRepository(), logger);
    const options = {
      manifest: { database: null } as CloudBackupManifest,
      scope: 'asset' as const,
      files,
      destination: null,
      mediaLocation: folder,
      backupsFolder: folder,
      operationId: 'operation',
      start: emptyRestoreResult(),
      checkpoint: (_result: CloudBackupRestoreResult) => Promise.resolve(true),
      read: async (_key: string, staged: string, sha256: string) => {
        const bytes = contents.get(sha256)!;
        await writeFile(staged, bytes);
        return { size: bytes.length, sha256 };
      },
      publish: (
        _file: CloudBackupRestoreFile,
        _staged: string,
        publish: () => Promise<'written' | 'skipped' | 'replaced'>,
      ) => publish(),
    };
    return { sut, options, files, contents };
  };

  it('completes an owner publish that had to copy, and lists the item for new thumbnails', async () => {
    const { sut, options, files } = owned(1);

    const result = await sut.restore(options);

    expect(result).toMatchObject({ files: 1, skipped: 0, replaced: 0, restoredAssetIds: ['asset-1'] });
    expect(await readFile(files[0].target, 'utf8')).toBe('backed-up photo 1');
    expect((await lstat(files[0].target)).nlink).toBe(1);
    // the copy was forced: hard links were refused
    expect(link).toHaveBeenCalled();
    expect(await readdir(join(folder, 'frameleaf/restore/operation/staging'))).toEqual([]);
  });

  it.each([
    { label: 'the same size', bytes: 'backed-up photo X' },
    { label: 'another size', bytes: 'a different photo altogether' },
  ])('still refuses a copied file whose bytes are not the backed-up ones ($label)', async ({ bytes }) => {
    const { sut, options, files } = owned(1);
    const retain = vi.mocked(retainFile).getMockImplementation()!;
    vi.mocked(retainFile).mockImplementationOnce(async (from, to) => {
      await retain(from, to);
      // the file at the target changes between the copy and its check
      await writeFile(to, bytes);
    });

    await expect(sut.restore(options)).rejects.toThrow('Owner restore original changed');
    expect(await readFile(files[0].target, 'utf8')).toBe(bytes);
  });

  it('resumes after a failure at file 2 of 3 and completes all three in one run', async () => {
    const { sut, options, files, contents } = owned(3);
    let saved = emptyRestoreResult();
    let failAfterSecond = true;
    const checkpoint = (result: CloudBackupRestoreResult) => {
      // the operation row is lost once the second file is in place, before it is recorded
      if (failAfterSecond && result.cursor === files[1].fileKey) {
        return Promise.reject(new Error('connection lost'));
      }
      saved = structuredClone(result);
      return Promise.resolve(true);
    };

    await expect(sut.restore({ ...options, checkpoint })).rejects.toThrow('connection lost');
    expect(await readFile(files[1].target, 'utf8')).toBe('backed-up photo 2');
    // what was saved: file 1 counted, and file 2's publication begun
    expect(saved).toMatchObject({
      cursor: files[0].fileKey,
      restoredAssetIds: ['asset-1'],
      publishing: { fileKey: files[1].fileKey, outcome: 'written' },
    });

    failAfterSecond = false;
    const result = await sut.restore({ ...options, start: saved, checkpoint });

    expect(result).toMatchObject({
      files: 3,
      skipped: 0,
      replaced: 0,
      restoredAssetIds: ['asset-1', 'asset-2', 'asset-3'],
    });
    expect(result).not.toHaveProperty('publishing');
    for (const file of files) {
      expect(await readFile(file.target)).toEqual(contents.get(file.sha256));
    }
  });

  it('publishes nothing when the restore is stopped just before a publication', async () => {
    const { sut, options, files } = owned(1);
    const checkpoint = vi.fn((result: CloudBackupRestoreResult) => Promise.resolve(!result.publishing));

    await expect(sut.restore({ ...options, checkpoint })).resolves.toBeNull();

    expect(checkpoint).toHaveBeenCalledOnce();
    await expect(lstat(files[0].target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(folder, 'frameleaf/restore/operation/staging'))).toEqual([]);
  });

  it('still counts a file that was already in place before the restore as skipped', async () => {
    const { sut, options, files } = owned(1);
    await mkdir(join(folder, 'library'), { recursive: true });
    await writeFile(files[0].target, 'backed-up photo 1');
    const checkpoint = vi.fn((_result: CloudBackupRestoreResult) => Promise.resolve(true));

    const result = await sut.restore({ ...options, checkpoint });

    expect(result).toMatchObject({ files: 1, skipped: 1, restoredAssetIds: [] });
    // nothing was published, so nothing was recorded as being published
    for (const [saved] of checkpoint.mock.calls) {
      expect(saved).not.toHaveProperty('publishing');
    }
  });

  it('completes a Buddy restore that had to copy beside its target', async () => {
    const { sut, options, files } = owned(1);

    const result = await sut.restore({
      ...options,
      stageBesideTarget: true,
      publish: (_file, _staged, publish, phase) => (phase === 'inspect' ? Promise.resolve('skipped') : publish()),
    });

    expect(result).toMatchObject({ files: 1, skipped: 0, restoredAssetIds: ['asset-1'] });
    expect(await readFile(files[0].target, 'utf8')).toBe('backed-up photo 1');
    expect(await readdir(join(folder, 'library'))).toEqual(['photo-1.jpg']);
  });
});

// FL-1347: an admin restore (not the photo's owner) places its files as an owner restore does: link first, and on a
// drive without hard links a copy, checked byte for byte before the staged file goes. It never replaces a file.
describe('admin restore on a drive without hard links (FL-1347)', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'cloud-restore-admin-copy-'));
    vi.mocked(link).mockImplementation(() => Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' })));
  });
  afterEach(async () => {
    vi.mocked(link).mockReset();
    vi.mocked(retainFile).mockReset();
    await rm(folder, { recursive: true, force: true });
  });

  const setup = (role = 'original', target = join(folder, 'library', 'photo.jpg')) => {
    const bytes = Buffer.from('backed-up photo');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const logger = LoggingRepository.create();
    const sut = new CloudBackupRestorer(null, new StorageRepository(logger), new CryptoRepository(), logger);
    const options = {
      manifest: { database: null } as CloudBackupManifest,
      scope: 'asset' as const,
      files: [{ fileKey: 'asset:000', assetId: 'asset', role, sha256, size: bytes.length, target, inPlace: true }],
      destination: null,
      mediaLocation: folder,
      backupsFolder: folder,
      operationId: 'operation',
      start: emptyRestoreResult(),
      checkpoint: () => Promise.resolve(true),
      read: async (_key: string, staged: string) => {
        await writeFile(staged, bytes);
        return { size: bytes.length, sha256 };
      },
    };
    return { sut, options, target };
  };
  const leftovers = async (target: string) =>
    (await readdir(dirname(target))).filter((name) => name.endsWith('.tmp') || name.endsWith('.partial'));

  it('copies a file into place where it cannot be linked', async () => {
    const { sut, options, target } = setup();

    await expect(sut.restore(options)).resolves.toMatchObject({ files: 1, skipped: 0, replaced: 0 });

    expect(await readFile(target, 'utf8')).toBe('backed-up photo');
    expect((await lstat(target)).nlink).toBe(1);
    // the copy was forced: hard links were refused
    expect(link).toHaveBeenCalled();
    expect(await leftovers(target)).toEqual([]);
  });

  it('moves a different file aside by copy too, and puts the backed-up one in its place', async () => {
    const { sut, options, target } = setup();
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'a different photo');

    await expect(sut.restore(options)).resolves.toMatchObject({ files: 1, replaced: 1 });

    expect(await readFile(target, 'utf8')).toBe('backed-up photo');
    const aside = await readdir(join(folder, 'frameleaf/restore/replaced/operation'), {
      recursive: true,
      withFileTypes: true,
    });
    const contents = await Promise.all(
      aside.filter((entry) => entry.isFile()).map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
    );
    expect(contents).toEqual(['a different photo']);
    expect(await leftovers(target)).toEqual([]);
  });

  it('never replaces a file that appears while the backed-up one downloads', async () => {
    const { sut, options, target } = setup();
    const read = options.read;
    options.read = async (key, staged) => {
      const result = await read(key, staged);
      await writeFile(target, 'new occupant');
      return result;
    };

    await expect(sut.restore(options)).rejects.toThrow('already holds a different file');

    expect(await readFile(target, 'utf8')).toBe('new occupant');
    expect(await leftovers(target)).toEqual([]);
  });

  it('keeps a restored Locked key file for the server alone', async () => {
    const { sut, options, target } = setup(LOCKED_KEY_BACKUP_ROLE, join(folder, 'keys', 'owner.key'));

    await expect(sut.restore(options)).resolves.toMatchObject({ files: 1 });

    expect(await readFile(target, 'utf8')).toBe('backed-up photo');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await leftovers(target)).toEqual([]);
  });
});
