import {
  type LockedFileInfo,
  type LockedKeyFile,
  encryptFile,
  generateKeyPair,
  generateRecoveryKey,
  wrapKey,
} from '@frameleaf/locked-crypto';
import { Command } from 'commander';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LockedCliError, buildLockedDecryptCommand, lockedDecrypt, runLockedDecrypt } from 'src/commands/locked';

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = Array.from(await readdir(dir, { withFileTypes: true, recursive: true }), (entry) =>
    join(entry.parentPath, entry.name),
  );
  return out.toSorted();
};

const keyFile = (
  userId: string,
  label: string,
  pair: { publicKey: Buffer },
  mode: 'pin' | 'advanced',
): Omit<LockedKeyFile, 'wraps'> => ({
  format: 'frameleaf-locked-key/1',
  userId,
  label,
  publicKey: pair.publicKey.toString('base64'),
  mode,
  encrypting: true,
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
});

const run = async (args: string[]) => {
  const command = new Command().exitOverride();
  command.addCommand(
    buildLockedDecryptCommand((code) => {
      throw Object.assign(new Error('exit'), { code });
    }).configureOutput({ writeOut: () => {}, writeErr: () => {} }),
  );
  try {
    await command.parseAsync(['node', 'x', 'decrypt', ...args]);
  } catch (error) {
    return (error as { code: number }).code;
  }
};

const THUMB_ID = '7d1c0f9e-5a3b-4c2d-8e6f-0a1b2c3d4e5f';

