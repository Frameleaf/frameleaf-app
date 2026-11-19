import { ConflictException } from '@nestjs/common';
import express, { type Express, json } from 'express';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { defaults } from 'src/config.js';
import { DesktopWorkerController } from 'src/controllers/desktop-worker.controller.js';
import { desktopWorkerMessage } from 'src/dtos/desktop-worker.dto.js';
import { frameleafViaMiddleware } from 'src/middleware/frameleaf-via.middleware.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DesktopQualificationService } from 'src/services/desktop-qualification.service.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { DesktopWorkerService } from 'src/services/desktop-worker.service.js';
import { getConfig } from 'src/utils/config.js';
import { faceEntries } from 'src/utils/desktop-face.js';
import {
  createDesktopModelChallenge,
  desktopImageModelKey,
  parseDesktopModelCatalogue,
} from 'src/utils/desktop-model-catalogue.js';
import { ocrEntries } from 'src/utils/desktop-ocr.js';
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
const acceptedRow = () => ({
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
});
const repository = { session: vi.fn(), consume: vi.fn(), owner: vi.fn(), policyOff: vi.fn() };
/** The saved settings with the search model changed; every other task as shipped. */
const settings = (machineLearning: { enabled: boolean; clip: { enabled: boolean; modelName: string } }) =>
  ({
    machineLearning: {
      ...structuredClone(defaults.machineLearning),
      enabled: machineLearning.enabled,
      clip: { ...defaults.machineLearning.clip, ...machineLearning.clip },
    },
  }) as never;
const inventoryPolicies = { read: vi.fn() };
const challenges = { issue: vi.fn(), read: vi.fn(), record: vi.fn(), readAccepted: vi.fn() };
/** No model is being held back from this desktop unless a test says so. */
const holds = { heldUntil: vi.fn(), clearWithdrawal: vi.fn() };
let ctx: ControllerContext;
let app: Express;
const activation = { activate: vi.fn() };

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
    { provide: ConfigRepository, useValue: new ConfigRepository() },
    { provide: DesktopWorkerService, useValue: {} },
    {
      provide: DesktopQualificationService,
      useValue: new DesktopQualificationService(
        auth,
        challenges as never,
        {} as never,
        metadata as never,
        activation as never,
        repository as never,
        inventoryPolicies as never,
        holds as never,
      ),
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
  activation.activate.mockReset().mockResolvedValue(undefined);
  challenges.readAccepted.mockResolvedValue(acceptedRow());
  repository.session.mockResolvedValue({
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    authorizationEpoch: 2,
  });
  repository.consume.mockResolvedValue(grant);
  repository.owner.mockResolvedValue(id);
  inventoryPolicies.read.mockResolvedValue({ revisionId: id });
  challenges.issue.mockResolvedValue(row());
  challenges.read.mockResolvedValue(row());
  challenges.record.mockResolvedValue(true);
  repository.policyOff.mockResolvedValue(undefined);
  vi.mocked(getConfig).mockResolvedValue(
    settings({ enabled: true, clip: { enabled: true, modelName: profile.modelName } }),
  );
});
it('serves only a signed worker model inventory and rejects operation substitution, replay and revoked credentials', async () => {
  vi.mocked(getConfig).mockResolvedValue(structuredClone(defaults));
  const raw = JSON.stringify({ provider: profile.spec.provider, runtimeSourceRevision: profile.runtimeSourceRevision });
  const response = await post('/desktop/worker/models', 'models', raw);
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.workloads).toHaveLength(4);
  expect(response.body.workloads[0]).toMatchObject({ workload: 'clip', state: 'eligible' });
  expect(JSON.stringify(response.body)).not.toMatch(/authToken|destinationId|credentialHash|https?:/);
  expect((await post('/desktop/worker/models', 'challenge', raw)).status).toBe(401);
  expect(
    (await request(app).post('/desktop/worker/models').auth('photo-token', { type: 'bearer' }).send({ payload: raw }))
      .status,
  ).toBe(401);
  repository.consume.mockResolvedValue(undefined);
  expect((await post('/desktop/worker/models', 'models', raw)).status).toBe(401);
  repository.session.mockResolvedValue(undefined);
  expect((await post('/desktop/worker/models', 'models', raw)).status).toBe(401);
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
  vi.mocked(getConfig).mockResolvedValue(
    settings({ enabled: true, clip: { enabled: true, modelName: 'ViT-B-32__openai' } }),
  );
  expect((await post('/desktop/worker/challenges', 'challenge', payload())).status).toBe(409);

  for (const machineLearning of [
    { enabled: false, clip: { enabled: true, modelName: profile.modelName } },
    { enabled: true, clip: { enabled: false, modelName: profile.modelName } },
  ]) {
    vi.mocked(getConfig).mockResolvedValue(settings(machineLearning));
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
  activation.activate.mockRejectedValueOnce(new ConflictException('desktop_pool_policy_changed'));
  expect((await post('/desktop/worker/challenges/' + id + '/report', 'qualification:' + id, raw)).status).toBe(409);
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
  const accepted = acceptedRow();
  challenges.readAccepted.mockResolvedValue(accepted);
  const path = `/desktop/worker/qualifications/${id}`;
  activation.activate.mockRejectedValueOnce(new ConflictException('desktop_pool_policy_changed'));
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
      activation as never,
      repository as never,
      {} as never,
      holds as never,
    );
    await expect(service.issue(undefined, undefined, payload())).rejects.toThrow('desktop_model_profile_unavailable');
    expect(challenges.issue).not.toHaveBeenCalled();
  } finally {
    authority.spaces = undefined;
  }
});

