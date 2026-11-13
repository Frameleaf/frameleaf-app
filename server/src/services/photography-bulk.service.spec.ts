import { randomUUID } from 'node:crypto';
import { PhotographyBulkCreateDto } from 'src/dtos/photography-bulk.dto.js';
import { bulkInvitation } from 'src/utils/photography-bulk.js';

const row = { title: 'Portrait', clientName: 'Morgan', clientEmail: 'morgan@example.test' };
const input = { requestId: randomUUID(), templateId: randomUUID(), rows: [row] };

it('bounds a bulk request and refuses mixed or relative photo sources', () => {
  expect(PhotographyBulkCreateDto.schema.parse(input)).toEqual(input);
  expect(() => PhotographyBulkCreateDto.schema.parse({ ...input, rows: Array(201).fill(row) })).toThrow();
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
  const hmac = vi.fn(async (purpose: string, id: string) =>
    purpose === 'token' ? Buffer.alloc(32, 4).toString('base64url') : 'distinct-password-' + id,
  );
  const id = randomUUID();
  const invitation = await bulkInvitation(id, hmac);
  expect(invitation).toEqual(await bulkInvitation(id, hmac));
  expect(invitation.token).toMatch(/^[a-f0-9]{64}$/);
  expect(invitation.password.length).toBeGreaterThanOrEqual(8);
  expect(hmac).toHaveBeenCalledWith('password', id);
  expect(hmac).toHaveBeenCalledWith('token', id);
});
