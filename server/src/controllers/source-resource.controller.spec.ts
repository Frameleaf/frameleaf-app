import { UnauthorizedException } from '@nestjs/common';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { SourceResourceController } from 'src/controllers/source-resource.controller.js';
import { sourceGrantMessage, sourceResourceMessage } from 'src/dtos/source-resource.dto.js';
import { SourceResourceReadRepository } from 'src/repositories/source-resource-read.repository.js';
import { SourceResourceRepository } from 'src/repositories/source-resource.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { SourceResourceAuthService } from 'src/services/source-resource-auth.service.js';
import { SourceResourceReadService } from 'src/services/source-resource-read.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { controllerSetup } from 'test/utils.js';

const id = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const keys = generateKeyPairSync('ed25519');
const auth: AuthDto = {
  ...authStub.user1,
  user: { ...authStub.user1.user, id: ownerId },
  session: { ...authStub.user1.session!, id },
};
it('issues only a source credential through photo authentication and rejects malformed or replayed authority', async () => {
  const credential = {
    grantId: id,
    sourceId: id,
    deviceId: id,
    ownerId,
    scopeFingerprint: 'a'.repeat(64),
    authorizationEpoch: 7,
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    expiresAt: new Date(Date.now() + 3_600_000),
  };
  const repository = { device: vi.fn().mockResolvedValue(credential), issue: vi.fn().mockResolvedValue(credential) };
  const http = await controllerSetup(SourceResourceController, [
    SourceResourceAuthService,
    { provide: SourceResourceReadService, useValue: {} },
    { provide: SourceResourceRepository, useValue: repository },
    { provide: SystemMetadataRepository, useValue: { get: vi.fn().mockResolvedValue({ id: 'server' }) } },
  ]);
  const input = {
    sourceId: id,
    deviceId: id,
    scopeFingerprint: credential.scopeFingerprint,
    requestId: id,
    timestamp: Date.now(),
    signature: '',
  };
  input.signature = sign(null, Buffer.from(sourceGrantMessage('server', ownerId, input)), keys.privateKey).toString(
    'base64',
  );
  try {
    http.authenticate.mockResolvedValue(auth);
    const response = await request(http.getHttpServer()).post('/source-resources/grants').send(input);
    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body.scopes).toEqual(['source-original-read']);
    expect(response.body.sourceToken).toMatch(/^flsrc1_[a-f0-9]{64}$/u);
    expect(response.body).not.toHaveProperty('workerToken');
    for (const extra of [{ root: '/private' }, { workerToken: 'a'.repeat(64) }, { scopeFingerprint: 'bad' }]) {
      repository.issue.mockClear();
      expect(
        (
          await request(http.getHttpServer())
            .post('/source-resources/grants')
            .send({ ...input, ...extra })
        ).status,
      ).toBe(400);
      expect(repository.issue).not.toHaveBeenCalled();
    }
    repository.issue.mockResolvedValueOnce(undefined);
    expect((await request(http.getHttpServer()).post('/source-resources/grants').send(input)).status).toBe(401);
    for (const extra of [{ apiKey: {} }, { sharedLink: {} }, { system: {} }]) {
      http.authenticate.mockResolvedValue({ ...auth, ...extra } as AuthDto);
      expect((await request(http.getHttpServer()).post('/source-resources/grants').send(input)).status).toBe(403);
    }
    http.authenticate.mockRejectedValueOnce(new UnauthorizedException());
    expect((await request(http.getHttpServer()).post('/source-resources/grants').send(input)).status).toBe(401);
  } finally {
    await http.close();
  }
});

it('accepts source-signed poll and heartbeat without accepting photo or inference credentials', async () => {
  const token = `flsrc1_${'a'.repeat(64)}`;
  const grant = {
    grantId: id,
    sourceId: id,
    ownerId,
    deviceId: id,
    photoSessionId: id,
    scopeFingerprint: 'a'.repeat(64),
    authorizationEpoch: 7,
    credentialHash: createHash('sha256').update(token).digest(),
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    expiresAt: new Date(Date.now() + 3_600_000),
  };
  const repository = { session: vi.fn().mockResolvedValue(grant), consume: vi.fn().mockResolvedValue(grant) };
  const row = {
    ...grant,
    id,
    resourceKey: 'b'.repeat(64),
    version: 'c'.repeat(64),
    sha256: 'd'.repeat(64),
    bytes: 64,
    claimFence: 1,
    leaseUntil: new Date(Date.now() + 60_000),
    deadline: new Date(Date.now() + 600_000),
  };
  const reads = { claim: vi.fn().mockResolvedValue(row), heartbeat: vi.fn().mockResolvedValue(row) };
  const http = await controllerSetup(SourceResourceController, [
    SourceResourceAuthService,
    SourceResourceReadService,
    { provide: SourceResourceRepository, useValue: repository },
    { provide: SourceResourceReadRepository, useValue: reads },
    { provide: SystemMetadataRepository, useValue: { get: vi.fn().mockResolvedValue({ id: 'server' }) } },
  ]);
  const proof = (operation: string, payload: string) => {
    const value = { grantId: id, sequence: 1, timestamp: Date.now(), signature: '' };
    value.signature = sign(
      null,
      Buffer.from(sourceResourceMessage({ ...grant, serverId: 'server' }, token, value, operation, payload)),
      keys.privateKey,
    ).toString('base64');
    return Buffer.from(JSON.stringify(value)).toString('base64');
  };
  const send = (operation: string, payload: string, bearer = token, header = proof(operation, payload)) =>
    request(http.getHttpServer())
      .post(`/source-resources/${operation}`)
      .set('Authorization', `Bearer ${bearer}`)
      .set('x-frameleaf-source-proof', header)
      .send({ payload });
  try {
    const payload = '{"maxBytes":128}';
    const poll = await send('poll', payload);
    expect(poll.status).toBe(200);
    expect(poll.headers['cache-control']).toBe('private, no-store');
    expect(poll.body.request).toMatchObject({ id, sourceId: id, version: row.version });
    expect(poll.body.request).not.toHaveProperty('ownerId');
    expect(poll.body.request).not.toHaveProperty('credentialHash');
    expect(http.authenticate).not.toHaveBeenCalled();
    for (const bearer of ['photo-session', 'a'.repeat(64)]) {
      reads.claim.mockClear();
      expect((await send('poll', payload, bearer)).status).toBe(401);
      expect(reads.claim).not.toHaveBeenCalled();
    }
    reads.claim.mockClear();
    expect((await send('poll', payload, token, proof('heartbeat', payload))).status).toBe(401);
    expect((await send('poll', '{"maxBytes":129}', token, proof('poll', payload))).status).toBe(401);
    expect((await send('poll', '{"maxBytes":128,"path":"/private"}')).status).toBe(400);
    expect(reads.claim).not.toHaveBeenCalled();
    const heartbeat = JSON.stringify({ requestId: id, claimFence: 1, claimToken: poll.body.request.claimToken });
    const renewed = await send('heartbeat', heartbeat);
    expect(renewed.status).toBe(200);
    expect(renewed.headers['cache-control']).toBe('private, no-store');
    expect(renewed.body).toEqual({ leaseUntil: row.leaseUntil.toISOString(), deadline: row.deadline.toISOString() });
    reads.heartbeat.mockResolvedValueOnce(undefined);
    expect((await send('heartbeat', heartbeat)).status).toBe(409);
  } finally {
    await http.close();
  }
});
