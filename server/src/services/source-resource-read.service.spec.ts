import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SourceReadPollDto } from 'src/dtos/source-resource-read.dto.js';
import { SourceResourceReadService } from 'src/services/source-resource-read.service.js';

const id = '11111111-1111-4111-8111-111111111111';
const grant = { sourceId: id, scopeFingerprint: 'a'.repeat(64), authorizationEpoch: 7 };
const hash = (value: string) => createHash('sha256').update(value).digest();
const row = {
  ...grant,
  id,
  claimFence: 3,
  resourceKey: 'b'.repeat(64),
  version: 'c'.repeat(64),
  sha256: 'd'.repeat(64),
  bytes: 64,
  leaseUntil: new Date('2026-10-22T03:00:00.000Z'),
  deadline: new Date('2026-10-22T03:01:00.000Z'),
  assetId: id,
  resourceId: id,
  ownerId: id,
  deviceId: id,
  originalPath: '/private/original',
};
const auth = { authenticate: vi.fn() };
const reads = { claim: vi.fn(), heartbeat: vi.fn() };
let service: SourceResourceReadService;
beforeEach(() => {
  vi.resetAllMocks();
  auth.authenticate.mockResolvedValue(grant);
  reads.claim.mockResolvedValue(row);
  reads.heartbeat.mockResolvedValue(row);
  service = new SourceResourceReadService(auth as never, reads as never);
});
it('issues a bounded source-only claim and persists only a hash of its random bearer', async () => {
  const payload = '{"maxBytes":128}';
  const result = await service.poll('source bearer', 'installation proof', payload);
  expect(auth.authenticate).toHaveBeenCalledWith('source bearer', 'installation proof', 'poll', payload);
  expect(result.request).toEqual({
    id,
    sourceId: id,
    scopeFingerprint: grant.scopeFingerprint,
    authorizationEpoch: 7,
    claimFence: 3,
    resourceKey: row.resourceKey,
    version: row.version,
    sha256: row.sha256,
    bytes: 64,
    claimToken: expect.stringMatching(/^[a-f0-9]{64}$/u),
    leaseUntil: row.leaseUntil.toISOString(),
    deadline: row.deadline.toISOString(),
  });
  expect(reads.claim).toHaveBeenCalledWith(grant, hash(result.request!.claimToken), 128);
  const second = await service.poll('source bearer', 'next proof', payload);
  expect(second.request!.claimToken).not.toBe(result.request!.claimToken);
  expect(JSON.stringify(result)).not.toContain('/private');
});
it('returns no request when the durable queue has no admissible resource', async () => {
  reads.claim.mockResolvedValue(undefined);
  await expect(service.poll('bearer', 'proof', '{"maxBytes":128}')).resolves.toEqual({ request: null });
});
it.each(['poll', 'heartbeat'] as const)('never reaches the queue after %s authentication fails', async (method) => {
  auth.authenticate.mockRejectedValue(new UnauthorizedException('source_credential_invalid'));
  const payload =
    method === 'poll'
      ? '{"maxBytes":128}'
      : JSON.stringify({ requestId: id, claimFence: 3, claimToken: 'e'.repeat(64) });
  await expect(service[method]('photo or inference bearer', 'proof', payload)).rejects.toThrow(
    'source_credential_invalid',
  );
  expect(reads.claim).not.toHaveBeenCalled();
  expect(reads.heartbeat).not.toHaveBeenCalled();
});
it.each([
  'null',
  '[]',
  '{}',
  '{"maxBytes":0}',
  '{"maxBytes":1.5}',
  '{"maxBytes":9007199254740992}',
  '{"maxBytes":128,"path":"/private"}',
  '界'.repeat(32_769),
])('rejects invalid poll payload without queue work', async (payload) => {
  await expect(service.poll('bearer', 'proof', payload)).rejects.toThrow('source_read_payload_invalid');
  expect(reads.claim).not.toHaveBeenCalled();
});
it('renews only the exact signed request, fence and hashed claim token', async () => {
  const payload = JSON.stringify({ requestId: id, claimFence: 3, claimToken: 'e'.repeat(64) });
  await expect(service.heartbeat('bearer', 'proof', payload)).resolves.toEqual({
    leaseUntil: row.leaseUntil.toISOString(),
    deadline: row.deadline.toISOString(),
  });
  expect(auth.authenticate).toHaveBeenCalledWith('bearer', 'proof', 'heartbeat', payload);
  expect(reads.heartbeat).toHaveBeenCalledWith(grant, id, 3, hash('e'.repeat(64)));
  reads.heartbeat.mockResolvedValue(undefined);
  await expect(service.heartbeat('bearer', 'proof', payload)).rejects.toThrow('source_read_lease_invalid');
});
it.each([
  { requestId: '../private', claimFence: 3, claimToken: 'e'.repeat(64) },
  { requestId: id, claimFence: 0, claimToken: 'e'.repeat(64) },
  { requestId: id, claimFence: 2_147_483_648, claimToken: 'e'.repeat(64) },
  { requestId: id, claimFence: 3, claimToken: 'E'.repeat(64) },
  { requestId: id, claimFence: 3, claimToken: 'e'.repeat(64), path: '/private' },
])('rejects invalid heartbeat identity or authority', async (value) => {
  await expect(service.heartbeat('bearer', 'proof', JSON.stringify(value))).rejects.toThrow(
    'source_read_payload_invalid',
  );
  expect(reads.heartbeat).not.toHaveBeenCalled();
});

it('accepts the native companion shared read-request wire fixture without projecting extra fields', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('../../test/fixtures/source-resource/read-v1.json', import.meta.url), 'utf8'),
  );
  expect(SourceReadPollDto.schema.parse(fixture)).toEqual(fixture);
  expect(SourceReadPollDto.schema.safeParse({ request: { ...fixture.request, path: '/private' } }).success).toBe(false);
});
