import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

const linkFailure = vi.hoisted(() => ({ code: null as string | null }));
const changes = vi.hoisted(() => ({
  beforeOpen: null as (() => Promise<void>) | null,
  beforeRead: null as (() => Promise<void>) | null,
  chmodCode: null as string | null,
  chmodIgnored: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    chmod: vi.fn(async (path: string, mode: number) => {
      if (changes.chmodCode) throw Object.assign(new Error('chmod refused'), { code: changes.chmodCode });
      return original.chmod(path, changes.chmodIgnored ? 0o644 : mode);
    }),
    open: vi.fn(async (...args: Parameters<typeof original.open>) => {
      if (String(args[0]).endsWith('.key') && changes.beforeOpen) {
        const change = changes.beforeOpen;
        changes.beforeOpen = null;
        await change();
      }
      const handle = await original.open(...args);
      if (String(args[0]).endsWith('.key')) {
        const read = handle.read.bind(handle);
        handle.read = vi.fn(async (...readArgs: Parameters<typeof handle.read>) => {
          if (changes.beforeRead) {
            const change = changes.beforeRead;
            changes.beforeRead = null;
            await change();
          }
          return read(...readArgs);
        }) as typeof handle.read;
      }
      return handle;
    }),
    link: vi.fn((from: string, to: string) =>
      linkFailure.code
        ? Promise.reject(Object.assign(new Error('link refused'), { code: linkFailure.code }))
        : original.link(from, to),
    ),
  };
});

const content = (key: string) => JSON.stringify({ format: 'frameleaf-backup-key', key });

