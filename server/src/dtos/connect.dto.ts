import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetType } from 'src/enum.js';
import { ConnectAccessPolicySchema } from 'src/utils/connect-policy.js';

const assetType = z.enum([AssetType.Image, AssetType.Video]).meta({ id: 'ConnectAssetType' });
export const ConnectAlbumWorkspaceSchema = z.enum(['photo', 'design', 'both']).meta({ id: 'ConnectAlbumWorkspace' });

export class ConnectSearchDto extends createZodDto(
  z
    .object({
      q: z.string().max(200).optional(),
      albumId: z.uuid().optional(),
      page: z.coerce.number().int().min(1).max(100_000).default(1),
      size: z.coerce.number().int().min(1).max(100).default(50),
      type: assetType.optional(),
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
    workspace: ConnectAlbumWorkspaceSchema,
    canRead: z.boolean(),
    canWrite: z.boolean(),
  })
  .meta({ id: 'ConnectAlbum' });
export const ConnectAssetSchema = z
  .object({
    id: z.uuid(),
    type: assetType,
    title: z.string().nullable(),
    description: z.string().nullable(),
    width: z.number().meta({ format: 'double' }).nullable(),
    height: z.number().meta({ format: 'double' }).nullable(),
    duration: z.number().meta({ format: 'double' }).nullable(),
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
      protocolVersion: z.literal(1).meta({ type: 'integer', format: 'int32' }),
      server: z.object({ id: z.string(), name: z.string() }),
      displayIdentity: z.object({ name: z.string() }),
      connection: z.object({ grantId: z.uuid(), libraryUserId: z.uuid() }),
      scopes: z.array(z.string()),
      accessPolicy: ConnectAccessPolicySchema,
      policyRevision: z.int(),
      albums: z.array(ConnectAlbumSchema),
      limits: z.object({
        maxPageSize: z.literal(100).meta({ type: 'integer', format: 'int32' }),
        maxUploadBytes: z.number().meta({ format: 'double' }),
        maxAppendBytes: z.number().meta({ format: 'double' }),
        uploadExpiresAfterSeconds: z.number().meta({ format: 'double' }),
        receiptWindowSeconds: z.number().meta({ format: 'double' }),
        renditionTicketSeconds: z.number().meta({ format: 'double' }),
        originalsAllowed: z.boolean(),
      }),
      supportedTypes: z.object({
        read: z.array(z.string()),
        upload: z.object({ photo: z.array(z.string()), design: z.array(z.string()) }),
      }),
    })
    .meta({ id: 'ConnectCapabilitiesDto' }),
) {}
