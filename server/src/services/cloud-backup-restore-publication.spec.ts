import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { CloudBackupRestorer, emptyRestoreResult } from 'src/services/cloud-backup-restore.js';
import * as ownerPath from 'src/utils/cloud-backup-owner-path.js';
import { CloudBackupManifest } from 'src/utils/cloud-backup.js';
import { retainFile } from 'src/utils/media-health-roots.js';

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
    await expect(sut.restore(options)).rejects.toMatchObject({ code: 'EEXIST' });
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