it('serves protocol 2 inventory with the catalogue profiles through the response contract', async () => {
  vi.mocked(getConfig).mockResolvedValue(structuredClone(defaults));
  const raw = JSON.stringify({
    provider: profile.spec.provider,
    runtimeSourceRevision: profile.runtimeSourceRevision,
    protocolVersion: 2,
  });
  const response = await post('/desktop/worker/models', 'models', raw);
  expect(response.status).toBe(200);
  expect(response.body.protocolVersion).toBe(2);
  const clip = response.body.workloads.find((item: { workload: string }) => item.workload === 'clip');
  expect(clip.profiles.map((item: { modelKey: string }) => item.modelKey)).toEqual(clip.modelKeys);
  expect(clip.profiles[0].fixtureBase64).toEqual(expect.any(String));
});

it('issues a challenge from the catalogue without running anything on the server', async () => {
  const response = await post('/desktop/worker/challenges', 'challenge', payload());
  expect(response.status).toBe(200);
  expect(challenges.issue).toHaveBeenCalledOnce();
});

it('refuses a task the settings turned off with a named code, and logs it', async () => {
  vi.mocked(getConfig).mockResolvedValue(
    settings({ enabled: true, clip: { enabled: false, modelName: profile.modelName } }),
  );
  const warn = vi.spyOn(LoggingRepository.prototype, 'warn');
  const response = await post('/desktop/worker/challenges', 'challenge', payload());
  expect(response.status).toBe(409);
  expect(response.body.message).toBe('desktop_model_profile_unavailable');
  expect(challenges.issue).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('desktop_model_profile_unavailable'));
});

it('accepts an explicit protocol 1 on the inventory and answers it as protocol 1', async () => {
  vi.mocked(getConfig).mockResolvedValue(structuredClone(defaults));
  const raw = JSON.stringify({
    provider: profile.spec.provider,
    runtimeSourceRevision: profile.runtimeSourceRevision,
    protocolVersion: 1,
  });
  const response = await post('/desktop/worker/models', 'models', raw);
  expect(response.status).toBe(200);
  expect(response.body.protocolVersion).toBe(1);
  expect(JSON.stringify(response.body)).not.toContain('profiles');
  expect((await post('/desktop/worker/models', 'models', raw.replace(':1}', ':3}'))).status).toBe(400);
});

it('challenges only the keys the inventory lists: a face or OCR key no task will use is refused', async () => {
  vi.mocked(getConfig).mockResolvedValue(structuredClone(defaults));
  const catalogue = parseDesktopModelCatalogue(
    JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8')),
  );
  const service = new DesktopQualificationService(
    { authenticate: vi.fn().mockResolvedValue(grant) } as never,
    challenges as never,
    {} as never,
    {} as never,
    activation as never,
    repository as never,
    {} as never,
    holds as never,
  );
  const ask = (item: (typeof catalogue.profiles)[number]) =>
    service.issue(
      undefined,
      undefined,
      JSON.stringify({
        ...JSON.parse(payload()),
        modelKey: item.modelKey,
        provider: item.spec.provider,
        runtimeSourceRevision: item.runtimeSourceRevision,
      }),
    );
  for (const [workload, entries, released] of [
    ['face', faceEntries(defaults.machineLearning.facialRecognition), desktopImageModelKey('face', 'buffalo_l')],
    ['ocr', ocrEntries(defaults.machineLearning.ocr), desktopImageModelKey('ocr', 'PP-OCRv5_mobile')],
  ] as const) {
    const configured = catalogue.profiles.filter(
      (item) => item.workload === workload && canonicalJson(item.spec.entries) === canonicalJson(entries),
    );
    // an earlier runtime's key for the configured model and settings: nothing is ever leased under it
    const unused = configured.find((item) => item.modelKey !== released)!;
    expect(unused).toBeDefined();
    await expect(ask(unused)).rejects.toMatchObject({ status: 409, message: 'desktop_model_profile_unavailable' });
    // the released key gets past selection (and stops at the runtime attestation this request does not carry)
    await expect(ask(configured.find((item) => item.modelKey === released)!)).rejects.toMatchObject({
      message: 'desktop_runtime_attestation_invalid',
    });
  }
  expect(challenges.issue).not.toHaveBeenCalled();
});

