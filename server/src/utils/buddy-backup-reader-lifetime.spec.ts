import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import { BuddyBackupReader } from 'src/utils/buddy-backup-reader.js';

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open) };
});

it.each(['pending', 'unknown', 'known-failure'] as const)(
  'joins download descriptor closure before publication or cleanup: %s',
  async (kind) => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'buddy-reader-lifetime-'));
    const bytes = Buffer.from('independent synthetic original');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const manifest = {
      contents: { [sha256]: { bytes: bytes.length, blocks: ['block'], keyVersion: 1 } },
    } as unknown as BuddyManifest;
    const reader = Object.assign(Object.create(BuddyBackupReader.prototype), {
      execution: {},
      block: () => Promise.resolve(kind === 'known-failure' ? Buffer.from('changed') : bytes),
    });
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let descriptor: FileHandle | undefined;
    vi.mocked(open).mockImplementation(async (...args) => {
      const file = await fs.open(...args);
      if (!String(args[0]).includes('.tmp-') || kind === 'known-failure') return file;
      descriptor = file;
      return new Proxy(file, {
        get(target, key) {
          if (key === 'close')
            return async () => {
              entered.resolve();
              if (kind === 'unknown') throw new Error('synthetic close failure');
              await released.promise;
              await file.close();
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    const target = join(root, 'original');
    const work = reader.download(manifest, sha256, target);
    try {
      if (kind === 'known-failure') {
        await expect(work).rejects.toThrow('Buddy plaintext checksum failed');
        expect(await readdir(root)).toEqual([]);
      } else if (kind === 'unknown') {
        await expect(work).rejects.toThrow('buddy_file_close_unconfirmed');
        const [temporary] = await readdir(root);
        expect(temporary).toMatch(/^\.tmp-/u);
        expect(await readFile(join(root, temporary))).toEqual(bytes);
        expect(await descriptor!.stat()).toMatchObject({ size: bytes.length });
        await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        await entered.promise;
        await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(root)).toHaveLength(1);
        released.resolve();
        await expect(work).resolves.toEqual({ sha256, size: bytes.length });
        expect(await readFile(target)).toEqual(bytes);
        expect(await readdir(root)).toEqual(['original']);
      }
    } finally {
      released.resolve();
      await work.catch(() => {});
      await descriptor?.close();
      vi.mocked(open).mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);
