import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { BUDDY_BLOCK_BYTES } from 'src/utils/buddy-backup-crypto.js';
import {
  clientBackupContext,
  clientBackupObjectKey,
  clientBackupPlainSize,
  clientBackupStoredSize,
  decryptClientBackup,
  encryptClientBackup,
} from 'src/utils/cloud-backup-crypto.js';

const vaultId = 'f0000000-0000-4000-8000-000000000001';
const root = randomBytes(32);
const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const collect = async (source: AsyncIterable<Buffer>) => {
  const all: Buffer[] = await Array.fromAsync(source);
  return Buffer.concat(all);
};
const fixture = async (plain: Buffer, version = 1) => {
  const key = clientBackupObjectKey(root, vaultId, version, sha256(plain));
  const context = clientBackupContext('bucket', key)!;
  const sealed = await collect(encryptClientBackup(Readable.from([plain]), plain.length, root, context));
  return { context, sealed };
};

describe('client backup format', () => {
  it.each([0, 1, BUDDY_BLOCK_BYTES, BUDDY_BLOCK_BYTES + 1])(
    'authenticates %i bytes across arbitrary transport chunks',
    async (size) => {
      const plain = randomBytes(size);
      const { context, sealed } = await fixture(plain);
      expect(sealed.length).toBe(clientBackupStoredSize(size));
      expect(clientBackupPlainSize(sealed.length)).toBe(size);
      const chunks = async function* () {
        await Promise.resolve();
        for (let at = 0; at < sealed.length; at += 131_071) yield sealed.subarray(at, at + 131_071);
      };
      expect((await collect(decryptClientBackup(chunks(), root, context))).equals(plain)).toBe(true);
      expect(context.key).not.toContain(sha256(plain));
    },
  );
  it('fails closed on tampering, truncation, reordering, context/key substitution, and trailing bytes', async () => {
    const { context, sealed } = await fixture(randomBytes(BUDDY_BLOCK_BYTES * 2));
    const corrupt = Buffer.from(sealed);
    corrupt[100] ^= 1;
    const block = BUDDY_BLOCK_BYTES + 60;
    const reorder = Buffer.concat([
      sealed.subarray(0, 48),
      sealed.subarray(48 + block, 48 + block * 2),
      sealed.subarray(48, 48 + block),
      sealed.subarray(48 + block * 2),
    ]);
    const header = Buffer.from(sealed);
    header[47] ^= 1;
    for (const damaged of [
      corrupt,
      reorder,
      header,
      sealed.subarray(0, -1),
      sealed.subarray(0, 48 + block),
      Buffer.concat([sealed, Buffer.from('x')]),
    ])
      await expect(collect(decryptClientBackup(Readable.from([damaged]), root, context))).rejects.toThrow();
    for (const other of [
      { ...context, bucket: 'other' },
      { ...context, vaultId: 'f0000000-0000-4000-8000-000000000002' },
      { ...context, key: context.key + 'x' },
      { ...context, kind: 'manifest' as const },
      { ...context, keyVersion: 2 },
    ])
      await expect(collect(decryptClientBackup(Readable.from([sealed]), root, other))).rejects.toThrow();
    await expect(collect(decryptClientBackup(Readable.from([sealed]), randomBytes(32), context))).rejects.toThrow();
  });
  it('uses independent upload keys, historical versions, and validates the plaintext identity before completion', async () => {
    const plain = Buffer.from('harmless-media-sentinel');
    const first = await fixture(plain);
    const second = await fixture(plain);
    expect(first.sealed).not.toEqual(second.sealed);
    expect(first.sealed.includes(plain)).toBe(false);
    expect(first.sealed.includes(root)).toBe(false);
    const rotated = await fixture(plain, 2);
    expect(rotated.context.key).not.toBe(first.context.key);
    expect(await collect(decryptClientBackup(Readable.from([rotated.sealed]), root, rotated.context))).toEqual(plain);
    await expect(
      collect(encryptClientBackup(Readable.from([Buffer.from('changed')]), 7, root, first.context)),
    ).rejects.toThrow('identity');
    expect(() => clientBackupContext('bucket', first.context.key, 'f0000000-0000-4000-8000-000000000002')).toThrow(
      'vault',
    );
    expect(() => clientBackupContext('bucket', 'o/v2/unsupported')).toThrow('Unsupported');
  });
});

describe('independent recovery roots', () => {
  it('rejects a reused legacy root and preserves independent historical roots across rotation', async () => {
    const { addClientBackupKeys, parseClientBackupKeys, rotateClientBackupKeys } =
      await import('src/utils/cloud-backup-crypto.js');
    const original = { key: root.toString('base64'), instanceId: vaultId };
    const prepared = addClientBackupKeys(original);
    expect(prepared.client.keys[1]).not.toBe(original.key);
    const rotated = rotateClientBackupKeys(prepared.client, root);
    expect(rotated.current).toBe(2);
    expect(rotated.keys[1]).toBe(prepared.client.keys[1]);
    expect(rotated.keys[2]).not.toBe(rotated.keys[1]);
    expect(() => parseClientBackupKeys({ vaultId, current: 1, keys: { 1: original.key } }, root, vaultId)).toThrow(
      'independent',
    );
    const plaintext = Buffer.from('historical version sentinel');
    for (const version of [1, 2]) {
      const key = Buffer.from(rotated.keys[version], 'base64');
      const context = clientBackupContext('bucket', clientBackupObjectKey(key, vaultId, version, sha256(plaintext)))!;
      const ciphertext = await collect(encryptClientBackup(Readable.from([plaintext]), plaintext.length, key, context));
      expect((await collect(decryptClientBackup(Readable.from([ciphertext]), key, context))).equals(plaintext)).toBe(
        true,
      );
      await expect(collect(decryptClientBackup(Readable.from([ciphertext]), root, context))).rejects.toThrow();
    }
  });
});
