import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { verifyDesktopRuntimeAttestation } from 'src/utils/desktop-runtime-attestation.js';

const authority = vi.hoisted(() => ({ policy: '' }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) =>
      String(args[0]).endsWith('release-trust.json') ? authority.policy : fs.readFileSync(...args),
  };
});
const key = generateKeyPairSync('ed25519');
authority.policy = JSON.stringify({
  schemaVersion: 1,
  minimumRuntimeEpoch: 2,
  keys: [
    {
      id: 'test-authority',
      publicKeyHex: key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    },
  ],
});
const profile = parseDesktopModelCatalogue(
  JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8')),
).profiles[0];
const manifest = () => ({
  schemaVersion: 1,
  protocolVersion: 1,
  epoch: 2,
  platform: 'macos',
  architecture: 'aarch64',
  provider: profile.spec.provider,
  sourceRevision: profile.runtimeSourceRevision,
  python: 'python/bin/python3',
  files: { 'python/bin/python3': { bytes: 10, sha256: 'a'.repeat(64) } },
});
const envelope = (value: unknown, signingKey = key.privateKey) => {
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return {
    manifestGzipBase64: gzipSync(raw).toString('base64'),
    signatureBase64: sign(null, raw, signingKey).toString('base64'),
  };
};
it('checks factory signature on exact decompressed bytes and binds the approved model source/provider', () => {
  const value = manifest();
  const result = verifyDesktopRuntimeAttestation(envelope(value), profile);
  expect(result).toEqual({
    manifestSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    sourceRevision: profile.runtimeSourceRevision,
    provider: profile.spec.provider,
    epoch: 2,
    platform: 'macos',
    architecture: 'aarch64',
  });
});
it('rejects forged, changed, malformed and over-budget transport without trusting caller keys', () => {
  const valid = envelope(manifest());
  const other = generateKeyPairSync('ed25519');
  for (const value of [
    envelope(manifest(), other.privateKey),
    { ...valid, signatureBase64: Buffer.alloc(64).toString('base64') },
    { ...valid, manifestGzipBase64: valid.manifestGzipBase64 + '\n' },
    { ...valid, signatureBase64: valid.signatureBase64 + '\n' },
    { ...valid, keys: [other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')] },
    { ...valid, manifestGzipBase64: Buffer.from('bad gzip').toString('base64') },
    envelope(Buffer.alloc(8 * 1024 * 1024 + 1, 32)),
    envelope(Buffer.from('{invalid')),
    { ...valid, manifestGzipBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') },
  ])
    expect(() => verifyDesktopRuntimeAttestation(value, profile)).toThrow();
});
it('rejects correctly signed but incompatible epochs, profiles, targets and inventories', () => {
  const cases = [
    { ...manifest(), epoch: 1 },
    { ...manifest(), epoch: 2.5 },
    { ...manifest(), sourceRevision: 'f'.repeat(40) },
    { ...manifest(), provider: 'CUDAExecutionProvider' },
    { ...manifest(), architecture: 'arm64' },
    { ...manifest(), platform: 'windows', architecture: 'aarch64' },
    { ...manifest(), files: {} },
    { ...manifest(), python: '../python' },
    { ...manifest(), python: 'not-in-inventory' },
    { ...manifest(), files: { '../python': { bytes: 1, sha256: 'a'.repeat(64) } } },
    { ...manifest(), files: { 'python/bin/python3': { bytes: -1, sha256: 'a'.repeat(64) } } },
    { ...manifest(), files: { 'python/bin/python3': { bytes: 10, sha256: 'invalid' } } },
    { ...manifest(), files: { ...manifest().files, 'Python/bin/python3': { bytes: 1, sha256: 'a'.repeat(64) } } },
    { ...manifest(), files: { ...manifest().files, 'CON.txt': { bytes: 1, sha256: 'a'.repeat(64) } } },
    { ...manifest(), unknown: true },
  ];
  for (const value of cases) expect(() => verifyDesktopRuntimeAttestation(envelope(value), profile)).toThrow();
});

it.skipIf(!process.env.FRAMELEAF_FACTORY_ATTESTATION)(
  'verifies the actual Rust-exported factory runtime against shipped NAS authority',
  async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const previous = authority.policy;
    try {
      authority.policy = fs.readFileSync(join(process.cwd(), 'resources/desktop/release-trust.json'), 'utf8');
      const input = JSON.parse(fs.readFileSync(process.env.FRAMELEAF_FACTORY_ATTESTATION!, 'utf8'));
      expect(verifyDesktopRuntimeAttestation(input, profile)).toEqual({
        manifestSha256: '556efcbc7e9fa3c6d53d637ac651872dc5d93cca916006ad48cb2d0207a0b415',
        epoch: 2,
        platform: 'macos',
        architecture: 'aarch64',
        provider: 'CPUExecutionProvider',
        sourceRevision: 'fc1a63223ccfe43f5f9d8dd4e27c9d977f5c9176',
      });
    } finally {
      authority.policy = previous;
    }
  },
);
