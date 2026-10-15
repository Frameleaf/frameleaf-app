import { Kysely } from 'kysely';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import request from 'supertest';
import z from 'zod';
import { DesktopWorkerController } from 'src/controllers/desktop-worker.controller.js';
import { desktopWorkerMessage } from 'src/dtos/desktop-worker.dto.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { DesktopMlRepository } from 'src/repositories/desktop-ml.repository.js';
import { DesktopWorkerRepository } from 'src/repositories/desktop-worker.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { DesktopMlService } from 'src/services/desktop-ml.service.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { DesktopWorkerService } from 'src/services/desktop-worker.service.js';
import { stableServerId } from 'src/utils/frameleaf-server-identity.js';
import { newMediumService } from 'test/medium.factory.js';
import { controllerSetup, getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
it('dispatches synthetic NAS input through signed HTTP claims and retains idempotent completion after consumption', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser({ isAdmin: true });
  const { session: photo } = await ctx.newSession({ userId: user.id });
  const keys = generateKeyPairSync('ed25519');
  const device = (await new DesktopDeviceRepository(db).enroll({
    userId: user.id,
    installationId: randomUUID(),
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    name: 'HTTP fixture',
    platform: 'linux',
    architecture: 'x86_64',
    mode: 'client-worker',
    state: 'preparing',
  }))!;
  const modelKey = 'fixture-' + randomUUID();
  const token = randomBytes(32).toString('hex');
  const sessions = new DesktopWorkerRepository(db);
  const session = (await sessions.issue({
    deviceId: device.id,
    authorizationEpoch: device.authorizationEpoch,
    photoSessionId: photo.id!,
    tokenHash: createHash('sha256').update(token).digest(),
    modelKeys: [modelKey],
  }))!;
  const metadata = new SystemMetadataRepository(db);
  const serverId = await stableServerId({ systemMetadataRepository: metadata });
  const broker = new DesktopMlRepository(db);
  const worker = new DesktopWorkerService(new DesktopWorkerAuthService(sessions, metadata), broker, sessions);
  const http = await controllerSetup(DesktopWorkerController, [{ provide: DesktopWorkerService, useValue: worker }]);
  const abort = new AbortController();
  let sequence = 0;
  const call = (method: 'get' | 'post', path: string, operation: string, payload = '') => {
    const proof = { sessionId: session.id, sequence: ++sequence, timestamp: Date.now(), signature: '' };
    proof.signature = sign(
      null,
      Buffer.from(desktopWorkerMessage(serverId, session.authorizationEpoch, token, proof, operation, payload)),
      keys.privateKey,
    ).toString('base64');
    const response = request(http.getHttpServer())
      [method](path)
      .auth(token, { type: 'bearer' })
      .set('x-frameleaf-desktop-proof', Buffer.from(JSON.stringify(proof)).toString('base64'));
    return method === 'post' ? response.send({ payload }) : response;
  };
  const input = Buffer.from('synthetic UTF-8 été');
  const authority = vi.fn().mockResolvedValue(undefined);
  const dispatched = new DesktopMlService(broker).dispatch({
    request: {
      ownerId: user.id,
      modelKey,
      authorityKey: 'fixture-authority',
      config: { clip: { textual: { modelName: 'fixture' } } },
      input,
      inputKind: 'text',
      deadlineAt: new Date(Date.now() + 120_000),
    },
    assertAuthority: authority,
    decodeResult: (value) => z.object({ clip: z.string() }).parse(value),
    signal: abort.signal,
  });
  try {
    const claim = await call(
      'post',
      '/desktop/worker/claim',
      'claim',
      JSON.stringify({ modelKeys: [modelKey], waitMs: 2000 }),
    );
    expect(claim.status).toBe(200);
    expect(claim.body.task).not.toBeNull();
    const id = claim.body.task.id;
    const bytes = await call('get', `/desktop/tasks/${id}/input`, `input:${id}`);
    expect(bytes.status).toBe(200);
    expect(bytes.body).toEqual(input);
    expect(createHash('sha256').update(bytes.body).digest('hex')).toBe(claim.body.task.inputSha256);
    const heartbeat = await call('post', '/desktop/worker/heartbeat', 'heartbeat', JSON.stringify({ id }));
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body).toMatchObject({ accepted: true, expiresAt: expect.any(String) });
    const payload = JSON.stringify({ result: { clip: 'fixture-result' } });
    expect((await call('post', `/desktop/tasks/${id}/result`, `result:${id}`, payload)).body).toEqual({
      accepted: true,
    });
    expect(await dispatched).toEqual({ clip: 'fixture-result' });
    expect(authority).toHaveBeenCalledTimes(2);
    expect((await call('post', `/desktop/tasks/${id}/result`, `result:${id}`, payload)).body).toEqual({
      accepted: true,
    });
    expect(
      (
        await call(
          'post',
          `/desktop/tasks/${id}/result`,
          `result:${id}`,
          JSON.stringify({ result: { clip: 'changed' } }),
        )
      ).body,
    ).toEqual({ accepted: false });
    await db.deleteFrom('session').where('id', '=', photo.id!).execute();
    expect((await call('get', `/desktop/tasks/${id}/input`, `input:${id}`)).status).toBe(401);
  } finally {
    abort.abort();
    await dispatched.catch(() => {});
    await http.close();
  }
});
