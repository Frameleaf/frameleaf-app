import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StudioExportService } from 'src/services/studio-export.service.js';
import { captureOwnerRestoreFile } from 'src/utils/cloud-backup-owner-path.js';

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
