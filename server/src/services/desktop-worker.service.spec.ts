import { readFileSync } from 'node:fs';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DesktopWorkerService } from 'src/services/desktop-worker.service.js';
import { assertDesktopResult } from 'src/utils/desktop-result.js';

const grant = { deviceId: 'device', sessionId: 'session', authorizationEpoch: 2, credentialHash: Buffer.alloc(32, 7) };
const auth = { authenticate: vi.fn(), renew: vi.fn() };
const broker = {
  claim: vi.fn(),
  input: vi.fn(),
  heartbeatLease: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  attemptModelKey: vi.fn(),
  withdraw: vi.fn(),
  countFailure: vi.fn(),
  countCancel: vi.fn(),
  clearFailures: vi.fn(),
  withdrawnModels: vi.fn(),
  heldLeases: vi.fn(),
  rememberCapacity: vi.fn(),
};
const warn = vi.spyOn(LoggingRepository.prototype, 'warn').mockImplementation(() => {});
const warnings = () => warn.mock.calls.map(([message]) => message);
const sessions = { revoke: vi.fn() };
let service: DesktopWorkerService;
beforeEach(() => {
  vi.resetAllMocks();
  warn.mockImplementation(() => {});
  auth.authenticate.mockResolvedValue(grant);
  broker.attemptModelKey.mockResolvedValue('face:model');
  service = new DesktopWorkerService(auth as never, broker as never, sessions as never, broker as never);
});
it('authenticates the exact claim bytes and returns only immutable task/lease metadata', async () => {
  broker.claim.mockResolvedValue({
    task: {
      id: 'task',
      modelKey: 'model',
      config: { z: 1, a: 2 },
      configSha256: 'config-hash',
      inputSha256: 'input-hash',
      inputKind: 'text',
      deadlineAt: new Date('2026-10-15T21:00:00Z'),
      input: Buffer.from('private'),
      ownerId: 'private-owner',
    },
    attempt: {
      id: 'attempt',
      qualificationId: 'qualification',
      generation: 3,
      expiresAt: new Date('2026-10-15T20:59:00Z'),
    },
    qualificationId: 'current-qualification',
    workerModelKey: 'model-of-this-desktop',
    qualificationExpiresAt: new Date('2026-10-15T20:59:30Z'),
  });
  const payload = '{"modelKeys":["model"],"waitMs":0}';
  const result = await service.claim('token', 'proof', payload, new AbortController().signal);
  expect(auth.authenticate).toHaveBeenCalledWith('token', 'proof', 'claim', payload);
  expect(broker.claim).toHaveBeenCalledWith(grant, ['model'], undefined);
  // a desktop that holds one lease says nothing about slots, and nothing is remembered about it
  expect(broker.rememberCapacity).not.toHaveBeenCalled();
  expect(result.task).toMatchObject({
    id: 'attempt',
    taskId: 'task',
    sessionId: 'session',
    authorizationEpoch: 2,
    configJson: '{"a":2,"z":1}',
    generation: 3,
    maxInputBytes: 16_777_216,
    // the desktop's current qualification and the key it holds the model under, not the task's bookkeeping
    qualificationId: 'current-qualification',
    modelKey: 'model-of-this-desktop',
    qualificationExpiresAt: '2026-10-15T20:59:30.000Z',
  });
  expect(result.task).not.toHaveProperty('input');
  expect(result.task).not.toHaveProperty('ownerId');
});
it('returns an empty claim without retrying an empty model scope', async () => {
  expect(
    await service.claim('token', 'proof', '{"modelKeys":[],"waitMs":20000}', new AbortController().signal),
  ).toEqual({ task: null });
  expect(broker.claim).not.toHaveBeenCalled();
});
it('bounds claim windows and rejects unknown or malformed payloads', async () => {
  for (const payload of ['not json', '{"modelKeys":["m"],"waitMs":20001}', '{"modelKeys":["m"],"url":"https://other"}'])
    await expect(service.claim('token', 'proof', payload, new AbortController().signal)).rejects.toThrow();
  expect(broker.claim).not.toHaveBeenCalled();
});
it('cancels a waiting claim when the outbound connection closes', async () => {
  broker.claim.mockResolvedValue(undefined);
  const controller = new AbortController();
  const result = service.claim('token', 'proof', '{"modelKeys":["m"],"waitMs":20000}', controller.signal);
  await vi.waitFor(() => expect(broker.claim).toHaveBeenCalledTimes(1));
  controller.abort();
  await expect(result).rejects.toThrow();
});
it('hands a task straight back when the desktop hung up while its lease was being made', async () => {
  const controller = new AbortController();
  const lease = { task: { id: 'task', modelKey: 'face:model' }, attempt: { id: 'attempt' }, resumed: false };
  broker.fail.mockResolvedValue(true);
  broker.countCancel.mockResolvedValue(6);
  broker.countFailure.mockResolvedValue(1);
  broker.claim.mockImplementation(() => {
    controller.abort();
    return Promise.resolve(lease);
  });
  await expect(service.claim('token', 'proof', '{"modelKeys":["m"],"waitMs":0}', controller.signal)).rejects.toThrow();
  expect(broker.fail).toHaveBeenCalledExactlyOnceWith(grant, 'attempt', 'cancelled');
  // it is a hand-back like any other, and past the cap a failure
  expect(broker.countCancel).toHaveBeenCalledExactlyOnceWith(grant, 'face:model');
  expect(broker.countFailure).toHaveBeenCalledExactlyOnceWith(grant, 'face:model', false);
  // a lease the desktop already held and is working on is left alone
  broker.fail.mockClear();
  broker.claim.mockResolvedValue({ ...lease, resumed: true });
  await expect(service.claim('token', 'proof', '{"modelKeys":["m"],"waitMs":0}', controller.signal)).rejects.toThrow();
  expect(broker.fail).not.toHaveBeenCalled();
});
it('binds input and result proofs to the exact attempt and passes only scoped input', async () => {
  broker.input.mockResolvedValue(Buffer.from('fixture'));
  broker.complete.mockResolvedValue(true);
  expect(await service.input('token', 'proof', 'attempt')).toEqual(Buffer.from('fixture'));
  expect(auth.authenticate).toHaveBeenLastCalledWith('token', 'proof', 'input:attempt', '');
  expect(await service.complete('token', 'proof', 'attempt', '{"result":{"clip":"value"}}')).toEqual({
    accepted: true,
  });
  expect(auth.authenticate).toHaveBeenLastCalledWith('token', 'proof', 'result:attempt', '{"result":{"clip":"value"}}');
  expect(broker.complete).toHaveBeenCalledWith(grant, 'attempt', { clip: 'value' }, assertDesktopResult);
});
it('rejects stale input and malformed/nonfinite/oversized result envelopes', async () => {
  broker.input.mockResolvedValue(undefined);
  await expect(service.input('token', 'proof', 'attempt')).rejects.toThrow('desktop_lease_invalid');
  for (const payload of [
    '{"result":{"x":1e999}}',
    '{"result":[],"extra":1}',
    '{"result":{"x":"' + 'a'.repeat(4 * 1024 * 1024) + '"}}',
  ])
    await expect(service.complete('token', 'proof', 'attempt', payload)).rejects.toThrow();
  expect(broker.complete).not.toHaveBeenCalled();
});
it('requires signed bounded heartbeat/failure/renewal/revocation operations', async () => {
  broker.heartbeatLease.mockResolvedValue(new Date('2026-10-15T21:00:00Z'));
  broker.fail.mockResolvedValue(false);
  sessions.revoke.mockResolvedValue(true);
  expect(await service.heartbeat('token', 'proof', '{"id":"445bc2b6-f4cd-439e-b8bb-7e84d7ee0550"}')).toEqual({
    accepted: true,
    expiresAt: '2026-10-15T21:00:00.000Z',
  });
  expect(await service.fail('token', 'proof', 'attempt', '{"code":"inference-failed"}')).toEqual({ accepted: false });
  expect(auth.authenticate).toHaveBeenLastCalledWith('token', 'proof', 'fail:attempt', '{"code":"inference-failed"}');
  await expect(service.fail('token', 'proof', 'attempt', '{"code":"run-shell"}')).rejects.toThrow();
  expect(await service.revoke('token', 'proof')).toEqual({ accepted: true });
  expect(auth.authenticate).toHaveBeenLastCalledWith('token', 'proof', 'revoke', '');
  await service.renew('token', 'proof', '{}');
  expect(auth.renew).toHaveBeenCalledWith('token', 'proof', '{}');
});
it('never invokes the broker when credential authentication fails', async () => {
  auth.authenticate.mockRejectedValue(new Error('invalid credential'));
  await expect(
    service.claim('photo-token', 'proof', '{"modelKeys":["m"],"waitMs":0}', new AbortController().signal),
  ).rejects.toThrow();
  expect(broker.claim).not.toHaveBeenCalled();
});

