import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const Id = z.uuidv4();
const BulkGalleryStatus = z.enum(['queued', 'publishing', 'draft', 'ready', 'mail-queued', 'failed']).meta({
  id: 'PhotographyBulkStatus',
});
const BulkGalleryError = z
  .enum(['photos-unavailable', 'publication-failed', 'setup-failed', 'email-unavailable'])
  .meta({ id: 'PhotographyBulkError' });
const row = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    clientName: z.string().trim().min(1).max(200),
    clientEmail: z.email().max(254),
    folderPath: z.string().min(2).max(2048).startsWith('/').optional(),
    assetIds: z.array(Id).min(1).max(1000).optional(),
  })
  .refine(({ folderPath, assetIds }) => !(folderPath && assetIds), 'Choose one source of photographs')
  .refine(({ assetIds }) => !assetIds || new Set(assetIds).size === assetIds.length, 'Duplicate photographs');
export type PhotographyBulkRow = z.infer<typeof row>;
export class PhotographyBulkCreateDto extends createZodDto(
  z.strictObject({ requestId: Id, templateId: Id, rows: z.array(row).min(1).max(200) }),
) {}
export class PhotographyBulkIdDto extends createZodDto(z.object({ id: Id })) {}
export class PhotographyBulkRowIdDto extends createZodDto(z.object({ id: Id, rowId: Id })) {}
export class PhotographyBulkDto extends createZodDto(
  z.object({
    id: Id,
    rows: z.array(
      z.object({
        id: Id,
        title: z.string(),
        clientName: z.string(),
        clientEmail: z.email(),
        status: BulkGalleryStatus,
        error: BulkGalleryError.nullable(),
        shootId: Id.nullable(),
        link: z.string().nullable(),
        password: z.string().nullable(),
      }),
    ),
  }),
) {}
