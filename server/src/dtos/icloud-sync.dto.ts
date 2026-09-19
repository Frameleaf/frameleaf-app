import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const ICloudConfigSchema = z
  .object({
    libraries: z.array(z.string().min(1).max(1024)).max(100).default([]),
    albums: z.array(z.string().min(1).max(1024)).max(10_000).default([]),
    includeEdits: z.boolean().default(true),
    includeHidden: z.boolean().default(false),
    recoverExternalAsManaged: z.boolean().default(false),
    intervalHours: z.number().int().min(1).max(8760).default(24),
    concurrency: z.number().int().min(1).max(4).default(1),
    stagingBytes: z
      .number()
      .int()
      .min(1024 ** 2)
      .max(Number.MAX_SAFE_INTEGER)
      .default(20 * 1024 ** 3),
  })
  .strict();
export type ICloudConfig = z.infer<typeof ICloudConfigSchema>;

const ConfigFieldsSchema = z
  .object({
    libraries: ICloudConfigSchema.shape.libraries.unwrap(),
    albums: ICloudConfigSchema.shape.albums.unwrap(),
    includeEdits: ICloudConfigSchema.shape.includeEdits.unwrap(),
    includeHidden: ICloudConfigSchema.shape.includeHidden.unwrap(),
    recoverExternalAsManaged: ICloudConfigSchema.shape.recoverExternalAsManaged.unwrap(),
    intervalHours: ICloudConfigSchema.shape.intervalHours.unwrap(),
    concurrency: ICloudConfigSchema.shape.concurrency.unwrap(),
    stagingBytes: ICloudConfigSchema.shape.stagingBytes.unwrap(),
  })
  .strict();

export class ICloudConnectionCreateDto extends createZodDto(
  z
    .object({
      label: z.string().trim().min(1).max(100),
      config: ICloudConfigSchema.default(ICloudConfigSchema.parse({})),
    })
    .strict()
    .meta({ id: 'ICloudConnectionCreateDto' }),
) {}

export class ICloudConnectionUpdateDto extends createZodDto(
  z
    .object({
      label: z.string().trim().min(1).max(100).optional(),
      config: ConfigFieldsSchema.partial().optional(),
    })
    .strict()
    .meta({ id: 'ICloudConnectionUpdateDto' }),
) {}

export class ICloudAuthDto extends createZodDto(
  z
    .object({
      action: z.enum(['login', 'two-factor', 'device-approval', 'validate']).meta({ id: 'ICloudAuthAction' }),
      appleId: z.email().max(320).optional(),
      password: z.string().min(1).max(1024).optional(),
      code: z
        .string()
        .regex(/^\d{6}$/)
        .optional(),
    })
    .strict()
    .refine((value) => value.action !== 'login' || !!(value.appleId && value.password), {
      message: 'Apple ID and password required for login',
    })
    .refine((value) => value.action !== 'two-factor' || !!value.code, { message: 'Verification code required' })
    .meta({ id: 'ICloudAuthDto' }),
) {}

export class ICloudControlDto extends createZodDto(
  z
    .object({
      action: z.enum(['run', 'pause', 'resume', 'cancel', 'rescan', 'retry']).meta({ id: 'ICloudControlAction' }),
    })
    .strict()
    .meta({ id: 'ICloudControlDto' }),
) {}

const ConnectionSchema = z
  .object({
    id: z.uuid(),
    label: z.string(),
    state: z.string(),
    config: ConfigFieldsSchema,
    lastError: z.string().nullable(),
    nextRunAt: z.string().nullable(),
    counts: z.record(z.string(), z.number()),
  })
  .meta({ id: 'ICloudConnectionResponseDto' });
export class ICloudConnectionResponseDto extends createZodDto(ConnectionSchema) {}
export class ICloudConnectionsResponseDto extends createZodDto(
  z
    .object({
      enabled: z.boolean(),
      connections: z.array(ConnectionSchema),
    })
    .meta({ id: 'ICloudConnectionsResponseDto' }),
) {}
export class ICloudInventoryResponseDto extends createZodDto(
  z
    .object({
      libraries: z.array(z.object({ id: z.string(), name: z.string(), supported: z.boolean() })),
      albums: z.array(
        z.object({ id: z.string(), libraryId: z.string(), name: z.string(), parentId: z.string().nullable() }),
      ),
      complete: z.boolean(),
      recent: z.array(z.object({ assetId: z.uuid(), resourceId: z.uuid(), outcome: z.string() })).optional(),
    })
    .meta({ id: 'ICloudInventoryResponseDto' }),
) {}
