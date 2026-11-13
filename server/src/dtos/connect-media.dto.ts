import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { ConnectAlbumSchema } from 'src/dtos/connect.dto.js';

export const CONNECT_RECEIPT_SECONDS = 30 * 86_400;
export const CONNECT_TICKET_SECONDS = 15 * 60;
export const CONNECT_UPLOAD_TYPES = {
  photo: ['image/jpeg', 'image/png', 'video/mp4'],
  design: ['image/jpeg', 'image/png', 'application/pdf', 'video/mp4'],
};
const requestId = z.string().min(1).max(200);
const workspace = z.enum(['photo', 'design']);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const ConnectProvenanceSchema = z
  .object({
    provider: z.literal('canva'),
    externalId: z.string().min(1).max(200),
    title: z.string().max(500),
    exportedAt: z.iso.datetime({ offset: true }),
    entryLabel: z.string().min(1).max(500),
    entryOrdinal: z.int().min(1).max(100),
    pageUrl: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      })
      .optional(),
  })
  .strict();
export type ConnectProvenance = z.infer<typeof ConnectProvenanceSchema>;
export class ConnectUploadStartDto extends createZodDto(
  z
    .object({
      requestId,
      albumId: z.uuid(),
      workspace,
      filename: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[^/\\\x00-\x1f]+$/),
      size: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
      sha256,
      contentType: z.enum(['image/jpeg', 'image/png', 'application/pdf', 'video/mp4']),
      fileCreatedAt: z.iso.datetime({ offset: true }),
      fileModifiedAt: z.iso.datetime({ offset: true }),
      provenance: ConnectProvenanceSchema.optional(),
    })
    .strict()
    .refine((value) => {
      const extension = value.filename.split('.').at(-1)?.toLowerCase();
      const extensions: Record<string, string[]> = {
        'image/jpeg': ['jpg', 'jpeg'],
        'image/png': ['png'],
        'application/pdf': ['pdf'],
        'video/mp4': ['mp4'],
      };
      return (
        CONNECT_UPLOAD_TYPES[value.workspace].includes(value.contentType) &&
        extensions[value.contentType].includes(extension ?? '') &&
        (!value.provenance || value.workspace === 'design')
      );
    })
    .meta({ id: 'ConnectUploadStartDto' }),
) {}
export class ConnectUploadCommitDto extends createZodDto(
  z.object({ requestId, sha256 }).strict().meta({ id: 'ConnectUploadCommitDto' }),
) {}
export class ConnectAlbumCreateDto extends createZodDto(
  z
    .object({ requestId, name: z.string().trim().min(1).max(500), workspace })
    .strict()
    .meta({ id: 'ConnectAlbumCreateDto' }),
) {}
export class ConnectRenditionDto extends createZodDto(
  z
    .object({ variant: z.enum(['thumbnail', 'preview', 'original']) })
    .strict()
    .meta({ id: 'ConnectRenditionDto' }),
) {}
export class ConnectMediaReceiptDto extends createZodDto(
  z
    .object({ assetId: z.uuid(), status: z.enum(['created', 'duplicate']), sha256 })
    .meta({ id: 'ConnectMediaReceiptDto' }),
) {}
export class ConnectUploadStateDto extends createZodDto(
  z
    .object({
      id: z.uuid(),
      offset: z.int().min(0),
      size: z.int().min(1),
      state: z.enum(['receiving', 'finalizing', 'verified', 'published', 'rejected', 'cancelled']),
      expiresAt: z.iso.datetime(),
      receipt: ConnectMediaReceiptDto.schema.optional(),
    })
    .meta({ id: 'ConnectUploadStateDto' }),
) {}
export class ConnectRenditionTicketDto extends createZodDto(
  z.object({ url: z.string(), expiresAt: z.iso.datetime() }).meta({ id: 'ConnectRenditionTicketDto' }),
) {}

export class ConnectAlbumResultDto extends createZodDto(ConnectAlbumSchema) {}
