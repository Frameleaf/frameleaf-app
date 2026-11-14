import { randomUUID } from 'node:crypto';
import { PhotographyBulkCreateDto } from 'src/dtos/photography-bulk.dto.js';
import { PhotographyBulkService } from 'src/services/photography-bulk.service.js';
import { bulkInvitation } from 'src/utils/photography-bulk.js';

const row = { title: 'Portrait', clientName: 'Morgan', clientEmail: 'morgan@example.test' };
const input = { requestId: randomUUID(), templateId: randomUUID(), rows: [row] };

it('bounds database reads while displaying 100 completed gallery invitations', async () => {
  const batch = {
    id: input.requestId,
    rows: Array.from({ length: 100 }, () => ({ ...row, id: randomUUID(), status: 'mail-queued', error: null })),
  };
  let active = 0,
    peak = 0;
  const repository = {
    studioRecord: vi.fn().mockResolvedValue({ record: { bulkGalleries: [batch] } }),
    get: vi.fn(async () => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return;
    }),
  };
  const service = new PhotographyBulkService(
    repository as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const result = await service.get({ user: { id: randomUUID() }, session: {} } as never, batch.id);
  expect(result.rows).toHaveLength(100);
  expect(peak).toBeLessThanOrEqual(4);
});

it('does not queue another gallery invitation when a sent bulk row is retried', async () => {
  const batch = { id: input.requestId, rows: [{ ...row, id: randomUUID(), status: 'mail-queued', error: null }] };
  const repository = {
    mutateStudio: vi.fn(async (_owner: string, _revision: unknown, change: any) => ({
      result: await change({ bulkGalleries: [batch] }, {}),
    })),
    get: vi.fn().mockResolvedValue(undefined),
  };
  const jobs = { queueInTransaction: vi.fn() };
  const service = new PhotographyBulkService(
    repository as never,
    {} as never,
    {} as never,
    jobs as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const result = await service.retry({ user: { id: randomUUID() }, session: {} } as never, batch.id, batch.rows[0].id);
  expect(result.rows[0].status).toBe('mail-queued');
  expect(jobs.queueInTransaction).not.toHaveBeenCalled();
});

it('bounds a bulk request and refuses mixed or relative photo sources', () => {
  expect(PhotographyBulkCreateDto.schema.parse(input)).toEqual(input);
  expect(() =>
    PhotographyBulkCreateDto.schema.parse({ ...input, rows: Array.from({ length: 201 }, () => ({ ...row })) }),
  ).toThrow();
  expect(() =>
    PhotographyBulkCreateDto.schema.parse({
      ...input,
      rows: [{ ...row, folderPath: '/photos', assetIds: [randomUUID()] }],
    }),
  ).toThrow();
  expect(() =>
    PhotographyBulkCreateDto.schema.parse({
      ...input,
      rows: [{ ...row, folderPath: 'photos' }],
    }),
  ).toThrow();
});

it('derives stable, separately scoped credentials without writing clear credentials into the batch', async () => {
  const hmac = vi.fn((purpose: string, id: string) =>
    Promise.resolve(purpose === 'token' ? Buffer.alloc(32, 4).toString('base64url') : 'distinct-password-' + id),
  );
  const id = randomUUID();
  const invitation = await bulkInvitation(id, hmac);
  expect(invitation).toEqual(await bulkInvitation(id, hmac));
  expect(invitation.token).toMatch(/^[a-f0-9]{64}$/);
  expect(invitation.password.length).toBeGreaterThanOrEqual(8);
  expect(hmac).toHaveBeenCalledWith('password', id);
  expect(hmac).toHaveBeenCalledWith('token', id);
});