it('checks durable source and policy authority instead of serving raw broker input', async () => {
  const authority = { input: vi.fn().mockRejectedValue(new Error('desktop_pool_queue_changed')) };
  const guarded = new DesktopWorkerService(auth as never, broker as never, sessions as never, authority as never);
  broker.input.mockResolvedValue(Buffer.from('must not disclose'));
  // the job behind the lease ended while the desktop asked: a lost lease, not a server error
  await expect(guarded.input('token', 'proof', 'attempt')).rejects.toMatchObject({
    status: 401,
    message: 'desktop_lease_invalid',
  });
  expect(authority.input).toHaveBeenCalledWith(grant, 'attempt');
  expect(broker.input).not.toHaveBeenCalled();
  expect(warnings()).toContainEqual(
    'Desktop worker input refused (device device, attempt attempt, face:model): 401 desktop_lease_invalid (desktop_pool_queue_changed)',
  );
  authority.input.mockRejectedValue(new Error('Asset inputs changed before publication'));
  await expect(guarded.input('token', 'proof', 'attempt')).rejects.toMatchObject({ status: 401 });
  // anything that is not a lost lease stays a server error
  authority.input.mockRejectedValue(new Error('connection terminated'));
  await expect(guarded.input('token', 'proof', 'attempt')).rejects.toThrow('connection terminated');
  // so does a broken server invariant, even one named like a desktop refusal
  for (const fault of [
    'desktop_input_authority_unavailable',
    'desktop_input_authority_invalid',
    'desktop_clip_index_invalid',
  ]) {
    authority.input.mockRejectedValue(new Error(fault));
    await expect(guarded.input('token', 'proof', 'attempt')).rejects.not.toMatchObject({ status: 401 });
  }
});

