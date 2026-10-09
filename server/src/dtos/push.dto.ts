import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { PushEventTypeSchema, PushPlatformSchema, PushUnavailableReasonSchema } from 'src/enum.js';
import { LIVE_ACTIVITY_KINDS } from 'src/utils/frameleaf-push.js';

const DateTime = z.string().meta({ format: 'date-time' });

const PushTokenSchema = z.string().trim().min(1).max(4096);

const ApnsEnvironmentSchema = z
  .enum(['production', 'sandbox'])
  .describe(
    'iOS only: the APNs environment of the tokens. A development build gets sandbox tokens, which only APNs sandbox delivers. Default production.',
  )
  .meta({ id: 'PushApnsEnvironment' });

const PushPublicKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe(
    "The device's X25519 public key: its raw 32 bytes, base64url (CryptoKit `rawRepresentation`). Every payload is encrypted to it (frameleaf-push-v1; see docs/developer/push-envelope-v1).",
  );

const PushPreferencesSchema = z
  .object({
    backupNeedsAttention: z.boolean().optional(),
    backupStale: z.boolean().optional(),
    cloudBackupActivation: z.boolean().optional(),
    sharedActivity: z.boolean().optional(),
    memories: z.boolean().optional(),
    renderFinished: z.boolean().optional(),
    renderProgress: z.boolean().optional(),
    accessChanged: z.boolean().optional(),
  })
  .describe('Which events this device is told about; an omitted event keeps its current setting (on by default)')
  .meta({ id: 'PushPreferencesDto' });
export class PushPreferencesDto extends createZodDto(PushPreferencesSchema) {}

const PushPreferencesResponseSchema = z
  .object({
    backupNeedsAttention: z.boolean(),
    backupStale: z.boolean(),
    cloudBackupActivation: z.boolean(),
    sharedActivity: z.boolean(),
    memories: z.boolean(),
    renderFinished: z.boolean(),
    renderProgress: z.boolean(),
    accessChanged: z.boolean(),
  })
  .meta({ id: 'PushPreferencesResponseDto' });

export const PushDeviceRegisterSchema = z
  .object({
    platform: PushPlatformSchema,
    pushToken: PushTokenSchema.describe('The APNs device token or FCM registration token'),
    pushToStartToken: PushTokenSchema.nullish().describe('iOS only: the ActivityKit push-to-start token'),
    apnsEnvironment: ApnsEnvironmentSchema.optional(),
    publicKey: PushPublicKeySchema,
    backupDeviceKey: z
      .uuid()
      .nullish()
      .describe(
        "This device's phone backup identity (the backup device registry's deviceKey), for stale-backup wake-ups",
      ),
    preferences: PushPreferencesSchema.optional(),
  })
  .meta({ id: 'PushDeviceRegisterDto' });
export class PushDeviceRegisterDto extends createZodDto(PushDeviceRegisterSchema) {}

export const PushDeviceUpdateSchema = z
  .object({
    pushToken: PushTokenSchema.optional().describe('A rotated APNs or FCM token'),
    pushToStartToken: PushTokenSchema.nullish().describe(
      'iOS only: a rotated ActivityKit push-to-start token, or null',
    ),
    apnsEnvironment: ApnsEnvironmentSchema.optional(),
    publicKey: PushPublicKeySchema.optional(),
    backupDeviceKey: z.uuid().nullish(),
    preferences: PushPreferencesSchema.optional(),
  })
  .meta({ id: 'PushDeviceUpdateDto' });
export class PushDeviceUpdateDto extends createZodDto(PushDeviceUpdateSchema) {}

export const PushActivityParamSchema = z.object({
  activityId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\w.-]+$/)
    .describe('The Live Activity id on the device (ActivityKit `Activity.id`)'),
});
export class PushActivityParamDto extends createZodDto(PushActivityParamSchema) {}

export const PushActivityTokenSchema = z
  .object({
    kind: z
      .enum(LIVE_ACTIVITY_KINDS)
      .describe(
        'The Live Activity type: `cloud-backup-activation` (ActivationAttributes) or `studio-render` (RenderAttributes)',
      ),
    token: PushTokenSchema.describe('The ActivityKit push token of this activity'),
  })
  .meta({ id: 'PushActivityTokenDto' });
export class PushActivityTokenDto extends createZodDto(PushActivityTokenSchema) {}

const PushDeviceActivitySchema = z
  .object({
    activityId: z.string(),
    kind: z.string(),
    updatedAt: DateTime,
  })
  .meta({ id: 'PushDeviceActivityDto' });

const PushDeviceResponseSchema = z
  .object({
    id: z.uuid(),
    platform: PushPlatformSchema,
    current: z.boolean().describe('Whether this is the device of the session asking'),
    publicKeyFingerprint: z.string().describe('A short fingerprint of the registered public key; never the token'),
    hasPushToStartToken: z.boolean(),
    apnsEnvironment: ApnsEnvironmentSchema.nullable().describe('iOS: the APNs environment; null for Android'),
    backupDeviceKey: z.uuid().nullable(),
    preferences: PushPreferencesResponseSchema,
    activities: z.array(PushDeviceActivitySchema),
    createdAt: DateTime,
    updatedAt: DateTime,
    lastDeliveredAt: DateTime.nullable(),
  })
  .describe('A registered push device. Push tokens are never returned.')
  .meta({ id: 'PushDeviceResponseDto' });
export class PushDeviceResponseDto extends createZodDto(PushDeviceResponseSchema) {}

export class PushDeviceListResponseDto extends createZodDto(
  z.object({ devices: z.array(PushDeviceResponseSchema) }).meta({ id: 'PushDeviceListResponseDto' }),
) {}

const PushStatusResponseSchema = z
  .object({
    available: z.boolean().describe('Whether this server delivers push notifications now (it must be linked)'),
    reason: PushUnavailableReasonSchema.nullable().describe('Why push is unavailable; null when available'),
    encryption: z
      .object({
        scheme: z.literal('frameleaf-push-v1'),
        keyAgreement: z.literal('X25519'),
        kdf: z.literal('HKDF-SHA256'),
        cipher: z.literal('AES-256-GCM'),
      })
      .describe('How payloads are encrypted to the device key'),
    events: z.array(PushEventTypeSchema).describe('The events this server can deliver'),
    registered: z.boolean().describe('Whether the session asking has registered its device'),
  })
  .meta({ id: 'PushStatusResponseDto' });
export class PushStatusResponseDto extends createZodDto(PushStatusResponseSchema) {}
