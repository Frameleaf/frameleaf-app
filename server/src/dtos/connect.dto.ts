import { AssetType } from 'src/enum.js';
import { ConnectAccessPolicySchema } from 'src/utils/connect-policy.js';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export class ConnectSearchDto extends createZodDto(
  z
    .object({
      q: z.string().max(200).optional(),
      albumId: z.uuid().optional(),
      page: z.coerce.number().int().min(1).max(100000).default(1),
      size: z.coerce.number().int().min(1).max(100).default(50),
      type: z.enum([AssetType.Image, AssetType.Video]).optional(),
    })
    .strict()
    .meta({ id: 'ConnectSearchDto' }),
) {}

export class ConnectAddAssetsDto extends createZodDto(
  z
    .object({ assetIds: z.array(z.uuid()).min(1).max(100) })
    .strict()
    .meta({ id: 'ConnectAddAssetsDto' }),
) {}
export class ConnectAddTagsDto extends createZodDto(
  z
    .object({
      tags: z
        .array(
          z
            .string()
            .trim()
            .min(1)
            .max(100)
            .regex(/^[^/]+$/),
        )
        .min(1)
        .max(20),
    })
    .strict()
    .meta({ id: 'ConnectAddTagsDto' }),
) {}

export const ConnectAlbumSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    workspace: z.enum(['photo', 'design', 'both']),
    canRead: z.boolean(),
    canWrite: z.boolean(),
  })
  .meta({ id: 'ConnectAlbum' });
export const ConnectAssetSchema = z
  .object({
    id: z.uuid(),
    type: z.enum([AssetType.Image, AssetType.Video]),
    title: z.string().nullable(),
    description: z.string().nullable(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    duration: z.number().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ConnectAsset' });
export class ConnectAssetDto extends createZodDto(ConnectAssetSchema) {}
export class ConnectAlbumsDto extends createZodDto(
  z.object({ items: z.array(ConnectAlbumSchema) }).meta({ id: 'ConnectAlbumsDto' }),
) {}
export class ConnectAssetsDto extends createZodDto(
  z
    .object({ items: z.array(ConnectAssetSchema), total: z.int().nonnegative(), page: z.int(), size: z.int() })
    .meta({ id: 'ConnectAssetsDto' }),
) {}
export class ConnectTagResultDto extends createZodDto(
  z.object({ tagIds: z.array(z.uuid()) }).meta({ id: 'ConnectTagResultDto' }),
) {}

export class ConnectCapabilitiesDto extends createZodDto(
  z
    .object({
      protocolVersion: z.literal(1),
      server: z.object({ id: z.string(), name: z.string() }),
      displayIdentity: z.object({ name: z.string() }),
      scopes: z.array(z.string()),
      accessPolicy: ConnectAccessPolicySchema,
      policyRevision: z.int(),
      albums: z.array(ConnectAlbumSchema),
      limits: z.object({
        maxPageSize: z.literal(100),
        maxUploadBytes: z.number(),
        maxAppendBytes: z.number(),
        uploadExpiresAfterSeconds: z.number(),
        receiptWindowSeconds: z.number(),
        renditionTicketSeconds: z.number(),
        originalsAllowed: z.boolean(),
      }),
      supportedTypes: z.object({
        read: z.array(z.string()),
        upload: z.object({ photo: z.array(z.string()), design: z.array(z.string()) }),
      }),
    })
    .meta({ id: 'ConnectCapabilitiesDto' }),
) {}
