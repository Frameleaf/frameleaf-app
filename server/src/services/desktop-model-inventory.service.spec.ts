import { ConflictException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaults } from 'src/config.js';
import { MlWorkload } from 'src/enum.js';
import { DesktopQualificationService } from 'src/services/desktop-qualification.service.js';
import { getConfig } from 'src/utils/config.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';

vi.mock('src/utils/config.js', () => ({ getConfig: vi.fn() }));
const auth = { authenticate: vi.fn() };
const workers = { owner: vi.fn() };
const routes = { getRouteStates: vi.fn(), getAll: vi.fn(), assertRecoveryAuthority: vi.fn() };
const policies = { read: vi.fn() };
const producer = { verify: vi.fn(), verifyFace: vi.fn() };
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
  producer as never,
  {} as never,
  workers as never,
  routes as never,
  policies as never,
);

beforeEach(() => {
  vi.resetAllMocks();
  auth.authenticate.mockResolvedValue(grant);
  workers.owner.mockResolvedValue('owner');
  policies.read.mockResolvedValue({ revisionId: 'policy' });
  vi.mocked(getConfig).mockResolvedValue(structuredClone(defaults));
  routes.getRouteStates.mockResolvedValue(
    Object.values(MlWorkload).map((workload) => ({
      workload,
      origin: 'default',
      destinationId: mlDestinationStub.local.id,
      revisionId: 'revision',
    })),
  );
  routes.getAll.mockResolvedValue([mlDestinationStub.local]);
  routes.assertRecoveryAuthority.mockResolvedValue(undefined);
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
  expect(producer.verify).not.toHaveBeenCalled();
  expect(producer.verifyFace).not.toHaveBeenCalled();
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

it('refuses caller-supplied settings and reports destinations without recovery authority unavailable', async () => {
  await expect(
    service.inventory('token', 'proof', JSON.stringify({ ...JSON.parse(payload), url: 'http://other' })),
  ).rejects.toThrow('desktop_qualification_payload_invalid');
  routes.assertRecoveryAuthority.mockRejectedValue(new ConflictException('replacement_ml_authority_unavailable'));
  const result = await service.inventory('token', 'proof', payload);
  expect(result.workloads.filter((item) => item.state === 'eligible')).toEqual([]);
  expect(result.workloads.find((item) => item.workload === MlWorkload.Clip)?.state).toBe('unavailable');
});

it('does not hide infrastructure failures as unsupported models', async () => {
  routes.assertRecoveryAuthority.mockRejectedValue(new Error('database_unavailable'));
  await expect(service.inventory('token', 'proof', payload)).rejects.toThrow('database_unavailable');
});
