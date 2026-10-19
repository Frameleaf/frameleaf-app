import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopModelChallenge, parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { DesktopQualificationReceipt } from 'src/utils/desktop-qualification.js';
import { canonicalJson } from 'src/utils/object.js';

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

it('accepts signed-collector CoreML participation only as mixed and refuses altered or incomplete proof', () => {
  const selected = { ...profile, spec: { ...profile.spec, provider: 'CoreMLExecutionProvider' as const } };
  const issued = createDesktopModelChallenge(selected, id);
  const identity = { ...runtime, provider: selected.spec.provider, collectorSha256: 'c'.repeat(64) };
  const device = {
    abiVersion: 1,
    collectorSha256: 'c'.repeat(64),
    osBuild: 'fixture build',
    devices: [{ name: 'fixture GPU', identitySha256: 'd'.repeat(64) }],
  };
  const hardware = { ...facts, providers: ['CPUExecutionProvider', 'CoreMLExecutionProvider'], deviceEvidence: device };
  const proof = {
    provider: selected.spec.provider,
    facts: device,
    models: [
      {
        sha256: selected.spec.models[0].artifacts[`${selected.spec.models[0].type}/model.onnx`],
        calls: 2,
        computeBuffers: 2,
        computeDispatches: 2,
        gpuNanoseconds: 1000,
      },
    ],
  };
  const value = {
    ...report(),
    provider: selected.spec.provider,
    bindingSha256: issued.bindingSha256,
    runtime: hardware,
    runtimeFingerprint: createHash('sha256')
      .update(
        canonicalJson(hardware).replaceAll(
          // eslint-disable-next-line unicorn/prefer-unicode-code-point-escapes
          /[\u007F-\uFFFF]/g,
          (ch) => String.raw`\u` + ch.codePointAt(0)!.toString(16).padStart(4, '0'),
        ),
      )
      .digest('hex'),
    state: 'ready-mixed',
    execution: [
      {
        state: 'ready-mixed',
        reason: null,
        nodes: { CoreMLExecutionProvider: 1 },
        microseconds: { CoreMLExecutionProvider: 10 },
      },
    ],
    deviceExecution: proof,
  };
  expect(DesktopQualificationReceipt.validate(value, selected, issued, identity).modelKey).toBe(selected.modelKey);
  for (const changed of [
    { ...value, deviceExecution: undefined },
    { ...value, deviceExecution: { ...proof, models: [] } },
    { ...value, deviceExecution: { ...proof, models: [...proof.models, ...proof.models] } },
    { ...value, deviceExecution: { ...proof, facts: { ...device, osBuild: 'other' } } },
    { ...value, deviceExecution: { ...proof, extra: true } },
    { ...value, state: 'ready-accelerator' },
    { ...value, execution: [{ ...value.execution[0], state: 'ready-accelerator' }] },
    {
      ...value,
      execution: [
        { ...value.execution[0], nodes: { CPUExecutionProvider: 1 }, microseconds: { CPUExecutionProvider: 10 } },
      ],
    },
    ...[
      { calls: 1 },
      { computeBuffers: 1 },
      { computeDispatches: 1 },
      { sha256: 'f'.repeat(64) },
      { gpuNanoseconds: 600_000_000_000 * proof.models[0].calls + 1 },
    ].map((change) => ({ ...value, deviceExecution: { ...proof, models: [{ ...proof.models[0], ...change }] } })),
    ...['sha256', 'calls', 'computeBuffers', 'computeDispatches', 'gpuNanoseconds'].flatMap((field) =>
      [0, -1, true, 'changed', Infinity].map((bad) => ({
        ...value,
        deviceExecution: { ...proof, models: [{ ...proof.models[0], [field]: bad }] },
      })),
    ),
  ])
    expect(() => DesktopQualificationReceipt.validate(changed, selected, issued, identity)).toThrow();
  for (const collectorSha256 of [undefined, 'f'.repeat(64)])
    expect(() =>
      DesktopQualificationReceipt.validate(value, selected, issued, { ...identity, collectorSha256 }),
    ).toThrow();
  expect(() =>
    DesktopQualificationReceipt.validate({ ...report(), deviceExecution: proof }, profile, challenge, runtime),
  ).toThrow();
});
