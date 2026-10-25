import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { writeBuddyFile } from 'src/utils/buddy-backup-vault.js';

vi.mock('node:fs/promises', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...fs, open: vi.fn(fs.open) };
});

it('retains an unpublished Buddy temporary file until descriptor closure is confirmed', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const folder = await mkdtemp(join(tmpdir(), 'buddy-close-proof-'));
  let close: (() => Promise<void>) | undefined;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await fs.open(...args);
    if (basename(String(args[0])).startsWith('.tmp-')) {
      close = handle.close.bind(handle);
      handle.close = () => Promise.reject(new Error('synthetic close failure'));
    }
    return handle;
  });
  try {
    await expect(writeBuddyFile(join(folder, 'manifest'), 'synthetic backup bytes')).rejects.toThrow(
      'buddy_file_close_unconfirmed',
    );
    const entries = await readdir(folder);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^\.tmp-[a-f0-9-]{36}$/);
    expect(await readFile(join(folder, entries[0]), 'utf8')).toBe('synthetic backup bytes');
  } finally {
    vi.mocked(open).mockImplementation(fs.open);
    await close?.();
    await rm(folder, { recursive: true, force: true });
  }
});
