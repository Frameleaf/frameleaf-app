import express, { type Express, json } from 'express';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { DesktopWorkerController } from 'src/controllers/desktop-worker.controller.js';
import { desktopWorkerMessage } from 'src/dtos/desktop-worker.dto.js';
import { frameleafViaMiddleware } from 'src/middleware/frameleaf-via.middleware.js';
import { DesktopQualificationService } from 'src/services/desktop-qualification.service.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { DesktopWorkerService } from 'src/services/desktop-worker.service.js';
import { getConfig } from 'src/utils/config.js';
import { createDesktopModelChallenge, parseDesktopModelCatalogue } from 'src/utils/desktop-model-catalogue.js';
import { DesktopQualificationReceipt } from 'src/utils/desktop-qualification.js';
import { canonicalJson } from 'src/utils/object.js';
import { type ControllerContext, controllerSetup } from 'test/utils.js';

const authority = vi.hoisted(() => ({ policy: '', spaces: undefined as string | undefined }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) =>
      String(args[0]).endsWith('release-trust.json')
        ? authority.policy
        : String(args[0]).endsWith('model-spaces.json') && authority.spaces !== undefined
          ? authority.spaces
          : fs.readFileSync(...args),
  };
});
vi.mock('src/utils/config.js', async (original) => ({
  ...(await original<typeof import('src/utils/config.js')>()),
  getConfig: vi.fn(),
}));
const factory = generateKeyPairSync('ed25519');
authority.policy = JSON.stringify({
  schemaVersion: 1,
  minimumRuntimeEpoch: 2,
  keys: [
    {
      id: 'test-authority',
      publicKeyHex: factory.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    },
  ],
});
const keys = generateKeyPairSync('ed25519');
const token = 'a'.repeat(64);
const id = '445bc2b6-f4cd-439e-b8bb-7e84d7ee0550';
const sessionId = '1117c1ca-0495-46e9-b579-f321520c2b1a';
const grant = { deviceId: id, sessionId, authorizationEpoch: 2, credentialHash: Buffer.alloc(32, 7) };
const profile = parseDesktopModelCatalogue(
  JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8')),
).profiles[0];
const manifest = Buffer.from(
  JSON.stringify({
    schemaVersion: 1,
    protocolVersion: 1,
    epoch: 2,
    platform: 'macos',
    architecture: 'aarch64',
    provider: profile.spec.provider,
    sourceRevision: profile.runtimeSourceRevision,
    python: 'python/bin/python3',
    files: { 'python/bin/python3': { bytes: 10, sha256: 'a'.repeat(64) } },
  }),
);
const identity = {
  manifestSha256: createHash('sha256').update(manifest).digest('hex'),
  sourceRevision: profile.runtimeSourceRevision,
  provider: profile.spec.provider,
  platform: 'macos',
  architecture: 'aarch64',
  epoch: 2,
};
const envelope = {
  manifestGzipBase64: gzipSync(manifest).toString('base64'),
  signatureBase64: sign(null, manifest, factory.privateKey).toString('base64'),
};
const payload = () =>
  JSON.stringify({
    requestId: 'd621bd72-ad35-4199-95ab-76300756a38e',
    modelKey: profile.modelKey,
    provider: profile.spec.provider,
    runtimeSourceRevision: profile.runtimeSourceRevision,
    runtime: envelope,
  });
const challenge = createDesktopModelChallenge(profile, id);
const row = () => ({
  id,
  ...challenge,
  modelKey: profile.modelKey,
  profileSha256: createHash('sha256').update(canonicalJson(profile)).digest('hex'),
  runtime: identity,
  expiresAt: new Date(Date.now() + 600_000),
  reportSha256: null,
  credentialHash: grant.credentialHash,
  privateField: 'must-not-leak',
});
const report = () => {
  const facts = {
    system: 'Darwin',
    release: 'fixture',
    architecture: 'arm64',
    processor: 'fixture',
    python: '3.12.13',
    ort: '1.30.0',
    packages: { onnxruntime: '1.30.0' },
    providers: ['CPUExecutionProvider'],
    gpus: [],
    totalMemoryBytes: 8 * 1024 ** 3,
  };
  return {
    protocolVersion: 1,
    modelKey: profile.modelKey,
    provider: profile.spec.provider,
    preprocessingSha256: profile.spec.preprocessingSha256,
    fixtureSha256: profile.spec.fixtureSha256,
    bindingSha256: challenge.bindingSha256,
    runtime: facts,
    runtimeFingerprint: createHash('sha256').update(canonicalJson(facts)).digest('hex'),
    coldMilliseconds: 120,
    warmMilliseconds: 10,
    state: 'ready-cpu',
    reason: null,
    execution: [
      {
        state: 'ready-cpu',
        nodes: { CPUExecutionProvider: 123 },
        microseconds: { CPUExecutionProvider: 1000 },
        reason: null,
      },
    ],
  };
};
const repository = { session: vi.fn(), consume: vi.fn() };
const challenges = { issue: vi.fn(), read: vi.fn(), record: vi.fn(), readAccepted: vi.fn() };
let ctx: ControllerContext;
let app: Express;
const proof = (operation: string, raw: string) => {
  const dto = { sessionId, sequence: 1, timestamp: Date.now(), signature: '' };
  dto.signature = sign(
    null,
    Buffer.from(desktopWorkerMessage('server', 2, token, dto, operation, raw)),
    keys.privateKey,
  ).toString('base64');
  return Buffer.from(JSON.stringify(dto)).toString('base64');
};
const post = (path: string, operation: string, raw: string) =>
  request(app)
    .post(path)
    .auth(token, { type: 'bearer' })
    .set('x-frameleaf-desktop-proof', proof(operation, raw))
    .send({ payload: raw });
