import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudBackupKeyRepository } from 'src/repositories/cloud-backup-key.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

const linkFailure = vi.hoisted(() => ({ code: null as string | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
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
    sut = new CloudBackupKeyRepository(LoggingRepository.create());
    directory = await mkdtemp(join(tmpdir(), 'cloud-backup-key-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
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

  it('removes only the key file it is asked to, and refuses a name that is not a fingerprint', async () => {
    await writeFile(join(directory, 'cloud-backup-FFFF-0000.key'), content('other'));
    await sut.write(directory, 'ABCD-1234', content('k1'));

    await sut.remove(directory, 'ABCD-1234');

    expect(await readdir(directory)).toEqual(['cloud-backup-FFFF-0000.key']);
    expect(() => sut.fileName('../escape')).toThrow('Invalid key fingerprint');
  });
});
