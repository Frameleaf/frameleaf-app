import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { BuddyBootDeclarationSchema } from 'src/utils/buddy-boot-configuration.js';
import {
  BuddyAcceptRequest,
  BuddyInviteRequest,
  BuddyInviteResponse,
  BuddyPairing,
} from 'src/utils/frameleaf-buddy.js';

export const BuddySettingsSchema = z.strictObject({
  directory: z.string().min(1).max(4096),
  quotaBytes: z
    .number()
    .int()
    .min(10 * 1024 ** 3)
    .max(Number.MAX_SAFE_INTEGER),
  uploadMbps: z.number().meta({ format: 'double' }).min(1).max(10_000).default(20),
  downloadMbps: z.number().meta({ format: 'double' }).min(1).max(10_000).default(20),
  schedule: z.string().min(1).max(128).default('0 2 * * *'),
  timezone: z.string().min(1).max(128),
  windowStart: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('00:00'),
  windowEnd: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('00:00'),
  pausedSending: z.boolean().default(false),
  pausedReceiving: z.boolean().default(false),
  includeDerived: z.boolean().default(false),
  configurationFiles: z.array(z.string().min(1).max(4096)).max(32).default([]),
  bootConfiguration: BuddyBootDeclarationSchema.optional(),
});
const run = z.object({
  id: z.string(),
  state: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  uploadedBytes: z.number().meta({ format: 'double' }),
  totalBytes: z.number().meta({ format: 'double' }),
  objects: z.number().meta({ format: 'double' }),
  uploadedObjects: z.number().meta({ format: 'double' }),
  error: z.string().nullable(),
});
export const BuddyStatusSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  instanceId: z.string(),
  settings: BuddySettingsSchema.nullable(),
  pairing: BuddyPairing.nullable(),
  recoveryVerified: z.boolean(),
  keyFingerprint: z.string().nullable(),
  lastCompleteAt: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  run: run.nullable(),
  connection: z.string().nullable(),
  transferMbps: z.number().meta({ format: 'double' }),
  pendingObjects: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative().nullable(),
  capacityUpdatedAt: z.string().nullable(),
  hosting: z.object({
    committedBytes: z.number().meta({ format: 'double' }),
    reservedBytes: z.number().meta({ format: 'double' }),
    quotaBytes: z.number().meta({ format: 'double' }),
  }),
});
export const BuddyKitSchema = z.strictObject({
  version: z.literal(1).meta({ format: 'double' }),
  vaultId: z.uuid(),
  current: z.number().int().positive(),
  keys: z
    .record(z.string().regex(/^[1-9]\d{0,8}$/), z.string().regex(/^[\w-]{43}$/))
    .refine((keys) => Object.keys(keys).length <= 128),
});
export const BuddyControlSchema = z.strictObject({
  action: z.enum([
    'start',
    'pause-sending',
    'resume-sending',
    'pause-receiving',
    'resume-receiving',
    'restart',
    'verify',
  ]),
});
export const BuddySnapshotListSchema = z.object({
  nextOffset: z.number().meta({ format: 'double' }).nullable(),
  snapshots: z.array(
    z.object({
      id: z.string(),
      createdAt: z.string(),
      sequence: z.number().meta({ format: 'double' }),
      keyVersion: z.number().meta({ format: 'double' }),
    }),
  ),
});
export const BuddyRestoreSchema = z.strictObject({
  snapshotId: z.uuid(),
  scope: z.enum(['asset', 'album', 'library', 'settings', 'server']),
  assetIds: z.array(z.uuid()).min(1).max(100).optional(),
  albumId: z.uuid().optional(),
  mode: z.enum(['keep', 'replace']).default('keep'),
  confirm: z.boolean().default(false),
});
export const BuddyBrowseSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      ownerId: z.string().optional(),
      bytes: z.number().meta({ format: 'double' }),
    }),
  ),
  nextOffset: z.number().meta({ format: 'double' }).nullable(),
  albums: z.array(z.object({ id: z.string(), name: z.string(), items: z.number().meta({ format: 'double' }) })),
});
export const BuddyRestoreResponseSchema = z.object({
  operationId: z.string().nullable(),
  items: z.number().meta({ format: 'double' }),
  metadataItems: z.number().int().nonnegative().optional(),
  bytes: z.number().meta({ format: 'double' }),
  conflicts: z.number().meta({ format: 'double' }),
  mode: z.enum(['keep', 'replace']),
  state: z.string(),
});
export const BuddyRestoreStatusSchema = z.object({
  id: z.uuid(),
  state: z.string(),
  progress: z.number().meta({ format: 'double' }).nullable(),
  phase: z.string(),
  recoveryId: z.string().nullable(),
  error: z.string().nullable(),
});
export class BuddySettingsDto extends createZodDto(BuddySettingsSchema) {}
export class BuddyPreflightRequestDto extends createZodDto(
  z.strictObject({
    directory: z.string().max(4096).default(''),
    configurationFiles: z.array(z.string().min(1).max(4096)).max(32).default([]),
  }),
) {}
export class BuddyPreflightDto extends createZodDto(
  z.object({
    timezone: z.string(),
    items: z.number().int().nonnegative(),
    originalBytes: z.number().int().nonnegative(),
    unknownSizes: z.number().int().nonnegative(),
    databaseBytes: z.number().int().nonnegative(),
    stagingAvailableBytes: z.number().meta({ format: 'double' }),
    hostingAvailableBytes: z.number().meta({ format: 'double' }).nullable(),
    mounts: z.array(z.object({ path: z.string(), available: z.boolean() })),
    configurationFiles: z.array(z.object({ path: z.string(), available: z.boolean() })),
  }),
) {}
export class BuddyStatusDto extends createZodDto(BuddyStatusSchema) {}
export class BuddyKitDto extends createZodDto(BuddyKitSchema) {}
export class BuddyControlDto extends createZodDto(BuddyControlSchema) {}
export class BuddyInviteDto extends createZodDto(BuddyInviteRequest) {}
export class BuddyInviteResponseDto extends createZodDto(BuddyInviteResponse) {}
export class BuddyAcceptDto extends createZodDto(BuddyAcceptRequest) {}
export class BuddyPairingDto extends createZodDto(BuddyPairing) {}
export class BuddySnapshotListDto extends createZodDto(BuddySnapshotListSchema) {}
export class BuddyRestoreDto extends createZodDto(BuddyRestoreSchema) {}
export class BuddyBrowseDto extends createZodDto(BuddyBrowseSchema) {}
export class BuddyRestoreResponseDto extends createZodDto(BuddyRestoreResponseSchema) {}
export class BuddyRestoreStatusDto extends createZodDto(BuddyRestoreStatusSchema) {}
export class BuddyRestoreCheckpointDto extends createZodDto(
  z.object({ operation: BuddyRestoreStatusSchema.nullable() }),
) {}
export class BuddyPageDto extends createZodDto(
  z.object({ offset: z.coerce.number().int().min(0).max(1_000_000).default(0) }),
) {}
export class BuddyRelationshipDto extends createZodDto(
  z.strictObject({ action: z.enum(['confirm', 'end', 'block']) }),
) {}
export class BuddyApplyDto extends createZodDto(z.strictObject({ operationId: z.uuid(), confirm: z.literal(true) })) {}
export class BuddyApplyResponseDto extends createZodDto(z.object({ jwt: z.string() })) {}
export class BuddyProbeResponseDto extends createZodDto(z.object({ ok: z.boolean() })) {}

export const BuddyEscrowSchema = z.strictObject({
  version: z.literal(1).meta({ format: 'double' }),
  vaultId: z.uuid(),
  blob: z
    .string()
    .min(64)
    .max(32_768)
    .regex(/^[A-Za-z0-9_-]+$/),
});
const passphrase = z.string().min(12).max(1024);
export class BuddyEscrowDto extends createZodDto(BuddyEscrowSchema) {}
export class BuddyEscrowWrapDto extends createZodDto(z.strictObject({ passphrase })) {}
export class BuddyEscrowImportDto extends createZodDto(z.strictObject({ escrow: BuddyEscrowSchema, passphrase })) {}
