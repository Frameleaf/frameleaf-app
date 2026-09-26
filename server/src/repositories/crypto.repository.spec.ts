import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CryptoRepository, SERVER_HMAC_KEY_FILE } from 'src/repositories/crypto.repository.js';

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

    it('refuses a damaged key instead of replacing it', async () => {
      const directory = join(tmpDir, 'damaged');
      mkdirSync(directory);
      writeFileSync(join(directory, SERVER_HMAC_KEY_FILE), Buffer.alloc(40));

      await expect(sut.serverKeyedHash(directory, 'rate-limit', 'x')).rejects.toThrow('is damaged');
    });
  });
});
