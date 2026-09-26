import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CryptoRepository, SERVER_HMAC_KEY_FILE } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

/** FL-161: file-system limits of SMB/CIFS, FUSE and cross-device mounts, switched on per test. */
const fsFaults = vi.hoisted(() => ({ link: null as string | null, sync: null as string | null }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const fault = (code: string) => Object.assign(new Error(code), { code });
  return {
    ...actual,
    link: (...args: Parameters<typeof actual.link>) =>
      fsFaults.link ? Promise.reject(fault(fsFaults.link)) : actual.link(...args),
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const code = fsFaults.sync;
      if (code) {
        handle.sync = () => Promise.reject(fault(code));
      }
      return handle;
    },
  };
});

describe(CryptoRepository.name, () => {
  let sut: CryptoRepository;
  let tmpDir: string;
  let filePath: string;

  // RFC 3174 sample vectors for "abc".
  // SHA-1("abc")   = a9993e364706816aba3e25717850c26c9cd0d89d
  // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
  const SHA1_ABC = Buffer.from('a9993e364706816aba3e25717850c26c9cd0d89d', 'hex');
  const SHA256_ABC = Buffer.from('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'hex');

  beforeAll(() => {
    sut = new CryptoRepository();
    tmpDir = mkdtempSync(join(tmpdir(), 'immich-crypto-'));
    filePath = join(tmpDir, 'abc.txt');
    writeFileSync(filePath, 'abc');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('hashFile', () => {
    it('defaults to SHA-1 for backward compatibility', async () => {
      const digest = await sut.hashFile(filePath);
      expect(digest.length).toBe(20);
      expect(digest.equals(SHA1_ABC)).toBe(true);
    });

    it('computes SHA-256 when requested explicitly', async () => {
      const digest = await sut.hashFile(filePath, 'sha256');
      expect(digest.length).toBe(32);
      expect(digest.equals(SHA256_ABC)).toBe(true);
    });

    it('computes SHA-1 when requested explicitly', async () => {
      const digest = await sut.hashFile(filePath, 'sha1');
      expect(digest.length).toBe(20);
      expect(digest.equals(SHA1_ABC)).toBe(true);
    });
  });

  describe('hashFileMatching', () => {
    it('picks SHA-1 when reference is 20 bytes (legacy asset)', async () => {
      const digest = await sut.hashFileMatching(filePath, Buffer.alloc(20));
      expect(digest.length).toBe(20);
      expect(digest.equals(SHA1_ABC)).toBe(true);
    });

    it('picks SHA-256 when reference is 32 bytes (new asset)', async () => {
      const digest = await sut.hashFileMatching(filePath, Buffer.alloc(32));
      expect(digest.length).toBe(32);
      expect(digest.equals(SHA256_ABC)).toBe(true);
    });

    it('falls back to SHA-1 for unknown reference lengths', async () => {
      const digest = await sut.hashFileMatching(filePath, Buffer.alloc(10));
      expect(digest.length).toBe(20);
      expect(digest.equals(SHA1_ABC)).toBe(true);
    });

    it('verifies a legacy SHA-1 row against the same bytes', async () => {
      const digest = await sut.hashFileMatching(filePath, SHA1_ABC);
      expect(digest.equals(SHA1_ABC)).toBe(true);
    });

    it('verifies a new SHA-256 row against the same bytes', async () => {
      const digest = await sut.hashFileMatching(filePath, SHA256_ABC);
      expect(digest.equals(SHA256_ABC)).toBe(true);
    });
  });

  describe('hashFileDigests', () => {
    it('computes both content hashes and the byte count from one readable stream', async () => {
      await expect(sut.hashFileDigests(filePath)).resolves.toEqual({
        sha1: SHA1_ABC,
        sha256: SHA256_ABC,
        sizeInBytes: 3,
      });
    });
  });

  describe('serverKeyedHash (FL-161)', () => {
    it('keys the hash with a 0600 file it creates once, and separates purposes', async () => {
      const directory = join(tmpDir, 'identity');
      const first = await sut.serverKeyedHash(directory, 'shared-link-unlock', 'link-1');

      const key = readFileSync(join(directory, SERVER_HMAC_KEY_FILE));
      expect(key).toHaveLength(32);
      expect(statSync(join(directory, SERVER_HMAC_KEY_FILE)).mode & 0o777).toBe(0o600);
      expect(first).toBe(createHmac('sha256', key).update('shared-link-unlock\0link-1').digest('base64url'));

      // a fresh process reads the same key back
      await expect(new CryptoRepository().serverKeyedHash(directory, 'shared-link-unlock', 'link-1')).resolves.toBe(
        first,
      );
      await expect(sut.serverKeyedHash(directory, 'rate-limit', 'link-1')).resolves.not.toBe(first);
    });

    it('replaces a key of the wrong length atomically, says that unlocks reset, and leaves no temporary file', async () => {
      const directory = join(tmpDir, 'damaged');
      mkdirSync(directory);
      writeFileSync(join(directory, SERVER_HMAC_KEY_FILE), Buffer.alloc(40));
      const warn = vi.spyOn(LoggingRepository.prototype, 'warn').mockImplementation(() => {});

      const value = await sut.serverKeyedHash(directory, 'rate-limit', 'x');

      const key = readFileSync(join(directory, SERVER_HMAC_KEY_FILE));
      expect(key).toHaveLength(32);
      expect(statSync(join(directory, SERVER_HMAC_KEY_FILE)).mode & 0o777).toBe(0o600);
      expect(value).toBe(createHmac('sha256', key).update('rate-limit\0x').digest('base64url'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unlocked with their password again'));
      expect(readdirSync(directory)).toEqual([SERVER_HMAC_KEY_FILE]);
      warn.mockRestore();
    });

    it.each(['EPERM', 'ENOTSUP', 'EXDEV'])(
      'creates the key by renaming where the file system cannot hard-link (%s)',
      async (code) => {
        fsFaults.link = code;
        try {
          const directory = join(tmpDir, `no-link-${code}`);
          const value = await sut.serverKeyedHash(directory, 'rate-limit', 'x');

          const key = readFileSync(join(directory, SERVER_HMAC_KEY_FILE));
          expect(key).toHaveLength(32);
          expect(value).toBe(createHmac('sha256', key).update('rate-limit\0x').digest('base64url'));
          expect(readdirSync(directory)).toEqual([SERVER_HMAC_KEY_FILE]);
        } finally {
          fsFaults.link = null;
        }
      },
    );

    it('accepts a mount that cannot flush a file, but not an I/O error', async () => {
      fsFaults.sync = 'EINVAL';
      try {
        const directory = join(tmpDir, 'no-sync');
        await expect(sut.serverKeyedHash(directory, 'rate-limit', 'x')).resolves.toEqual(expect.any(String));
        expect(readFileSync(join(directory, SERVER_HMAC_KEY_FILE))).toHaveLength(32);

        fsFaults.sync = 'EIO';
        const failing = join(tmpDir, 'io-error');
        await expect(new CryptoRepository().serverKeyedHash(failing, 'rate-limit', 'x')).rejects.toThrow('EIO');
        // no partly written key is left behind
        expect(readdirSync(failing)).toEqual([]);
      } finally {
        fsFaults.sync = null;
      }
    });

    it('uses the key another process created first', async () => {
      const directory = join(tmpDir, 'shared');
      const [first, second] = await Promise.all([
        new CryptoRepository().serverKeyedHash(directory, 'rate-limit', 'x'),
        new CryptoRepository().serverKeyedHash(directory, 'rate-limit', 'x'),
      ]);

      expect(first).toBe(second);
      expect(readdirSync(directory)).toEqual([SERVER_HMAC_KEY_FILE]);
    });
  });
});
