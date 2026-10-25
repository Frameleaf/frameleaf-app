import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { BuddyBackupRestoreService } from 'src/services/buddy-backup-restore.service.js';
import { CloudBackupRestorer, emptyRestoreResult } from 'src/services/cloud-backup-restore.js';
import { assertOwnerRestoreFile } from 'src/utils/cloud-backup-owner-path.js';
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

  it.each(['written', 'replaced', 'skipped'] as const)(
    'passes verified staging evidence to the Buddy worker for a %s publication',
    async (outcome) => {
      const { sut, options, target } = setup();
      if (outcome !== 'written') await writeFile(target, outcome === 'skipped' ? 'backup' : 'old');
      const worker = Object.create(BuddyBackupRestoreService.prototype);
      let publications = 0;
      await sut.restore({
        ...options,
        publish: async (file, staged, publish, phase, proof) => {
          if (phase === 'inspect') {
            expect(proof).toBeUndefined();
            return publish();
          }
          publications++;
          expect(proof).toMatchObject({ identity: expect.any(String), sha256: file.sha256, size: file.size });
          await assertOwnerRestoreFile(staged, proof!.identity);
          const result = await worker.publishStaged(file, staged, publish, proof);
          expect(result).toBe(outcome);
          return result;
        },
      });
      expect(publications).toBe(1);
      expect(await readFile(target, 'utf8')).toBe('backup');
    },
  );

  it.each(['missing', 'hash', 'size', 'identity'] as const)(
    'refuses %s staging proof at the Buddy publication boundary',
    async (change) => {
      const { sut, options, target } = setup();
      await writeFile(target, 'old');
      const worker = Object.create(BuddyBackupRestoreService.prototype);
      let published = false;
      await expect(
        sut.restore({
          ...options,
          publish: async (file, staged, publish, phase, proof) => {
            if (phase === 'inspect') return publish();
            const changed =
              change === 'missing'
                ? undefined
                : { ...proof!, [change === 'hash' ? 'sha256' : change]: change === 'size' ? 0 : 'changed' };
            return worker.publishStaged(
              file,
              staged,
              async () => {
                published = true;
                return publish();
              },
              changed,
            );
          },
        }),
      ).rejects.toThrow(
        change === 'identity' ? 'Owner restore original changed' : 'Buddy restore staging proof changed',
      );
      expect(published).toBe(false);
      expect(await readFile(target, 'utf8')).toBe('old');
    },
  );

  it.each(['staged', 'published'] as const)(
    'refuses substitution of the %s inode even when the replacement has identical bytes',
    async (phaseToChange) => {
      const { sut, options } = setup();
      const worker = Object.create(BuddyBackupRestoreService.prototype);
      let published = false;
      await expect(
        sut.restore({
          ...options,
          publish: async (file, staged, publish, phase, proof) => {
            if (phase === 'inspect') return publish();
            const substitute = async (path: string) => {
              const replacement = join(folder, 'substitute');
              await writeFile(replacement, 'backup');
              await rename(replacement, path);
            };
            if (phaseToChange === 'staged') await substitute(staged);
            return worker.publishStaged(
              file,
              staged,
              async () => {
                const result = await publish();
                published = true;
                if (phaseToChange === 'published') await substitute(file.target);
                return result;
              },
              proof,
            );
          },
        }),
      ).rejects.toThrow('Owner restore original changed');
      expect(published).toBe(phaseToChange === 'published');
    },
  );

  it('verifies actual staging bytes before issuing proof even when the reader reports the expected hash', async () => {
    const { sut, options, target } = setup();
    await writeFile(target, 'old');
    const publish = vi.fn((_file, _staged, commit) => commit());
    const read = options.read;
    options.read = async (key, staged) => {
      const reported = await read(key, staged);
      await writeFile(staged, 'forged');
      return reported;
    };
    await expect(sut.restore({ ...options, publish })).rejects.toThrow(
      'Owner restore staging size or checksum mismatch',
    );
    expect(publish.mock.calls).toHaveLength(1);
    expect(await readFile(target, 'utf8')).toBe('old');
  });

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
