import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopModelChallenge, parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { DesktopQualificationReceipt } from 'src/utils/desktop-qualification.js';

const profile = parseDesktopModelCatalogue(
  JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8')),
).profiles[0];
const id = 'd621bd72-ad35-4199-95ab-76300756a38e';
const challenge = createDesktopModelChallenge(profile, id);
const runtime = {
  manifestSha256: 'a'.repeat(64),
  sourceRevision: profile.runtimeSourceRevision,
  provider: profile.spec.provider,
  platform: 'macos',
  architecture: 'aarch64',
  epoch: 2,
} as const;
const facts = {
  system: 'Darwin',
  release: 'fixture',
  architecture: 'arm64',
  processor: 'fixture été',
  python: '3.12.13',
  ort: '1.30.0',
  packages: { onnxruntime: '1.30.0' },
  providers: ['CPUExecutionProvider'],
  gpus: [],
  totalMemoryBytes: 8 * 1024 ** 3,
};
// Produced independently with Python json.dumps(sort_keys=True, separators=(',', ':')).
const fingerprint = '891cc03d8e59f842f93f2a783676388aa9763bbac9c44b0e66ff9a93f1e8685d';
const report = () => ({
  protocolVersion: 1,
  modelKey: profile.modelKey,
  provider: profile.spec.provider,
  preprocessingSha256: profile.spec.preprocessingSha256,
  fixtureSha256: profile.spec.fixtureSha256,
  bindingSha256: challenge.bindingSha256,
  runtime: facts,
  runtimeFingerprint: fingerprint,
  coldMilliseconds: 120,
  warmMilliseconds: 10,
  reason: null,
  state: 'ready-cpu',
  execution: [
    {
      state: 'ready-cpu',
      nodes: { CPUExecutionProvider: 123 },
      microseconds: { CPUExecutionProvider: 1000 },
      reason: null,
    },
  ],
});
it('seals a fresh exact qualification receipt and recomputes Python-compatible runtime fingerprints', () => {
  const receipt = DesktopQualificationReceipt.validate(report(), profile, challenge, runtime);
  expect(receipt.runtimeFingerprint).toBe(fingerprint);
  expect(receipt.bindingSha256).toBe(challenge.bindingSha256);
  expect(receipt.manifestSha256).toBe(runtime.manifestSha256);
  expect(receipt.modelKey).toBe(profile.modelKey);
  expect(receipt.reportSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.isFrozen(receipt)).toBe(true);
});
it('refuses stale challenge/model/runtime bindings and false or incomplete execution readiness', () => {
  const original = report();
  const cases: unknown[] = [
    { ...original, bindingSha256: 'b'.repeat(64) },
    { ...original, modelKey: 'other' },
    { ...original, preprocessingSha256: 'b'.repeat(64) },
    { ...original, fixtureSha256: 'b'.repeat(64) },
    { ...original, runtimeFingerprint: 'b'.repeat(64) },
    { ...original, provider: 'CUDAExecutionProvider' },
    { ...original, state: 'ready-accelerator' },
    { ...original, reason: 'failed' },
    { ...original, coldMilliseconds: Infinity },
    { ...original, warmMilliseconds: -1 },
    { ...original, coldMilliseconds: profile.spec.deadlineSeconds * 1000 },
    { ...original, execution: [] },
    { ...original, execution: [{ ...original.execution[0], nodes: { CPUExecutionProvider: 0 } }] },
    { ...original, execution: [{ ...original.execution[0], nodes: { CUDAExecutionProvider: 1 } }] },
    { ...original, execution: [{ ...original.execution[0], state: 'ready-accelerator' }] },
    { ...original, execution: [{ ...original.execution[0], reason: 'failed' }] },
    { ...original, runtime: { ...facts, totalMemoryBytes: 1 } },
    { ...original, runtime: { ...facts, architecture: 'x86_64' } },
    { ...original, runtime: { ...facts, secret: 'forbidden' } },
    { ...original, unapproved: true },
  ];
  for (const value of cases)
    expect(() => DesktopQualificationReceipt.validate(value, profile, challenge, runtime)).toThrow();
  expect(() =>
    DesktopQualificationReceipt.validate(original, profile, { ...challenge, specJson: '{}' }, runtime),
  ).toThrow();
  expect(() =>
    DesktopQualificationReceipt.validate(original, profile, challenge, { ...runtime, sourceRevision: 'b'.repeat(40) }),
  ).toThrow();
});

it('matches Python fingerprints for DEL and supplementary Unicode code units', () => {
  const value = {
    ...report(),
    runtime: { ...facts, processor: 'fixture \u{7F} \u{1F600}' },
    runtimeFingerprint: '335d565babc7acf1398e257f850348cf8f944f4a46ff6ae6cfc6e12041e2ab6d',
  };
  expect(DesktopQualificationReceipt.validate(value, profile, challenge, runtime).runtimeFingerprint).toBe(
    value.runtimeFingerprint,
  );
});

it.skipIf(!process.env.FRAMELEAF_FACTORY_QUALIFICATION)(
  'accepts the actual fresh production SigLIP report and factory runtime identity',
  async () => {
    const { verifyDesktopRuntimeAttestation } = await import('src/utils/desktop-runtime-attestation.js');
    const folder = process.env.FRAMELEAF_FACTORY_QUALIFICATION!;
    const actual = JSON.parse(readFileSync(join(folder, 'report.json'), 'utf8'));
    const specJson = readFileSync(join(folder, 'spec.json'), 'utf8');
    const identity = verifyDesktopRuntimeAttestation(
      JSON.parse(readFileSync(process.env.FRAMELEAF_FACTORY_ATTESTATION!, 'utf8')),
      profile,
    );
    const bindingSha256 = (await import('node:crypto')).createHash('sha256').update(specJson).digest('hex');
    const validated = DesktopQualificationReceipt.validate(
      actual,
      profile,
      {
        specJson,
        bindingSha256,
        fixtureBase64: profile.fixtureBase64,
      },
      identity,
    );
    expect(validated.bindingSha256).toBe(bindingSha256);
    expect(validated.manifestSha256).toBe('556efcbc7e9fa3c6d53d637ac651872dc5d93cca916006ad48cb2d0207a0b415');
  },
);
