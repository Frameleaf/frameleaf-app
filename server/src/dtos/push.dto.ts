import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { ExtraModel } from 'src/decorators.js';
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

// FL-926: UnifiedPush (ntfy and other distributors), so a phone without Google services still gets push
const UnifiedPushEndpointSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .describe(
    "Android only: the device's UnifiedPush endpoint (the distributor's push address, such as an ntfy topic URL). When set, pushes go there instead of through the Frameleaf Cloud gateway, and the server need not be linked. Needs unifiedPushPublicKey and unifiedPushAuth.",
  );
const UnifiedPushPublicKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .describe('The Web Push P-256 public key (`p256dh`): the 65-byte uncompressed point, base64url (RFC 8291)');
const UnifiedPushAuthSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe('The Web Push authentication secret (`auth`): 16 bytes, base64url (RFC 8291)');

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
    pushToken: PushTokenSchema.optional().describe(
      'The APNs device token or FCM registration token. Optional only for an Android device that registers a UnifiedPush endpoint.',
    ),
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
    unifiedPushEndpoint: UnifiedPushEndpointSchema.nullish(),
    unifiedPushPublicKey: UnifiedPushPublicKeySchema.nullish(),
    unifiedPushAuth: UnifiedPushAuthSchema.nullish(),
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
    unifiedPushEndpoint: UnifiedPushEndpointSchema.nullish().describe(
      'A new UnifiedPush endpoint (with its keys), or null to stop using UnifiedPush and go back to the Cloud gateway',
    ),
    unifiedPushPublicKey: UnifiedPushPublicKeySchema.nullish(),
    unifiedPushAuth: UnifiedPushAuthSchema.nullish(),
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
    operationId: z
      .uuid()
      .optional()
      .describe('Required for studio-render: the owned Studio render media operation this activity follows'),
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

const PushDeviceUnifiedPushSchema = z
  .object({
    endpointHost: z.string().describe("The host of the device's UnifiedPush endpoint; never the full address"),
    available: z
      .boolean()
      .describe('Whether this server delivers to UnifiedPush now (the administrator may limit it to licensed servers)'),
    reason: z
      .string()
      .nullable()
      .describe('Why UnifiedPush is unavailable (`licence-required`); null when available. Open-ended.'),
  })
  .describe('FL-926: the UnifiedPush state of a device that registered an endpoint')
  .meta({ id: 'PushDeviceUnifiedPushDto' });

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
    transport: z
      .string()
      .describe(
        'How pushes reach this device: `cloud` (the Frameleaf Cloud gateway) or `unifiedpush`. Open-ended: treat an unfamiliar value as cloud.',
      ),
    unifiedPush: PushDeviceUnifiedPushSchema.nullable().describe(
      'The UnifiedPush state; null when the device has no UnifiedPush endpoint',
    ),
  })
  .describe('A registered push device. Push tokens and the UnifiedPush endpoint and keys are never returned.')
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
    events: z
      .array(z.string())
      .describe('The events this server can deliver. Open-ended: ignore unfamiliar event names.'),
    registered: z.boolean().describe('Whether the session asking has registered its device'),
    unifiedPush: z
      .object({
        available: z
          .boolean()
          .describe('Whether this server delivers to a UnifiedPush endpoint; it need not be linked to Frameleaf Cloud'),
        reason: z
          .string()
          .nullable()
          .describe('Why UnifiedPush is unavailable (`licence-required`); null when available. Open-ended.'),
        encoding: z
          .string()
          .describe(
            'The Web Push content coding UnifiedPush messages are encrypted in (RFC 8291, RFC 8188): `aes128gcm`',
          ),
      })
      .describe('FL-926: UnifiedPush delivery, for Android devices without Google services')
      .meta({ id: 'PushUnifiedPushStatusDto' }),
  })
  .meta({ id: 'PushStatusResponseDto' });
export class PushStatusResponseDto extends createZodDto(PushStatusResponseSchema) {}

const PushDeviceTestResponseSchema = z
  .object({
    transport: z.string().describe('The way the test went: `cloud` or `unifiedpush`. Open-ended.'),
    status: z
      .string()
      .describe(
        '`sent`: accepted for delivery; `gone`: the push service no longer knows the device, so it was unregistered; `retry`: the push service is busy, try again later; `refused`: the push service or this server refused it (see message); `unavailable`: this server cannot deliver to the device now. Open-ended.',
      ),
    message: z.string().nullable().describe('Why it was not sent, in plain words; null when sent'),
  })
  .meta({ id: 'PushDeviceTestResponseDto' });
export class PushDeviceTestResponseDto extends createZodDto(PushDeviceTestResponseSchema) {}

// Preserve the known-event SDK enum while discovery accepts future event names.
@ExtraModel()
export class PushKnownEventsDto extends createZodDto(
  z.object({ events: z.array(PushEventTypeSchema) }).meta({ id: 'PushKnownEventsDto' }),
) {}
