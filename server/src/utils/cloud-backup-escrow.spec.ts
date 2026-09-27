import {
  ESCROW_SCRYPT,
  escrowPassphraseProblem,
  scryptDerive,
  unwrapBucketKey,
  wrapBucketKey,
} from 'src/utils/cloud-backup-escrow.js';
import { keyEscrowBlobSchema } from 'src/utils/frameleaf-cloud-backup.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

/** Each escrow open or wrap runs the real scrypt (N = 2^17, 128 MiB); a busy runner needs more than 5 s. */
const SCRYPT_TEST_TIMEOUT_MS = 30_000;

const key = Buffer.alloc(32, 7);
const passphrase = 'correct horse battery staple';

describe('cloud backup key escrow (FL-164)', () => {
  it('derives keys as RFC 7914 scrypt does', async () => {
    // RFC 7914 section 12, the third vector
    const derived = await scryptDerive('pleaseletmein', Buffer.from('SodiumChloride'), {
      N: 16_384,
      r: 8,
      p: 1,
      keyLength: 64,
    });

    expect(derived.toString('hex')).toBe(
      '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887',
    );
  });

  it(
    'wraps with scrypt N = 2^17 and AES-256-GCM, in the shape Frameleaf Cloud accepts',
    { timeout: SCRYPT_TEST_TIMEOUT_MS },
    async () => {
      const blob = await wrapBucketKey(key, passphrase, {
        salt: Buffer.alloc(16, 1),
        nonce: Buffer.alloc(12, 2),
      });

      expect(ESCROW_SCRYPT).toEqual({ N: 2 ** 17, r: 8, p: 1 });
      expect(blob).toMatchObject({
        version: 1,
        kdf: { name: 'scrypt', N: 131_072, r: 8, p: 1 },
        cipher: 'aes-256-gcm',
      });
      // the 32-byte key and the 16-byte tag
      expect(Buffer.from(blob.ciphertext, 'base64')).toHaveLength(48);
      expect(keyEscrowBlobSchema.safeParse(blob).success).toBe(true);
      expect(JSON.stringify(blob)).not.toContain(key.toString('base64'));
      expect(JSON.stringify(blob)).not.toContain(passphrase);
    },
  );

  it(
    'opens with the passphrase and refuses any other, or an altered copy',
    { timeout: SCRYPT_TEST_TIMEOUT_MS },
    async () => {
      const blob = await wrapBucketKey(key, passphrase);

      await expect(unwrapBucketKey(blob, passphrase)).resolves.toEqual(key);
      await expect(unwrapBucketKey(blob, 'another passphrase')).rejects.toThrow('does not open');
      const altered = Buffer.from(blob.ciphertext, 'base64');
      altered[0] ^= 1;
      await expect(unwrapBucketKey({ ...blob, ciphertext: altered.toString('base64') }, passphrase)).rejects.toThrow(
        'does not open',
      );
    },
  );

  it('refuses a short passphrase and a key that is not 256 bits', async () => {
    expect(escrowPassphraseProblem('short')).toContain('at least 12');
    await expect(wrapBucketKey(key, 'short')).rejects.toThrow('at least 12');
    await expect(wrapBucketKey(Buffer.alloc(16), passphrase)).rejects.toThrow('256 bits');
  });

  it('reads the blob Frameleaf Cloud publishes as its escrow fixture', () => {
    expect(keyEscrowBlobSchema.safeParse(cloudContractFixture('backup/escrow-blob.json')).success).toBe(true);
    // a stored record carries its time; the blob itself never does
    expect(keyEscrowBlobSchema.safeParse(cloudContractFixture('backup/escrow-record.json')).success).toBe(false);
  });
});
