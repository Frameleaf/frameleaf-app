import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { CloudBackupRestorer, emptyRestoreResult } from 'src/services/cloud-backup-restore.js';
import { CloudBackupManifest } from 'src/utils/cloud-backup.js';

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
    const logger = new LoggingRepository();
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
    const { sut, storage, options, target } = setup();
    if (phase === 'download') {
      const read = options.read;
      options.read = async (key, staged) => {
        const result = await read(key, staged);
        await writeFile(target, 'new occupant');
        return result;
      };
    } else {
      await writeFile(target, 'original occupant');
      const rename = storage.rename.bind(storage);
      vi.spyOn(storage, 'rename').mockImplementation(async (from, to) => {
        await rename(from, to);
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
});