describe(CloudBackupKeyRepository.name, () => {
  let sut: CloudBackupKeyRepository;
  let directory: string;

  beforeEach(async () => {
    linkFailure.code = null;
    changes.beforeOpen = changes.beforeRead = changes.chmodCode = null;
    changes.chmodIgnored = false;
    sut = new CloudBackupKeyRepository(LoggingRepository.create());
    directory = await mkdtemp(join(tmpdir(), 'cloud-backup-key-'));
  });

  it('returns null only for an initially missing key or directory', async () => {
    await expect(sut.read(directory, 'ABCD-1234')).resolves.toBeNull();
    await expect(sut.read(join(directory, 'absent'), 'ABCD-1234')).resolves.toBeNull();
    await expect(sut.read(directory, '../escape')).rejects.toThrow('Invalid key fingerprint');
  });

  it('rejects symlinks, directories, oversized keys and public storage on single-key reads', async () => {
    const file = join(directory, 'cloud-backup-ABCD-1234.key');
    await writeFile(join(directory, 'unrelated'), 'never capture this');
    await symlink(join(directory, 'unrelated'), file);
    await expect(sut.read(directory, 'ABCD-1234')).rejects.toThrow();
    await rm(file);
    await mkdir(file, { mode: 0o700 });
    await expect(sut.read(directory, 'ABCD-1234')).rejects.toThrow('unavailable');
    await rm(file, { recursive: true });
    await writeFile(file, 'x'.repeat(16_385), { mode: 0o600 });
    await expect(sut.read(directory, 'ABCD-1234')).rejects.toThrow('unavailable');
    await writeFile(file, content('key'));
    await chmod(file, 0o644);
    await expect(sut.read(directory, 'ABCD-1234')).rejects.toThrow('private storage');
    await chmod(file, 0o600);
    await chmod(directory, 0o755);
    await expect(sut.read(directory, 'ABCD-1234')).rejects.toThrow('private storage');
    await expect(sut.write(directory, 'ABCD-1234', content('key'))).rejects.toThrow('private storage');
  });

  it.each(['beforeOpen', 'beforeRead'] as const)(
    'rejects atomic replacement %s, but allows later reads',
    async (stage) => {
      await sut.write(directory, 'ABCD-1234', content('original'));
      const replacement = join(directory, 'replacement');
      await writeFile(replacement, content('replacement'), { mode: 0o600 });
      changes[stage] = () => rename(replacement, join(directory, 'cloud-backup-ABCD-1234.key'));
      await expect(sut.read(directory, 'ABCD-1234')).rejects.toThrow('changed during capture');
      await expect(sut.read(directory, 'ABCD-1234')).resolves.toBe(content('replacement'));
    },
  );

  it('bounds a key that grows after open and rejects in-place changes', async () => {
    const file = join(directory, 'cloud-backup-ABCD-1234.key');
    for (const replacement of ['x'.repeat(100_000), content('changed')]) {
      await writeFile(file, content('original'), { mode: 0o600 });
      changes.beforeRead = () => writeFile(file, replacement);
      await expect(sut.read(directory, 'ABCD-1234')).rejects.toThrow('changed during capture');
    }
  });

  it('rejects a FIFO substituted between inspection and open without blocking', async () => {
    await sut.write(directory, 'ABCD-1234', content('key'));
    const file = join(directory, 'cloud-backup-ABCD-1234.key');
    changes.beforeOpen = async () => {
      await rm(file);
      execFileSync('mkfifo', [file]);
      await chmod(file, 0o600);
    };
    await expect(sut.read(directory, 'ABCD-1234')).rejects.toThrow('changed during capture');
  });

  it('rejects a directory symlink and ownership different from the server UID', async () => {
    await sut.write(directory, 'ABCD-1234', content('key'));
    const alias = join(directory, 'alias');
    await symlink(directory, alias);
    await expect(sut.read(alias, 'ABCD-1234')).rejects.toThrow('real private directory');
    const getuid = vi.spyOn(process, 'geteuid').mockReturnValue(process.geteuid() + 1);
    try {
      await expect(sut.read(directory, 'ABCD-1234')).rejects.toThrow('private storage');
    } finally {
      getuid.mockRestore();
    }
  });

  it('accepts a mount that refuses chmod only when the staged file is already private', async () => {
    changes.chmodCode = 'ENOTSUP';
    await expect(sut.write(directory, 'ABCD-1234', content('key'))).resolves.toMatchObject({ created: true });
    await expect(sut.read(directory, 'ABCD-1234')).resolves.toBe(content('key'));
  });

  it('rejects an ineffective chmod and cleans its staging file without changing existing keys', async () => {
    await sut.write(directory, 'FFFF-0000', content('keep'));
    changes.chmodIgnored = true;
    await expect(sut.write(directory, 'ABCD-1234', content('key'))).rejects.toThrow('private storage');
    expect(await readdir(directory)).toEqual(['cloud-backup-FFFF-0000.key']);
    await expect(sut.write(directory, 'ABCD-1234', 'x'.repeat(16_385))).rejects.toThrow('Invalid stored backup key');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('enumerates only bounded regular backup-key files and never captures server identity', async () => {
    await sut.write(directory, 'ABCD-1234', content('key'));
    await writeFile(join(directory, 'instance-key.pem'), 'private instance identity');
    expect(await sut.readAll(directory)).toEqual([{ fingerprint: 'ABCD-1234', content: content('key') }]);
    const other = join(directory, 'cloud-backup-FFFF-0000.key');
    await symlink(join(directory, 'instance-key.pem'), other);
    await expect(sut.readAll(directory)).rejects.toThrow();
    await rm(other);
    await writeFile(other, 'x'.repeat(16_385), { mode: 0o600 });
    await expect(sut.readAll(directory)).rejects.toThrow('unavailable');
  });

  it('writes a 0600 key file once, reads it back, and leaves no staging file', async () => {
    await expect(sut.write(directory, 'ABCD-1234', content('k1'))).resolves.toMatchObject({ created: true });

    const file = join(directory, 'cloud-backup-ABCD-1234.key');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(sut.read(directory, 'ABCD-1234')).resolves.toBe(content('k1'));
    expect(await readdir(directory)).toEqual(['cloud-backup-ABCD-1234.key']);
  });

  it('keeps the same key already there, and never writes another key over it', async () => {
    await sut.write(directory, 'ABCD-1234', content('k1'));

    await expect(sut.write(directory, 'ABCD-1234', content('k1'))).resolves.toMatchObject({ created: false });
    await expect(sut.write(directory, 'ABCD-1234', content('k2'))).rejects.toThrow('different backup key');
    expect(await readFile(join(directory, 'cloud-backup-ABCD-1234.key'), 'utf8')).toBe(content('k1'));
  });

  it('falls back to a rename on a mount that cannot hard-link (SMB/CIFS, FUSE), without replacing a file', async () => {
    linkFailure.code = 'ENOTSUP';

    await expect(sut.write(directory, 'ABCD-1234', content('k1'))).resolves.toMatchObject({ created: true });
    await expect(sut.write(directory, 'ABCD-1234', content('k2'))).rejects.toThrow('different backup key');
    expect(await readFile(join(directory, 'cloud-backup-ABCD-1234.key'), 'utf8')).toBe(content('k1'));
    expect(await readdir(directory)).toEqual(['cloud-backup-ABCD-1234.key']);
  });

  it('never replaces a dangling symlink on a mount that cannot hard-link', async () => {
    linkFailure.code = 'ENOTSUP';
    const file = join(directory, 'cloud-backup-ABCD-1234.key');
    await symlink(join(directory, 'absent'), file);
    await expect(sut.write(directory, 'ABCD-1234', content('key'))).rejects.toThrow();
    expect(await readdir(directory)).toEqual(['cloud-backup-ABCD-1234.key']);
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes only the key file it is asked to, and refuses a name that is not a fingerprint', async () => {
    await writeFile(join(directory, 'cloud-backup-FFFF-0000.key'), content('other'));
    await sut.write(directory, 'ABCD-1234', content('k1'));

    await sut.remove(directory, 'ABCD-1234');

    expect(await readdir(directory)).toEqual(['cloud-backup-FFFF-0000.key']);
    expect(() => sut.fileName('../escape')).toThrow('Invalid key fingerprint');
  });
});