it('names and logs every refusal of a report, a challenge read and a qualification read', async () => {
  const warn = vi.spyOn(LoggingRepository.prototype, 'warn');
  const raw = JSON.stringify({ report: report() });
  const submit = () => post(`/desktop/worker/challenges/${id}/report`, 'qualification:' + id, raw);
  // the desktop holds its limit of qualifications: a conflict it can retry, not a server error
  challenges.record.mockRejectedValue(new Error('desktop_qualification_capacity'));
  const full = await submit();
  expect([full.status, full.body.message]).toEqual([409, 'desktop_qualification_capacity']);
  // the report no longer matches its challenge: still 200, and in the log
  challenges.record.mockResolvedValue(false);
  const stale = await submit();
  expect([stale.status, stale.body]).toEqual([200, { accepted: false }]);
  // Desktop AI processing was turned off for the account between the challenge and the report
  const { ForbiddenException } = await import('@nestjs/common');
  challenges.record.mockResolvedValue(true);
  activation.activate.mockRejectedValue(new ForbiddenException('desktop_pool_policy_required'));
  const off = await submit();
  expect([off.status, off.body.message]).toEqual([403, 'desktop_pool_policy_required']);
  challenges.read.mockResolvedValue(undefined);
  challenges.readAccepted.mockResolvedValue(undefined);
  const get = (path: string, operation: string) =>
    request(app).get(path).auth(token, { type: 'bearer' }).set('x-frameleaf-desktop-proof', proof(operation, ''));
  expect((await get('/desktop/worker/challenges/' + id, 'challenge:' + id)).status).toBe(401);
  expect((await get('/desktop/worker/qualifications/' + id, 'accepted-qualification:' + id)).status).toBe(401);
  const subject = `challenge ${id}, device ${id}, ${profile.modelKey}`;
  expect(warn.mock.calls.map(([message]) => message)).toEqual([
    `Desktop worker report refused (${subject}): 409 desktop_qualification_capacity`,
    `Desktop worker report refused (${subject}): 200 accepted:false`,
    `Desktop worker report refused (${subject}): 403 desktop_pool_policy_required`,
    `Desktop worker challenge read refused (challenge ${id}, device ${id}): 401 desktop_challenge_invalid`,
    `Desktop worker qualification read refused (qualification ${id}, device ${id}): 401 desktop_qualification_invalid`,
  ]);
});

it('answers 403 desktop_pool_policy_required when the account turned Desktop AI processing off', async () => {
  repository.session.mockResolvedValue(undefined);
  repository.policyOff.mockResolvedValue({
    deviceId: id,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    authorizationEpoch: 2,
  });
  const response = await post('/desktop/worker/challenges', 'challenge', payload());
  expect([response.status, response.body.message]).toEqual([403, 'desktop_pool_policy_required']);
});

it('holds back a desktop that lost a model for failing it: no new challenge and no grant until the hold ends', async () => {
  const broker = { heldUntil: vi.fn().mockResolvedValue(new Date(Date.now() + 60_000)), clearWithdrawal: vi.fn() };
  const service = new DesktopQualificationService(
    { authenticate: vi.fn().mockResolvedValue(grant) } as never,
    challenges as never,
    {} as never,
    {} as never,
    activation as never,
    repository as never,
    {} as never,
    broker as never,
  );
  // a conflict the desktop retries, like the rest of the challenge bookkeeping
  await expect(service.issue(undefined, undefined, payload())).rejects.toMatchObject({
    status: 409,
    message: 'desktop_qualification_hold',
  });
  expect(broker.heldUntil).toHaveBeenCalledWith(id, expect.arrayContaining([profile.modelKey]));
  await expect(service.record(undefined, undefined, id, JSON.stringify({ report: report() }))).rejects.toMatchObject({
    status: 409,
    message: 'desktop_qualification_hold',
  });
  expect(challenges.issue).not.toHaveBeenCalled();
  expect(challenges.record).not.toHaveBeenCalled();
  broker.heldUntil.mockResolvedValue(undefined);
  await expect(service.issue(undefined, undefined, payload())).resolves.toMatchObject({ id });
  // and once a report grants the model again, the withdrawal is over
  await expect(service.record(undefined, undefined, id, JSON.stringify({ report: report() }))).resolves.toEqual({
    accepted: true,
  });
  expect(broker.clearWithdrawal).toHaveBeenCalledExactlyOnceWith(id, profile.modelKey);
});