beforeAll(async () => {
  const metadata = { get: vi.fn().mockResolvedValue({ id: 'server' }) };
  const auth = new DesktopWorkerAuthService(repository as never, metadata as never);
  ctx = await controllerSetup(DesktopWorkerController, [
    { provide: DesktopWorkerService, useValue: {} },
    {
      provide: DesktopQualificationService,
      useValue: new DesktopQualificationService(auth, challenges as never, {} as never, metadata as never),
    },
  ]);
  app = express();
  app.use(frameleafViaMiddleware('edge-secret'));
  app.use(json({ limit: '10mb' }));
  app.use((req, res) => ctx.getHttpServer().emit('request', req, res));
});
afterAll(async () => ctx.close());
beforeEach(() => {
  vi.clearAllMocks();
  repository.session.mockResolvedValue({
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    authorizationEpoch: 2,
  });
  repository.consume.mockResolvedValue(grant);
  challenges.issue.mockResolvedValue(row());
  challenges.read.mockResolvedValue(row());
  challenges.record.mockResolvedValue(true);
  vi.mocked(getConfig).mockResolvedValue({
    machineLearning: { enabled: true, clip: { enabled: true, modelName: profile.modelName } },
  } as never);
});
it('issues a signed factory-bound challenge through arrival middleware without exposing internal grant fields', async () => {
  const response = await post('/desktop/worker/challenges', 'challenge', payload());
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    id,
    modelKey: profile.modelKey,
    bindingSha256: challenge.bindingSha256,
    manifestSha256: identity.manifestSha256,
    reportSha256: null,
  });
  expect(response.body).not.toHaveProperty('credentialHash');
  expect(response.body).not.toHaveProperty('privateField');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(getConfig).toHaveBeenLastCalledWith(expect.any(Object), { withCache: false });
  expect(challenges.issue).toHaveBeenCalledWith(grant, 'd621bd72-ad35-4199-95ab-76300756a38e', profile, identity);
});
it('rejects photo credentials, altered signatures, caller specs/keys, disabled or changed NAS models and forged runtimes', async () => {
  expect(
    (
      await request(app)
        .post('/desktop/worker/challenges')
        .auth('photo-token', { type: 'bearer' })
        .send({ payload: payload() })
    ).status,
  ).toBe(401);
  expect((await post('/desktop/worker/challenges', 'claim', payload())).status).toBe(401);
  expect(
    (
      await post(
        '/desktop/worker/challenges',
        'challenge',
        JSON.stringify({ ...JSON.parse(payload()), specJson: '{}' }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await post(
        '/desktop/worker/challenges',
        'challenge',
        JSON.stringify({
          ...JSON.parse(payload()),
          runtime: { ...envelope, signatureBase64: Buffer.alloc(64).toString('base64') },
        }),
      )
    ).status,
  ).toBe(400);
  vi.mocked(getConfig).mockResolvedValue({
    machineLearning: { enabled: true, clip: { enabled: true, modelName: 'ViT-B-32__openai' } },
  } as never);
  expect((await post('/desktop/worker/challenges', 'challenge', payload())).status).toBe(409);

  for (const machineLearning of [
    { enabled: false, clip: { enabled: true, modelName: profile.modelName } },
    { enabled: true, clip: { enabled: false, modelName: profile.modelName } },
  ]) {
    vi.mocked(getConfig).mockResolvedValue({ machineLearning } as never);
    expect((await post('/desktop/worker/challenges', 'challenge', payload())).status).toBe(409);
  }
  expect(challenges.issue).not.toHaveBeenCalled();
});
it('binds challenge reads and report submission to the exact operation, fresh spec and current credential', async () => {
  const response = await request(app)
    .get('/desktop/worker/challenges/' + id)
    .auth(token, { type: 'bearer' })
    .set('x-frameleaf-desktop-proof', proof('challenge:' + id, ''));
  expect(response.status).toBe(200);
  const raw = JSON.stringify({ report: report() });
  expect((await post('/desktop/worker/challenges/' + id + '/report', 'qualification:' + id, raw)).body).toEqual({
    accepted: true,
  });
  expect(challenges.record.mock.calls[0][2]).toBeInstanceOf(DesktopQualificationReceipt);
  expect((await post('/desktop/worker/challenges/' + id + '/report', 'qualification:other', raw)).status).toBe(401);
  expect(
    (
      await post(
        '/desktop/worker/challenges/' + id + '/report',
        'qualification:' + id,
        JSON.stringify({ report: { ...report(), bindingSha256: 'b'.repeat(64) } }),
      )
    ).status,
  ).toBe(400);
  challenges.read.mockResolvedValue(undefined);
  expect((await post('/desktop/worker/challenges/' + id + '/report', 'qualification:' + id, raw)).status).toBe(401);
});

it.skipIf(!process.env.FRAMELEAF_FACTORY_ATTESTATION)(
  'accepts the real factory manifest through the production-size body and proof boundary',
  async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const previous = authority.policy;
    try {
      authority.policy = fs.readFileSync(join(process.cwd(), 'resources/desktop/release-trust.json'), 'utf8');
      const actual = JSON.parse(fs.readFileSync(process.env.FRAMELEAF_FACTORY_ATTESTATION!, 'utf8'));
      challenges.issue.mockImplementation((_grant, _id, _profile, runtime) => Promise.resolve({ ...row(), runtime }));
      const raw = JSON.stringify({ ...JSON.parse(payload()), runtime: actual });
      expect(Buffer.byteLength(raw)).toBeGreaterThan(1024 * 1024);
      const response = await post('/desktop/worker/challenges', 'challenge', raw);
      expect(response.status).toBe(200);
      expect(response.body.manifestSha256).toBe('556efcbc7e9fa3c6d53d637ac651872dc5d93cca916006ad48cb2d0207a0b415');
    } finally {
      authority.policy = previous;
    }
  },
);

it('reads only safe current accepted evidence using a distinct signed operation', async () => {
  const accepted = {
    ...row(),
    deviceId: id,
    sessionId,
    authorizationEpoch: 2,
    configSha256: createHash('sha256').update(canonicalJson(profile.spec.entries)).digest('hex'),
    inputKind: 'text',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000),
    runtimeFingerprint: report().runtimeFingerprint,
    reportSha256: createHash('sha256').update(canonicalJson(report())).digest('hex'),
  };
  challenges.readAccepted.mockResolvedValue(accepted);
  const path = `/desktop/worker/qualifications/${id}`;
  const response = await request(app)
    .get(path)
    .auth(token, { type: 'bearer' })
    .set('x-frameleaf-desktop-proof', proof(`accepted-qualification:${id}`, ''));
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toEqual({
    id,
    deviceId: id,
    sessionId,
    authorizationEpoch: 2,
    modelKey: profile.modelKey,
    configSha256: accepted.configSha256,
    inputKind: 'text',
    bindingSha256: challenge.bindingSha256,
    manifestSha256: identity.manifestSha256,
    runtimeFingerprint: accepted.runtimeFingerprint,
    reportSha256: accepted.reportSha256,
    qualifiedAt: accepted.createdAt.toISOString(),
    expiresAt: accepted.expiresAt.toISOString(),
  });
  expect(
    (
      await request(app)
        .get(path)
        .auth(token, { type: 'bearer' })
        .set('x-frameleaf-desktop-proof', proof(`challenge:${id}`, ''))
    ).status,
  ).toBe(401);
  for (const changed of [
    { ...accepted, profileSha256: 'f'.repeat(64) },
    { ...accepted, configSha256: 'f'.repeat(64) },
    { ...accepted, inputKind: 'image' },
    { ...accepted, runtime: { ...identity, epoch: 1 } },
  ]) {
    challenges.readAccepted.mockResolvedValue(changed);
    expect(
      (
        await request(app)
          .get(path)
          .auth(token, { type: 'bearer' })
          .set('x-frameleaf-desktop-proof', proof(`accepted-qualification:${id}`, ''))
      ).status,
    ).toBe(409);
  }
  challenges.readAccepted.mockResolvedValue(undefined);
  expect(
    (
      await request(app)
        .get(path)
        .auth(token, { type: 'bearer' })
        .set('x-frameleaf-desktop-proof', proof(`accepted-qualification:${id}`, ''))
    ).status,
  ).toBe(401);
});

it('refuses a catalogue-approved profile without a release-owned paired embedding space', async () => {
  const spaces = JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-spaces.json'), 'utf8'));
  spaces.spaces = spaces.spaces.filter(
    (space: { visualModelKey: string; textModelKeys: string[] }) =>
      space.visualModelKey !== profile.modelKey && !space.textModelKeys.includes(profile.modelKey),
  );
  authority.spaces = JSON.stringify(spaces);
  try {
    const service = new DesktopQualificationService(
      { authenticate: vi.fn().mockResolvedValue(grant) } as never,
      challenges as never,
      {} as never,
      {} as never,
    );
    await expect(service.issue(undefined, undefined, payload())).rejects.toThrow('desktop_model_profile_unavailable');
    expect(challenges.issue).not.toHaveBeenCalled();
  } finally {
    authority.spaces = undefined;
  }
});
