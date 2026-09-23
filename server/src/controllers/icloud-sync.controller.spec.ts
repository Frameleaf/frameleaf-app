import { UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ICloudSyncController } from 'src/controllers/icloud-sync.controller.js';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { ICloudSyncService } from 'src/services/icloud-sync.service.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

describe('iCloud API authorization and input boundaries', () => {
  let context: ControllerContext;
  const ownerId = randomUUID(),
    id = randomUUID();
  const repository = {
    get: vi.fn(),
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    counts: vi.fn(),
    latestOperation: vi.fn(),
    remove: vi.fn(),
  };
  const logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const transport = { enabled: () => true, authenticate: vi.fn() };
  const staging = { root: vi.fn() };
  beforeAll(async () => {
    const service = new ICloudSyncService(
      repository as never,
      transport as never,
      staging as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      logger as never,
    );
    context = await controllerSetup(ICloudSyncController, [{ provide: ICloudSyncService, useValue: service }]);
  });
  afterAll(async () => {
    await context.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    context.reset();
    context.authenticate.mockResolvedValue({ user: { id: ownerId }, session: { hasElevatedPermission: false } });
    repository.list.mockResolvedValue([]);
    repository.latestOperation.mockResolvedValue(undefined);
    repository.get.mockImplementation((_id, owner) =>
      Promise.resolve(owner === ownerId ? { id, ownerId, config: ICloudConfigSchema.parse({}) } : undefined),
    );
  });
  it('requires authentication and rejects malformed IDs and unknown configuration keys', async () => {
    context.authenticate.mockRejectedValueOnce(new UnauthorizedException());
    await request(context.getHttpServer()).get('/icloud-sync/connections').expect(401);
    await request(context.getHttpServer())
      .patch('/icloud-sync/connections/not-a-uuid')
      .send({ label: 'Photos' })
      .expect(400);
    await request(context.getHttpServer())
      .post('/icloud-sync/connections')
      .send({ label: 'Photos', config: { shellCommand: 'touch /tmp/pwn' } })
      .expect(400);
    expect(repository.create).not.toHaveBeenCalled();
  });
  it('requires server-side elevation to grant background hidden-media access', async () => {
    await request(context.getHttpServer())
      .post('/icloud-sync/connections')
      .send({ label: 'Photos', config: { includeHidden: true } })
      .expect(401);
    await request(context.getHttpServer())
      .patch(`/icloud-sync/connections/${id}`)
      .send({ config: { includeHidden: true } })
      .expect(401);
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
  });
  it('rejects malformed challenges and plaintext HTTP before sending credentials to Apple', async () => {
    await request(context.getHttpServer())
      .post(`/icloud-sync/connections/${id}/auth`)
      .send({ action: 'two-factor', code: '123' })
      .expect(400);
    await request(context.getHttpServer())
      .post(`/icloud-sync/connections/${id}/auth`)
      .send({ action: 'login', appleId: 'owner@example.test', password: 'private-password' })
      .expect(400);
    expect(transport.authenticate).not.toHaveBeenCalled();
  });
  it('removes only through the owner-scoped path and never with a malformed ID', async () => {
    await request(context.getHttpServer()).post('/icloud-sync/connections/not-a-uuid/remove').expect(400);
    expect(repository.remove).not.toHaveBeenCalled();
    repository.remove.mockResolvedValue('still-connected');
    await request(context.getHttpServer()).post(`/icloud-sync/connections/${id}/remove`).expect(400);
    expect(repository.remove).toHaveBeenCalledWith(id, ownerId, expect.any(Function));
    repository.remove.mockResolvedValue('removed');
    await request(context.getHttpServer()).post(`/icloud-sync/connections/${id}/remove`).expect(204);
    context.authenticate.mockResolvedValue({ user: { id: randomUUID() }, session: {} });
    repository.remove.mockClear();
    await request(context.getHttpServer()).post(`/icloud-sync/connections/${id}/remove`).expect(404);
    expect(repository.remove).not.toHaveBeenCalled();
  });
});
