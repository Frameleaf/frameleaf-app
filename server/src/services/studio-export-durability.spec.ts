import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { StudioExportLibrarySave, StudioExportVersion } from 'src/repositories/studio-export.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { StudioExportScope, StudioExportVersionState } from 'src/enum.js';
import { StudioExportRefusal } from 'src/repositories/studio-export.repository.js';
import { StudioExportService } from 'src/services/studio-export.service.js';
import { captureOwnerRestoreFile } from 'src/utils/cloud-backup-owner-path.js';
import { studioExportLibraryPath, studioExportProjectPath } from 'src/utils/studio-export.js';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  open: vi.fn(),
}));

describe('paired publication directory durability', () => {
  it.each([
    'success',
    'absent nested',
    'nested parent failure',
    'recovered final',
    'forward failure',
    'rollback failure',
  ] as const)('%s synchronizes both renamed directories before settling', async (scenario) => {
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'studio-sync-'));
    const events: string[] = [];
    let syncs = 0;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await real.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        events.push(`sync:${String(args[0])}`);
        ++syncs;
        if (
          (scenario === 'forward failure' && syncs === 2) ||
          (scenario === 'rollback failure' && syncs === 8) ||
          (scenario === 'nested parent failure' && String(args[0]) === root)
        )
          throw new Error('directory sync failed');
        await sync();
      };
      return handle;
    });
    try {
      const stage = join(root, 'stage'),
        final =
          scenario === 'absent nested' || scenario === 'nested parent failure'
            ? join(root, 'new', 'nested', 'final')
            : join(root, 'final');
      await mkdir(stage);
      if (scenario !== 'absent nested' && scenario !== 'nested parent failure') await mkdir(final);
      const hash = async (path: string) =>
        createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
      const pair = await Promise.all(
        ['media', 'subtitle'].map(async (name) => {
          const stagedPath = join(stage, name),
            finalPath = join(final, name);
          await writeFile(stagedPath, name);
          const measured = await captureOwnerRestoreFile(stagedPath, hash);
          return {
            stagedPath,
            currentPath: stagedPath,
            finalPath,
            identity: measured.identity!,
            checksum: Buffer.from(measured.sha256!, 'hex'),
            size: String(measured.size),
          };
        }),
      );
      if (scenario === 'recovered final') {
        for (const file of pair) {
          await rename(file.stagedPath, file.finalPath);
          file.currentPath = file.finalPath;
          file.identity = (await captureOwnerRestoreFile(file.finalPath, hash)).identity!;
        }
      }
      const prepared = { pair, sources: [], finalPath: pair[0].finalPath };
      const repository = {
        getById: vi.fn().mockResolvedValue(undefined),
        publish: async (input: { files: { move: () => Promise<void>; rollback: () => Promise<void> } }) => {
          try {
            await input.files.move();
            if (scenario === 'rollback failure') throw new Error('publication failed');
            events.push('published');
            return {};
          } catch (error) {
            await input.files.rollback();
            throw error;
          }
        },
      };
      const service = Object.assign(Object.create(StudioExportService.prototype), {
        repository,
        crypto: { hashFile: async (path: string) => Buffer.from(await hash(path), 'hex') },
        storage: {
          mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
          rename: async (from: string, to: string) => {
            await rename(from, to);
            events.push(`rename:${dirname(from)}:${dirname(to)}`);
          },
        },
      });
      const attempt = service.publishAcknowledged(
        { id: 'version', outputChecksum: pair[0].checksum },
        { id: 'operation' },
        'claim',
        prepared,
      );
      switch (scenario) {
        case 'absent nested': {
          await attempt;
          expect(events).toEqual([
            `rename:${stage}:${final}`,
            `sync:${stage}`,
            `sync:${final}`,
            `sync:${dirname(final)}`,
            `sync:${dirname(dirname(final))}`,
            `sync:${root}`,
            `rename:${stage}:${final}`,
            `sync:${stage}`,
            `sync:${final}`,
            `sync:${dirname(final)}`,
            `sync:${dirname(dirname(final))}`,
            `sync:${root}`,
            'published',
          ]);
          break;
        }
        case 'nested parent failure': {
          await expect(attempt).rejects.toThrow();
          expect(events).not.toContain('published');
          expect(events).toContain(`sync:${root}`);
          for (const file of pair)
            expect(await readFile(file.stagedPath, 'utf8')).toBe(
              file.stagedPath.endsWith('media') ? 'media' : 'subtitle',
            );
          break;
        }
        case 'recovered final': {
          await attempt;
          expect(events).toEqual([
            `sync:${stage}`,
            `sync:${final}`,
            `sync:${root}`,
            `sync:${stage}`,
            `sync:${final}`,
            `sync:${root}`,
            'published',
          ]);
          break;
        }
        case 'success': {
          await attempt;
          expect(events).toEqual([
            `rename:${stage}:${final}`,
            `sync:${stage}`,
            `sync:${final}`,
            `sync:${root}`,
            `rename:${stage}:${final}`,
            `sync:${stage}`,
            `sync:${final}`,
            `sync:${root}`,
            'published',
          ]);
          break;
        }
        default: {
          await expect(attempt).rejects.toThrow(
            scenario === 'rollback failure' ? 'Paired file recovery is pending' : 'directory sync failed',
          );
          expect(events).not.toContain('published');
          for (const file of pair)
            expect(await readFile(file.stagedPath, 'utf8')).toBe(
              file.stagedPath.endsWith('media') ? 'media' : 'subtitle',
            );
          expect(events).toContain(`sync:${final}`);
          expect(events).toContain(`sync:${stage}`);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('retained export library transfer with actual temporary files', () => {
  it.each([
    'success',
    'commit lost',
    'refused',
    'foreign target',
    'changed source',
    'sync failure',
    'unavailable readback',
  ] as const)('%s preserves the accepted or recoverable file', async (scenario) => {
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const root = await real.realpath(await mkdtemp(join(tmpdir(), 'studio-library-save-')));
    StorageCore.setMediaLocation(root);
    const ownerId = '0195e2a0-0000-4000-8000-00000000000a';
    const id = '0195e2a0-0000-7000-8000-000000000004';
    const kept = studioExportProjectPath(ownerId, id, '.mp4');
    const target = studioExportLibraryPath(ownerId, id, '.mp4');
    const bytes = Buffer.from('verified retained media');
    const checksum = createHash('sha256').update(bytes).digest();
    let version = {
      id,
      ownerId,
      projectId: null,
      state: StudioExportVersionState.Published,
      scope: StudioExportScope.Project,
      outputPath: kept,
      outputChecksum: checksum,
      outputSizeInBytes: bytes.length,
      outputContentType: 'video/mp4',
      outputRemovedAt: null,
    } as StudioExportVersion;
    let syncs = 0;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await real.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (++syncs === 1 && scenario === 'sync failure') throw new Error('directory barrier failed');
        await sync();
      };
      return handle;
    });
    let unavailable = scenario === 'unavailable readback';
    const jobs = { queueInTransaction: vi.fn().mockResolvedValue(undefined) };
    const repository = {
      getSources: vi.fn().mockResolvedValue([]),
      getById: vi.fn(() =>
        unavailable ? Promise.reject(new Error('database unavailable')) : Promise.resolve(version),
      ),
      restoreLibrarySaveFiles: vi.fn(async (input: StudioExportLibrarySave) => {
        if (unavailable) throw new Error('recovery database unavailable');
        if (version.scope !== StudioExportScope.Project) return false;
        await input.files!.rollback();
        return true;
      }),
      saveToLibrary: vi.fn(
        async (input: StudioExportLibrarySave, schedule: (tx: unknown, id: string) => Promise<void>) => {
          if (scenario === 'changed source') await writeFile(kept, Buffer.alloc(bytes.length, 7));
          try {
            await input.files!.move();
            if (scenario === 'refused') throw new StudioExportRefusal('quota-exceeded', 'full');
            if (!unavailable) await schedule({ isTransaction: true }, 'accepted-asset');
          } catch (error) {
            await input.files!.rollback();
            throw error;
          }
          if (unavailable) throw new Error('uncertain save');
          version = {
            ...version,
            scope: StudioExportScope.Library,
            outputPath: target,
            resultAssetId: 'accepted-asset',
          };
          if (scenario === 'commit lost') throw new Error('commit acknowledgement lost');
          return { version, createdAssetId: 'accepted-asset', reusedAssetId: null };
        },
      ),
    };
    const service = Object.assign(Object.create(StudioExportService.prototype), {
      repository,
      jobs,
      findOwned: () => Promise.resolve(version),
      nsfwHiding: () => Promise.resolve(false),
      map: (row: StudioExportVersion) => row,
      logger: { log: vi.fn() },
      crypto: {
        hashFile: async (path: string) =>
          createHash('sha256')
            .update(await readFile(path))
            .digest(),
      },
      storage: {
        mkdirSync: (path: string) => mkdirSync(path, { recursive: true }),
        checkFileExists: async (path: string) =>
          real
            .stat(path)
            .then(() => true)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
              return false;
            }),
        rename,
        unlink: real.unlink,
      },
    });
    try {
      await mkdir(dirname(kept), { recursive: true });
      await writeFile(kept, bytes);
      if (scenario === 'foreign target') {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, 'unrelated file');
      }
      const actor = { user: { id: ownerId } };
      if (['refused', 'foreign target', 'changed source', 'sync failure'].includes(scenario)) {
        await expect(service.saveToLibrary(actor, id)).rejects.toThrow(
          scenario === 'refused' ? 'full' : scenario === 'sync failure' ? 'directory barrier failed' : 'Owner restore',
        );
        expect(repository.saveToLibrary).toHaveBeenCalledOnce();
        expect(version.scope).toBe(StudioExportScope.Project);
        expect(await readFile(kept)).toEqual(scenario === 'changed source' ? Buffer.alloc(bytes.length, 7) : bytes);
        if (scenario === 'foreign target') expect(await readFile(target, 'utf8')).toBe('unrelated file');
        else await expect(real.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(jobs.queueInTransaction).not.toHaveBeenCalled();
      } else {
        if (unavailable) {
          await expect(service.saveToLibrary(actor, id)).rejects.toThrow('Library save file recovery is pending');
          expect(await readFile(target)).toEqual(bytes);
          unavailable = false;
        }
        await expect(service.saveToLibrary(actor, id)).resolves.toMatchObject({ scope: StudioExportScope.Library });
        expect(await readFile(target)).toEqual(bytes);
        await expect(real.stat(kept)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(jobs.queueInTransaction).toHaveBeenCalledOnce();
        if (scenario === 'commit lost') expect(repository.restoreLibrarySaveFiles).not.toHaveBeenCalled();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