describe('refusals (docs/desktop-worker-setup-protocol.md)', () => {
  it('logs a stale lease on input, heartbeat, result and fail with the device and model key', async () => {
    broker.input.mockResolvedValue(undefined);
    broker.heartbeatLease.mockResolvedValue(undefined);
    broker.complete.mockResolvedValue(false);
    broker.fail.mockResolvedValue(false);
    await expect(service.input('token', 'proof', 'attempt')).rejects.toMatchObject({ status: 401 });
    const id = '445bc2b6-f4cd-439e-b8bb-7e84d7ee0550';
    expect(await service.heartbeat('token', 'proof', `{"id":"${id}"}`)).toEqual({ accepted: false, expiresAt: null });
    expect(await service.complete('token', 'proof', 'attempt', '{"result":{}}')).toEqual({ accepted: false });
    expect(await service.fail('token', 'proof', 'attempt', '{"code":"cancelled"}')).toEqual({ accepted: false });
    expect(warnings()).toEqual([
      'Desktop worker input refused (device device, attempt attempt, face:model): 401 desktop_lease_invalid',
      `Desktop worker heartbeat refused (device device, attempt ${id}, face:model): 200 accepted:false`,
      'Desktop worker result refused (device device, attempt attempt, face:model): 200 accepted:false',
      'Desktop worker reported a failed task (device device, attempt attempt, face:model): cancelled, 200 accepted:false',
    ]);
  });

  it('logs a refused credential and a malformed payload on every endpoint', async () => {
    const { UnauthorizedException } = await import('@nestjs/common');
    await expect(service.fail('token', 'proof', 'attempt', '{"code":"run-shell"}')).rejects.toMatchObject({
      status: 400,
      message: 'desktop_worker_payload_invalid',
    });
    auth.authenticate.mockRejectedValue(new UnauthorizedException('desktop_worker_credential_invalid'));
    const signal = new AbortController().signal;
    await expect(service.claim('token', 'proof', '{"modelKeys":["m"],"waitMs":0}', signal)).rejects.toThrow();
    await expect(service.revoke('token', 'proof')).rejects.toThrow();
    // a refused credential is logged with the session its proof names, and a claim with the models it asked for
    const { ForbiddenException } = await import('@nestjs/common');
    const named = Buffer.from(
      JSON.stringify({
        sessionId: '1117c1ca-0495-46e9-b579-f321520c2b1a',
        sequence: 1,
        timestamp: 1,
        signature: Buffer.alloc(64).toString('base64'),
      }),
    ).toString('base64');
    await expect(service.revoke('token', named)).rejects.toThrow();
    auth.authenticate.mockResolvedValue(grant);
    broker.claim.mockRejectedValue(new ForbiddenException('desktop_pool_policy_required'));
    await expect(service.claim('token', 'proof', '{"modelKeys":["m1","m2"],"waitMs":0}', signal)).rejects.toThrow();
    expect(warnings()).toEqual([
      'Desktop worker fail refused (device device): 400 desktop_worker_payload_invalid',
      'Desktop worker claim refused (unauthenticated): 401 desktop_worker_credential_invalid',
      'Desktop worker session revoke refused (unauthenticated): 401 desktop_worker_credential_invalid',
      'Desktop worker session revoke refused (unauthenticated, session 1117c1ca-0495-46e9-b579-f321520c2b1a): 401 desktop_worker_credential_invalid',
      'Desktop worker claim refused (device device, models m1, m2): 403 desktop_pool_policy_required',
    ]);
  });

  it('refuses an oversized or malformed result when it is submitted, with a named 400', async () => {
    broker.complete.mockRejectedValue(new Error('desktop_result_too_large'));
    await expect(service.complete('token', 'proof', 'attempt', '{"result":{}}')).rejects.toMatchObject({
      status: 400,
      message: 'desktop_result_too_large',
    });
    // the broker runs the check on the task it has locked; a wrong shape never reaches the staged result
    broker.complete.mockImplementation((_grant, _id, result, validate) => {
      validate({ modelKey: 'face:model', inputKind: 'image' }, result);
      return Promise.resolve(true);
    });
    await expect(service.complete('token', 'proof', 'attempt', '{"result":{"faces":"none"}}')).rejects.toMatchObject({
      status: 400,
      message: 'desktop_result_invalid',
    });
    expect(warnings()).toEqual([
      'Desktop worker result refused (device device, attempt attempt, face:model): 400 desktop_result_too_large',
      'Desktop worker result refused (device device, attempt attempt, face:model): 400 desktop_result_invalid',
    ]);
  });

  it('checks a result against what its model returns', () => {
    const catalogue = JSON.parse(
      readFileSync(new URL('../../resources/desktop/model-catalogue.json', import.meta.url), 'utf8'),
    );
    for (const workload of ['clip', 'face', 'ocr']) {
      const profile = catalogue.profiles.find(
        (item: { workload: string; spec: { fixtureKind: string } }) =>
          item.workload === workload && item.spec.fixtureKind === 'image',
      );
      expect(() => assertDesktopResult(profile, profile.spec.expectedOutput)).not.toThrow();
      expect(() => assertDesktopResult(profile, {})).toThrow('desktop_result_invalid');
      expect(() => assertDesktopResult(profile, { ...profile.spec.expectedOutput, extra: 1 })).toThrow(
        'desktop_result_invalid',
      );
    }
    expect(() => assertDesktopResult({ modelKey: `clip:${'0'.repeat(64)}` }, { clip: '[]' })).toThrow(
      'desktop_result_invalid',
    );
  });
});

