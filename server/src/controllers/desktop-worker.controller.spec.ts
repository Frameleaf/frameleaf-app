import { generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import { DesktopWorkerController } from 'src/controllers/desktop-worker.controller.js';
import { desktopWorkerMessage } from 'src/dtos/desktop-worker.dto.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { DesktopWorkerService } from 'src/services/desktop-worker.service.js';
import { type ControllerContext, controllerSetup } from 'test/utils.js';

const keys = generateKeyPairSync('ed25519');
const token = 'a'.repeat(64);
const id = '445bc2b6-f4cd-439e-b8bb-7e84d7ee0550';
const sessionId = '1117c1ca-0495-46e9-b579-f321520c2b1a';
const grant = { deviceId: id, sessionId, authorizationEpoch: 2 };
const repository = { session: vi.fn(), consume: vi.fn() };
const broker = { claim: vi.fn(), input: vi.fn(), complete: vi.fn(), heartbeat: vi.fn(), fail: vi.fn() };
let ctx: ControllerContext;
const proof = (operation: string, payload: string) => {
  const dto = { sessionId, sequence: 1, timestamp: Date.now(), signature: '' };
  dto.signature = sign(
    null,
    Buffer.from(desktopWorkerMessage('server', 2, token, dto, operation, payload)),
    keys.privateKey,
  ).toString('base64');
  return Buffer.from(JSON.stringify(dto)).toString('base64');
};
beforeAll(async () => {
  const auth = new DesktopWorkerAuthService(
    repository as never,
    { get: vi.fn().mockResolvedValue({ id: 'server' }) } as never,
  );
  ctx = await controllerSetup(DesktopWorkerController, [
    { provide: DesktopWorkerService, useValue: new DesktopWorkerService(auth, broker as never, {} as never) },
  ]);
});
afterAll(async () => ctx.close());
beforeEach(() => {
  vi.clearAllMocks();
  repository.session.mockResolvedValue({
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    authorizationEpoch: 2,
  });
  repository.consume.mockResolvedValue(grant);
  broker.claim.mockResolvedValue(undefined);
});
it('requires worker token and signed proof; photo cookies/tokens alone cannot claim', async () => {
  for (const authorization of ['', 'Bearer photo-token', 'Bearer ' + token]) {
    expect(
      (
        await request(ctx.getHttpServer())
          .post('/desktop/worker/claim')
          .set('Authorization', authorization)
          .set('Cookie', 'immich_access_token=photo-token')
          .send({ payload: '{"modelKeys":[],"waitMs":0}' })
      ).status,
    ).toBe(401);
  }
  expect(broker.claim).not.toHaveBeenCalled();
  expect(ctx.authenticate).not.toHaveBeenCalled();
});
it('accepts exact signed payload bytes and rejects route/payload substitution', async () => {
  const payload = '{"modelKeys":["m"],"waitMs":0}';
  const response = await request(ctx.getHttpServer())
    .post('/desktop/worker/claim')
    .auth(token, { type: 'bearer' })
    .set('x-frameleaf-desktop-proof', proof('claim', payload))
    .send({ payload });
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ task: null });
  expect(
    (
      await request(ctx.getHttpServer())
        .post('/desktop/worker/claim')
        .auth(token, { type: 'bearer' })
        .set('x-frameleaf-desktop-proof', proof('claim', payload))
        .send({ payload: '{"modelKeys":[],"waitMs":0}' })
    ).status,
  ).toBe(401);
  expect(
    (
      await request(ctx.getHttpServer())
        .post('/desktop/worker/claim')
        .auth(token, { type: 'bearer' })
        .set('x-frameleaf-desktop-proof', proof('claim', payload))
        .send({ payload, extra: true })
    ).status,
  ).toBe(400);
});
it('returns scoped binary input without JSON conversion and binds the attempt path', async () => {
  const input = Buffer.from([0, 1, 255, 10]);
  broker.input.mockResolvedValue(input);
  const response = await request(ctx.getHttpServer())
    .get(`/desktop/tasks/${id}/input`)
    .auth(token, { type: 'bearer' })
    .set('x-frameleaf-desktop-proof', proof(`input:${id}`, ''));
  expect(response.status).toBe(200);
  expect(response.body).toEqual(input);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(
    (
      await request(ctx.getHttpServer())
        .get(`/desktop/tasks/${sessionId}/input`)
        .auth(token, { type: 'bearer' })
        .set('x-frameleaf-desktop-proof', proof(`input:${id}`, ''))
    ).status,
  ).toBe(401);
  expect((await request(ctx.getHttpServer()).get('/desktop/tasks/not-uuid/input')).status).toBe(400);
});
