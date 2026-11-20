import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaults } from 'src/config.js';
import { MlWorkload } from 'src/enum.js';
import { DesktopQualificationService } from 'src/services/desktop-qualification.service.js';
import { getConfig } from 'src/utils/config.js';

vi.mock('src/utils/config.js', () => ({ getConfig: vi.fn() }));
const auth = { authenticate: vi.fn() };
const workers = { owner: vi.fn() };
const policies = { read: vi.fn() };
const grant = { deviceId: 'device', sessionId: 'session', authorizationEpoch: 2, credentialHash: Buffer.alloc(32) };
const catalogue = JSON.parse(readFileSync(join(process.cwd(), 'resources/desktop/model-catalogue.json'), 'utf8'));
const payload = JSON.stringify({
  provider: 'CPUExecutionProvider',
  runtimeSourceRevision: catalogue.profiles[0].runtimeSourceRevision,
});
const service = new DesktopQualificationService(
  auth as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  workers as never,
  policies as never,
  {} as never,
);

beforeEach(() => {
  vi.resetAllMocks();
  auth.authenticate.mockResolvedValue(grant);
  workers.owner.mockResolvedValue('owner');
  policies.read.mockResolvedValue({ revisionId: 'policy' });
  vi.mocked(getConfig).mockResolvedValue(structuredClone(defaults));
});

it('authenticates exact inventory bytes and returns only advisory selected-model facts', async () => {
  const result = await service.inventory('token', 'proof', payload);
  expect(auth.authenticate).toHaveBeenCalledWith('token', 'proof', 'models', payload);
  expect(workers.owner).toHaveBeenCalledWith(grant);
  expect(policies.read).toHaveBeenCalledWith('owner');
  expect(result).toMatchObject({ protocolVersion: 1, ...JSON.parse(payload) });
  expect(result.workloads).toHaveLength(4);
  expect(result.workloads.find((item) => item.workload === MlWorkload.Clip)?.state).toBe('eligible');
  expect(JSON.stringify(result)).not.toMatch(/authToken|destinationId|credentialHash|https?:/);
});

it('refuses invalid credentials before reading settings or owner facts', async () => {
  auth.authenticate.mockRejectedValue(new Error('invalid'));
  await expect(service.inventory('token', 'proof', payload)).rejects.toThrow('invalid');
  expect(workers.owner).not.toHaveBeenCalled();
  expect(getConfig).not.toHaveBeenCalled();
});

it('requires a current owner and enabled account policy', async () => {
  workers.owner.mockResolvedValue(undefined);
  await expect(service.inventory('token', 'proof', payload)).rejects.toThrow('desktop_worker_credential_invalid');
  workers.owner.mockResolvedValue('owner');
  policies.read.mockResolvedValue(undefined);
  await expect(service.inventory('token', 'proof', payload)).rejects.toThrow('desktop_pool_policy_required');
  expect(getConfig).not.toHaveBeenCalled();
});

it('refuses caller-supplied settings', async () => {
  await expect(
    service.inventory('token', 'proof', JSON.stringify({ ...JSON.parse(payload), url: 'http://other' })),
  ).rejects.toThrow('desktop_qualification_payload_invalid');
});

it('offers every enabled task from the machine-learning settings alone, with no destination or route', async () => {
  const result = await service.inventory('token', 'proof', payload);
  expect(result.workloads.map((item) => item.state)).not.toContain('pinned');
  expect(result.workloads.map((item) => item.state)).not.toContain('legacy');
  expect(result.workloads.map((item) => item.state)).not.toContain('unavailable');
  const config = structuredClone(defaults);
  config.machineLearning.clip.enabled = false;
  vi.mocked(getConfig).mockResolvedValue(config);
  const disabled = await service.inventory('token', 'proof', payload);
  expect(disabled.workloads.find((item) => item.workload === MlWorkload.Clip)?.state).toBe('disabled');
});

it('serves the server’s own catalogue profile for each eligible model on protocol 2, and none on protocol 1', async () => {
  const v1 = await service.inventory('token', 'proof', payload);
  expect(v1.protocolVersion).toBe(1);
  expect(v1.workloads.every((item) => !('profiles' in item))).toBe(true);
  const v2 = await service.inventory('token', 'proof', JSON.stringify({ ...JSON.parse(payload), protocolVersion: 2 }));
  expect(v2.protocolVersion).toBe(2);
  const eligible = v2.workloads.filter((item) => item.state === 'eligible');
  expect(eligible.length).toBeGreaterThan(0);
  for (const item of eligible) {
    expect(item.profiles!.map((profile) => profile.modelKey)).toEqual(item.modelKeys);
    for (const profile of item.profiles!)
      expect(profile).toEqual(
        catalogue.profiles.find(
          (raw: { modelKey: string; spec: { provider: string }; runtimeSourceRevision: string }) =>
            raw.modelKey === profile.modelKey &&
            raw.spec.provider === 'CPUExecutionProvider' &&
            raw.runtimeSourceRevision === JSON.parse(payload).runtimeSourceRevision,
        ),
      );
  }
  expect(v2.workloads.filter((item) => item.state !== 'eligible' && item.profiles !== undefined)).toEqual([]);
});