describe('a desktop that can run several tasks at once', () => {
  const signal = new AbortController().signal;
  const claim = (slots: number) =>
    service.claim('token', 'proof', `{"modelKeys":["m"],"waitMs":0,"slots":${slots}}`, signal);
  beforeEach(() => broker.claim.mockResolvedValue(undefined));

  it('passes its free slots to the broker and remembers how many it can run in all', async () => {
    broker.heldLeases.mockResolvedValue(2);
    await claim(3);
    expect(broker.claim).toHaveBeenCalledWith(grant, ['m'], 3);
    // two held and three more: five at once, which is what the queues start jobs for
    expect(broker.rememberCapacity).toHaveBeenCalledExactlyOnceWith(grant, 5);
    // the same total again (one more held, one fewer free) is not written again
    broker.heldLeases.mockResolvedValue(3);
    await claim(2);
    expect(broker.rememberCapacity).toHaveBeenCalledOnce();
    // its capacity dropped: one claim with the lower number is enough
    await claim(1);
    expect(broker.rememberCapacity).toHaveBeenLastCalledWith(grant, 4);
  });

  it('refuses a number of slots that is not a small positive whole number', async () => {
    for (const slots of [0, -1, 1.5, 65])
      await expect(claim(slots)).rejects.toMatchObject({ status: 400, message: 'desktop_worker_payload_invalid' });
    expect(broker.claim).not.toHaveBeenCalled();
  });
});

