import { UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ICloudIdentityController } from 'src/controllers/icloud-identity.controller.js';
import { ICloudAuditService } from 'src/services/icloud-audit.service.js';
import { ICloudIdentityService } from 'src/services/icloud-identity.service.js';
import { ControllerContext, controllerSetup } from 'test/utils.js';

describe('iCloud on-demand verification API', () => {
  let context: ControllerContext;
  const ownerId = randomUUID();
  const audits = { submit: vi.fn() };
  const body = {
    connectionId: randomUUID(),
    requestKey: randomUUID(),
    items: [
      {
        id: 'original',
        assetId: randomUUID(),
        cloudIdentifier: `${randomUUID()}:001:AQohY6yKZR0+tXlMi9FUQ82zySGo`,
        role: 'original',
      },
    ],
  };
  beforeAll(async () => {
    context = await controllerSetup(ICloudIdentityController, [
      { provide: ICloudIdentityService, useValue: {} },
      { provide: ICloudAuditService, useValue: audits },
    ]);
  });
  afterAll(async () => {
    await context.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    context.reset();
    context.authenticate.mockResolvedValue({
      user: { id: ownerId },
      session: { id: randomUUID(), hasElevatedPermission: false },
    });
  });
  it('requires authentication and accepts a durable queued receipt with HTTP202, never a verified response', async () => {
    context.authenticate.mockRejectedValueOnce(new UnauthorizedException());
    await request(context.getHttpServer()).post('/icloud-sync/identities/verify').send(body).expect(401);
    const response = { operationId: randomUUID(), items: [{ id: 'original', state: 'queued' }] };
    audits.submit.mockResolvedValue(response);
    const accepted = await request(context.getHttpServer())
      .post('/icloud-sync/identities/verify')
      .send(body)
      .expect(202);
    expect(accepted.body).toEqual(response);
    expect(audits.submit).toHaveBeenCalledWith(
      expect.objectContaining({ user: { id: ownerId } }),
      expect.objectContaining({ items: [expect.objectContaining({ editVersion: '' })] }),
    );
  });
  it('rejects malformed, duplicate and inconsistent edit requests before creating work', async () => {
    await request(context.getHttpServer())
      .post('/icloud-sync/identities/verify')
      .send({ ...body, requestKey: 'bad' })
      .expect(400);
    await request(context.getHttpServer())
      .post('/icloud-sync/identities/verify')
      .send({ ...body, items: [body.items[0], body.items[0]] })
      .expect(400);
    await request(context.getHttpServer())
      .post('/icloud-sync/identities/verify')
      .send({ ...body, items: [{ ...body.items[0], role: 'edit-render', editVersion: '' }] })
      .expect(400);
    expect(audits.submit).not.toHaveBeenCalled();
  });
});