describe('locked decrypt', { timeout: 120_000 }, () => {
  let root: string;
  let library: string;
  let to: string;
  const alice = generateKeyPair();
  const bea = generateKeyPair();
  const aliceId = randomUUID();
  const beaId = randomUUID();
  const aliceRecovery = generateRecoveryKey();
  const beaRecovery = generateRecoveryKey();
  const plain = {
    photo1: randomBytes(70_000),
    photo2: randomBytes(1000),
    beaPhoto: randomBytes(500),
    shared: randomBytes(300),
  };
  let tamperedPath: string;

  const seal = async (
    relative: string,
    content: Buffer,
    recipients: Array<{ publicKey: Buffer }>,
    info: Partial<LockedFileInfo>,
  ) => {
    const src = join(root, `plain-${randomUUID()}`);
    await writeFile(src, content);
    const dst = join(library, relative);
    await mkdir(join(dst, '..'), { recursive: true });
    await encryptFile(src, dst, recipients, {
      assetId: randomUUID(),
      kind: 'original',
      originalFileName: 'IMG_0001.jpg',
      mime: 'image/jpeg',
      ...info,
    });
    return dst;
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'locked-cli-'));
    library = join(root, 'library');
    await mkdir(join(library, 'locked-keys'), { recursive: true });

    let a = await wrapKey(keyFile(aliceId, 'Alice', alice, 'pin'), alice.privateKey, 'pin', '482915');
    a = await wrapKey(a, alice.privateKey, 'recovery', aliceRecovery);
    let b = await wrapKey(
      keyFile(beaId, 'Bea', bea, 'advanced'),
      bea.privateKey,
      'passphrase',
      'correct horse battery',
    );
    b = await wrapKey(b, bea.privateKey, 'recovery', beaRecovery);
    await writeFile(join(library, 'locked-keys', `${aliceId}.json`), JSON.stringify(a));
    await writeFile(join(library, 'locked-keys', `${beaId}.json`), JSON.stringify(b));

    const aliceOnly = [{ publicKey: alice.publicKey }];
    await seal('upload/a/1.bin', plain.photo1, aliceOnly, { originalFileName: 'IMG_0001.jpg' });
    await seal('upload/a/2.bin', plain.photo2, aliceOnly, { originalFileName: 'IMG_0001.jpg' });
    await seal('upload/a/3.bin', plain.photo2, aliceOnly, { originalFileName: 'IMG_0001.jpg' });
    await seal('thumbs/a/t.jpg', randomBytes(50), aliceOnly, {
      kind: 'thumbnail',
      assetId: THUMB_ID,
      originalFileName: 'IMG_0001.jpg',
    });
    await seal('upload/b/1.bin', plain.beaPhoto, [{ publicKey: bea.publicKey }], { originalFileName: 'bea.png' });
    // Bea's item shared with Alice (PIN-mode partner)
    await seal('upload/b/shared.bin', plain.shared, [{ publicKey: bea.publicKey }, { publicKey: alice.publicKey }], {
      originalFileName: 'shared.png',
    });
    // plain files, temp files and unrelated files are ignored
    await writeFile(join(library, 'upload/a/plain.jpg'), 'not encrypted');
    await writeFile(join(library, 'upload/a/x.fllk.tmp'), 'FLLKpartial');
    tamperedPath = await seal('upload/a/bad.bin', randomBytes(2000), aliceOnly, { originalFileName: 'broken.jpg' });
    const handle = await open(tamperedPath, 'r+');
    const { size } = await handle.stat();
    await handle.write(Buffer.from([0xff, 0xee]), 0, 2, size - 20);
    await handle.close();
  });

  beforeEach(async () => {
    to = join(root, `out-${randomUUID()}`);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads a secret piped on standard input', async () => {
    const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from(['correct horse battery\n']) });
    try {
      const result = await lockedDecrypt({ library, to, user: beaId });
      expect(result).toMatchObject({ written: 2, failed: [] });
      expect(await readFile(join(to, 'bea.png'))).toEqual(plain.beaPhoto);
      expect(await readFile(join(to, 'shared.png'))).toEqual(plain.shared);
    } finally {
      Object.defineProperty(process, 'stdin', stdin);
      vi.restoreAllMocks();
    }
  });

  it('reads the chooser answer and then the secret from one piped standard input', async () => {
    const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // the chooser lists the key files in name order; find Bea's number
    const keyFiles = await readdir(join(library, 'locked-keys'));
    const names = keyFiles.toSorted();
    const bea = names.indexOf(`${beaId}.json`) + 1;
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: Readable.from([`${bea}\ncorrect horse battery\n`]),
    });
    try {
      const result = await lockedDecrypt({ library, to });
      expect(result).toMatchObject({ written: 2, failed: [] });
      expect(await readFile(join(to, 'bea.png'))).toEqual(plain.beaPhoto);
    } finally {
      Object.defineProperty(process, 'stdin', stdin);
      vi.restoreAllMocks();
    }
  });

  it('refuses piped input that names no one, without --user', async () => {
    const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    Object.defineProperty(process, 'stdin', { configurable: true, value: Readable.from([]) });
    try {
      await expect(lockedDecrypt({ library, to })).rejects.toMatchObject({ exitCode: 2 });
    } finally {
      Object.defineProperty(process, 'stdin', stdin);
      vi.restoreAllMocks();
    }
  });

  it("decrypts the chosen user's originals to <to>/<originalFileName>", async () => {
    const result = await lockedDecrypt({ library, to, user: 'Bea', secret: 'correct horse battery' });
    expect(result).toEqual({ written: 2, failed: [] });
    expect(await readFile(join(to, 'bea.png'))).toEqual(plain.beaPhoto);
    expect(await readFile(join(to, 'shared.png'))).toEqual(plain.shared);
  });

  it('name clashes become "name (2).jpg"', async () => {
    const result = await lockedDecrypt({ library, to, user: aliceId, secret: '482915' });
    expect(result.written).toBe(4); // 3 IMG_0001.jpg + shared.png, not broken.jpg
    const names = await readdir(to);
    const files = names.toSorted();
    expect(files).toEqual(['IMG_0001 (2).jpg', 'IMG_0001 (3).jpg', 'IMG_0001.jpg', 'shared.png']);
  });

  it('a tampered file is listed in failed and not written; exit code 1', async () => {
    const result = await lockedDecrypt({ library, to, user: 'Alice', secret: '482915' });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toContain(tamperedPath);
    expect(await readdir(to)).not.toContain('broken.jpg');
    const left = await readdir(to);
    expect(left.some((name) => name.includes('.tmp'))).toBe(false);
    expect(await runLockedDecrypt({ library, to: join(root, 'o2'), user: 'Alice', secret: '482915' })).toBe(1);
  });

  it('--all also writes derivatives under derived/<assetId>/', async () => {
    await lockedDecrypt({ library, to, user: 'Alice', secret: '482915', all: true });
    const derived = await readdir(join(to, 'derived', THUMB_ID));
    expect(derived).toHaveLength(1);
    await lockedDecrypt({ library, to: join(root, 'no-all'), user: 'Alice', secret: '482915' });
    await expect(readdir(join(root, 'no-all', 'derived'))).rejects.toThrow();
  });

  it('a wrong secret gives exit code 2 and writes nothing', async () => {
    await expect(lockedDecrypt({ library, to, user: 'Alice', secret: '000000' })).rejects.toMatchObject({
      exitCode: 2,
    });
    expect(await runLockedDecrypt({ library, to, user: 'Alice', secret: '000000' })).toBe(2);
    await expect(readdir(to)).rejects.toThrow();
  });

  it('works with the PIN, the passphrase and the recovery key', async () => {
    for (const [user, secret] of [
      ['Alice', '482915'],
      ['Alice', aliceRecovery],
      ['Bea', 'correct horse battery'],
      ['Bea', beaRecovery],
    ]) {
      const out = join(root, `m-${randomUUID()}`);
      const result = await lockedDecrypt({ library, to: out, user, secret });
      expect(result.written).toBeGreaterThan(0);
    }
  });

  it('never writes inside --library', async () => {
    const before = await walk(library);
    await lockedDecrypt({ library, to, user: 'Alice', secret: '482915', all: true });
    expect(await walk(library)).toEqual(before);
    await expect(
      lockedDecrypt({ library, to: join(library, 'recovered'), user: 'Alice', secret: '482915' }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(await walk(library)).toEqual(before);
  });

  it("a partner's PIN opens files shared with them", async () => {
    await lockedDecrypt({ library, to, user: 'Alice', secret: '482915' });
    expect(await readFile(join(to, 'shared.png'))).toEqual(plain.shared);
  });

  it('refuses a missing key file or unknown user with exit code 2', async () => {
    const empty = join(root, 'empty-lib');
    await mkdir(empty, { recursive: true });
    await expect(lockedDecrypt({ library: empty, to, secret: 'x' })).rejects.toBeInstanceOf(LockedCliError);
    await expect(lockedDecrypt({ library, to, user: 'Nobody', secret: 'x' })).rejects.toMatchObject({ exitCode: 2 });
  });

  it('rejects a planted assetId or file name that tries to leave --to', async () => {
    const lib = join(root, `planted-${randomUUID()}`);
    await mkdir(join(lib, 'locked-keys'), { recursive: true });
    await copyFile(join(library, 'locked-keys', `${aliceId}.json`), join(lib, 'locked-keys', `${aliceId}.json`));
    const mine = library;
    library = lib;
    const aliceOnly = [{ publicKey: alice.publicKey }];
    try {
      await seal('p/1.bin', randomBytes(20), aliceOnly, { kind: 'thumbnail', assetId: '../../x' });
      await seal('p/2.bin', randomBytes(20), aliceOnly, { originalFileName: '../escape.jpg' });
      await seal('p/3.bin', randomBytes(20), aliceOnly, { originalFileName: '..' });
    } finally {
      library = mine;
    }
    const dest = join(root, `dest-${randomUUID()}`, 'inner');
    const result = await lockedDecrypt({ library: lib, to: dest, user: 'Alice', secret: '482915', all: true });
    expect(result.written).toBe(1);
    expect(result.failed).toHaveLength(2);
    expect(await readdir(dest)).toEqual(['escape.jpg']);
    expect(await readdir(join(dest, '..'))).toEqual(['inner']);
    expect(await readdir(root)).not.toContain('x');
  });

  it('exits 2 for bad arguments and 0 for --help', async () => {
    expect(await run(['--to', 'x'])).toBe(2);
    expect(await run(['--library', 'a', '--to', 'b', '--bogus'])).toBe(2);
    expect(await run(['--help'])).toBe(0);
  });

  // Windows ignores chmod 0, so the folder stays readable there.
  it.skipIf(process.platform === 'win32')(
    'counts symlinks it skips and carries on past an unreadable folder',
    async () => {
      const lib = join(root, `links-${randomUUID()}`);
      await mkdir(join(lib, 'locked-keys'), { recursive: true });
      await copyFile(join(library, 'locked-keys', `${aliceId}.json`), join(lib, 'locked-keys', `${aliceId}.json`));
      await symlink(library, join(lib, 'link'));
      await mkdir(join(lib, 'sealed'));
      await chmod(join(lib, 'sealed'), 0);
      try {
        const result = await lockedDecrypt({
          library: lib,
          to: join(root, `l-${randomUUID()}`),
          user: 'Alice',
          secret: '482915',
        });
        expect(result.skippedLinks).toBe(1);
        expect(result.failed).toHaveLength(1);
        expect(result.failed[0]).toContain('sealed');
      } finally {
        await chmod(join(lib, 'sealed'), 0o700);
      }
    },
  );
});
