import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { matchDesktopModelProfile, parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
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

it.each(['immich_ml', 'frameleaf_ml'])('accepts signed allowlisted module namespace %s', (moduleNamespace) => {
  const value = { ...manifest(), moduleNamespace };
  expect(verifyDesktopRuntimeAttestation(envelope(value), profile).manifestSha256).toBe(
    createHash('sha256').update(JSON.stringify(value)).digest('hex'),
  );
});
it.each(['foreign', null, 1])('rejects unsupported signed module namespace %s', (moduleNamespace) => {
  expect(() => verifyDesktopRuntimeAttestation(envelope({ ...manifest(), moduleNamespace }), profile)).toThrow();
});

it('binds an owned CoreML collector to its signed complete inventory', () => {
  const coreml = { ...profile, spec: { ...profile.spec, provider: 'CoreMLExecutionProvider' as const } };
  const files = Object.fromEntries(
    ['__init__.py', 'entry.py', 'metal_observer.py', 'metal_inference.py', '_frameleaf_coreml_observer.dylib'].map(
      (name) => [`private/frameleaf_desktop_ml/${name}`, { bytes: 10, sha256: 'c'.repeat(64) }],
    ),
  );
  const value = {
    ...manifest(),
    provider: coreml.spec.provider,
    moduleNamespace: 'frameleaf_ml',
    deviceObserver: { kind: 'metal-v1' },
    files: { ...manifest().files, ...files },
  };
  expect(verifyDesktopRuntimeAttestation(envelope(value), coreml)).toMatchObject({ collectorSha256: 'c'.repeat(64) });
  for (const changed of [
    { ...value, moduleNamespace: 'immich_ml' },
    { ...value, platform: 'linux' },
    { ...value, architecture: 'x86_64' },
    { ...value, deviceObserver: { kind: 'other' } },
    { ...value, deviceObserver: { kind: 'metal-v1', path: 'other' } },
    { ...value, files: manifest().files },
    ...Object.keys(files).flatMap((name) => [
      { ...value, files: { ...value.files, [name]: { bytes: 0, sha256: 'c'.repeat(64) } } },
      { ...value, files: { ...value.files, [name]: { bytes: 4 * 1024 ** 2 + 1, sha256: 'c'.repeat(64) } } },
    ]),
  ])
    expect(() => verifyDesktopRuntimeAttestation(envelope(changed), coreml)).toThrow();
  expect(() =>
    verifyDesktopRuntimeAttestation(envelope({ ...value, provider: profile.spec.provider }), profile),
  ).toThrow();
});

it.skipIf(!process.env.FRAMELEAF_COREML_NAS_FIXTURE)(
  'validates an actual signed CoreML runtime and fresh catalogue challenge report under fixture authority',
  async () => {
    const root = process.env.FRAMELEAF_COREML_NAS_FIXTURE!;
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const crypto = await import('node:crypto');
    const { DesktopQualificationReceipt } = await import('src/utils/desktop-qualification.js');
    const selected = parseDesktopModelCatalogue({
      schemaVersion: 1,
      epoch: 1,
      profiles: [JSON.parse(fs.readFileSync(join(root, 'profile.json'), 'utf8'))],
    }).profiles[0];
    const compiled = parseDesktopModelCatalogue(
      JSON.parse(fs.readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8')),
    );
    expect(
      matchDesktopModelProfile(
        compiled,
        selected.modelName,
        selected.spec.entries,
        selected.runtimeSourceRevision,
        selected.spec.provider,
      ),
    ).toEqual(selected);
    const challenge = JSON.parse(fs.readFileSync(join(root, 'challenge.json'), 'utf8'));
    const report = JSON.parse(fs.readFileSync(join(root, 'qualified-report.json'), 'utf8'));
    const manifest = fs.readFileSync(join(root, 'candidate/manifest.json'));
    const signature = fs.readFileSync(join(root, 'candidate/manifest.sig'));
    const fixtureKey = crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 71)]),
      format: 'der',
      type: 'pkcs8',
    });
    const previous = authority.policy;
    try {
      authority.policy = JSON.stringify({
        schemaVersion: 1,
        minimumRuntimeEpoch: 1,
        keys: [
          {
            id: 'sealed-coreml-fixture',
            publicKeyHex: crypto
              .createPublicKey(fixtureKey)
              .export({ format: 'der', type: 'spki' })
              .subarray(-32)
              .toString('hex'),
          },
        ],
      });
      const identity = verifyDesktopRuntimeAttestation(
        { manifestGzipBase64: gzipSync(manifest).toString('base64'), signatureBase64: signature.toString('base64') },
        selected,
      );
      const receipt = DesktopQualificationReceipt.validate(report, selected, challenge, identity);
      expect(receipt.bindingSha256).toBe(challenge.bindingSha256);
      expect(receipt.runtimeFingerprint).toBe(report.runtimeFingerprint);
      expect(report.state).toBe('ready-mixed');
      expect(() =>
        DesktopQualificationReceipt.validate(report, selected, challenge, {
          ...identity,
          collectorSha256: 'f'.repeat(64),
        }),
      ).toThrow();
      expect(() =>
        DesktopQualificationReceipt.validate(
          report,
          selected,
          { ...challenge, bindingSha256: 'f'.repeat(64) },
          identity,
        ),
      ).toThrow();
      fs.writeFileSync(
        join(root, 'nas-validation-result.json'),
        JSON.stringify(
          {
            fixtureOnly: true,
            releaseAuthorityUsed: false,
            signatureVerified: true,
            catalogueIdentityParsed: true,
            receiptValidated: true,
            manifestSha256: receipt.manifestSha256,
            bindingSha256: receipt.bindingSha256,
            modelKey: receipt.modelKey,
            reportSha256: receipt.reportSha256,
            runtimeFingerprint: receipt.runtimeFingerprint,
            state: report.state,
          },
          null,
          2,
        ) + '\n',
      );
    } finally {
      authority.policy = previous;
    }
  },
);