describe('a model the server took away from this desktop', () => {
  const signal = new AbortController().signal;
  const claim = (extra: string) =>
    service.claim('token', 'proof', `{"modelKeys":["m1","m2"],"waitMs":0${extra}}`, signal);

  it('is named to a desktop that asks, at once and instead of a task', async () => {
    broker.withdrawnModels.mockResolvedValue(['m2']);
    await expect(claim(',"reportWithdrawn":true')).rejects.toMatchObject({
      status: 409,
      message: 'desktop_qualification_hold',
    });
    expect(broker.withdrawnModels).toHaveBeenCalledWith('device', ['m1', 'm2']);
    expect(broker.claim).not.toHaveBeenCalled();
    expect(warnings()).toEqual([
      'Desktop worker claim refused (device device, withdrawn m2): 409 desktop_qualification_hold',
    ]);
  });

  it('changes nothing for a desktop that does not ask, or when nothing was taken away', async () => {
    broker.claim.mockResolvedValue(undefined);
    broker.withdrawnModels.mockResolvedValue(['m2']);
    // a desktop in the field: its claim answers as it always has
    expect(await claim('')).toEqual({ task: null });
    expect(await claim(',"reportWithdrawn":false')).toEqual({ task: null });
    expect(broker.withdrawnModels).not.toHaveBeenCalled();
    broker.withdrawnModels.mockResolvedValue([]);
    expect(await claim(',"reportWithdrawn":true')).toEqual({ task: null });
    expect(broker.claim).toHaveBeenCalledTimes(3);
  });
});

describe('a desktop that keeps failing a model', () => {
  const fail = (code: string) => service.fail('token', 'proof', 'attempt', `{"code":"${code}"}`);
  beforeEach(() => {
    broker.fail.mockResolvedValue(true);
    broker.complete.mockResolvedValue(true);
    broker.withdraw.mockResolvedValue(true);
  });

  it('logs the code it gave, with the device and model key, and passes it to the broker', async () => {
    expect(await fail('input-invalid')).toEqual({ accepted: true });
    expect(broker.fail).toHaveBeenCalledWith(grant, 'attempt', 'input-invalid');
    expect(warnings()).toEqual([
      'Desktop worker reported a failed task (device device, attempt attempt, face:model): input-invalid',
    ]);
  });

  it('loses the model at the third failure in a row the database counts, and must qualify again', async () => {
    broker.countFailure.mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    await fail('inference-failed');
    await fail('model-unavailable');
    expect(broker.countFailure).toHaveBeenLastCalledWith(grant, 'face:model', true);
    expect(broker.withdraw).not.toHaveBeenCalled();
    await fail('inference-failed');
    expect(broker.countFailure).toHaveBeenCalledTimes(3);
    expect(broker.countFailure).toHaveBeenLastCalledWith(grant, 'face:model', false);
    expect(broker.withdraw).toHaveBeenCalledExactlyOnceWith(grant, 'face:model');
    expect(warnings().at(-1)).toBe(
      'Desktop worker lost face:model after 3 failures in a row (device device): it must qualify again',
    );
  });

  it('counts a desktop that only ever hands work back as failing, past a few hand-backs in a while', async () => {
    // five hand-backs in the window are a person pausing; the sixth, seventh and eighth are failures
    for (const cancels of [1, 5]) {
      broker.countCancel.mockResolvedValueOnce(cancels);
      await fail('cancelled');
    }
    expect(broker.countCancel).toHaveBeenLastCalledWith(grant, 'face:model');
    expect(broker.countFailure).not.toHaveBeenCalled();
    broker.countFailure.mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3);
    // 0 is another task of a stop already counted: one stop is one hand-back past the cap too
    for (const cancels of [6, 0, 0, 7, 8]) {
      broker.countCancel.mockResolvedValueOnce(cancels);
      await fail('cancelled');
    }
    expect(broker.countFailure).toHaveBeenCalledTimes(3);
    expect(broker.withdraw).toHaveBeenCalledExactlyOnceWith(grant, 'face:model');
  });

  it('does not count a paused desktop, an unreadable photo or a stale lease', async () => {
    broker.countCancel.mockResolvedValueOnce(1);
    await fail('cancelled');
    await fail('input-invalid');
    broker.fail.mockResolvedValueOnce(false);
    await fail('inference-failed');
    expect(broker.countFailure).not.toHaveBeenCalled();
    expect(broker.withdraw).not.toHaveBeenCalled();
  });

  it('ends the run of failures with a result it got right, and not with one that was refused', async () => {
    await service.complete('token', 'proof', 'attempt', '{"result":{}}');
    expect(broker.clearFailures).toHaveBeenCalledExactlyOnceWith(grant, 'face:model');
    broker.complete.mockResolvedValue(false);
    await service.complete('token', 'proof', 'attempt', '{"result":{}}');
    expect(broker.clearFailures).toHaveBeenCalledOnce();
  });
});
