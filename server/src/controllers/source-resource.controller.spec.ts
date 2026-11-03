import { UnauthorizedException } from '@nestjs/common';
import { generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { SourceResourceController } from 'src/controllers/source-resource.controller.js';
import { sourceGrantMessage } from 'src/dtos/source-resource.dto.js';
import { SourceResourceRepository } from 'src/repositories/source-resource.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { SourceResourceAuthService } from 'src/services/source-resource-auth.service.js';
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
