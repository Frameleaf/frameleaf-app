import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * FL-296 (NAPI-014): iCloud source identity, shared by iCloud Photos Sync and the native app, so the
 * two paths that bring one iCloud photo to the server never both download it.
 */

const DateTime = z.string().meta({ format: 'date-time' });
const ICloudClaimHolderSchema = z.enum(['device', 'icloud-sync']).meta({ id: 'ICloudClaimHolder' });
const Sha256 = z
  .string()
  .regex(/^[\dA-Fa-f]{64}$/)
  .toLowerCase();

export const ICloudIdentityRoleSchema = z
  .enum(['original', 'live-motion', 'raw-alternate', 'edit-render'])
  .describe(
    'original: the photo or video as taken; live-motion: a Live Photo video; raw-alternate: the RAW of a RAW + JPEG pair; edit-render: an edited version',
  )
  .meta({ id: 'ICloudIdentityRole' });

export const ICloudMatchStrengthSchema = z
  .enum(['exact', 'corroborated', 'hint'])
  .describe(
    'exact: the record names match and the bytes are proven (Apple fingerprint or the same SHA-256); corroborated: the names match and filename, type, size and date agree; hint: weaker, reported but never acted on',
  )
  .meta({ id: 'ICloudMatchStrength' });

/** What PhotoKit tells the app about one item, for matching it with the sync's inventory. */
const ItemFields = {
  cloudIdentifier: z.string().min(1).max(512).describe('PHCloudIdentifier.stringValue, as the device reports it'),
  originalFilename: z.string().min(1).max(1024).optional(),
  uti: z.string().min(1).max(256).optional(),
  pixelWidth: z.int().min(1).max(1_000_000).optional(),
  pixelHeight: z.int().min(1).max(1_000_000).optional(),
  creationDate: z.iso.datetime({ offset: true }).optional(),
};

export const ICloudCoverageSchema = z
  .object({
    deviceKey: z.uuid().describe("This device's backup identity (the backup device registry's deviceKey)"),
    samples: z
      .array(z.object(ItemFields).meta({ id: 'ICloudCoverageSampleDto' }))
      .min(1)
      .max(200)
      .describe('Sampled items: some old, some recent, some in albums'),
  })
  .meta({ id: 'ICloudCoverageDto' });
export class ICloudCoverageDto extends createZodDto(ICloudCoverageSchema) {}

export const ICloudConnectionHealthSchema = z
  .enum(['healthy', 'paused', 'reauthentication-required', 'device-approval-required', 'failing', 'disconnected'])
  .meta({ id: 'ICloudConnectionHealth' });

const CoverageConnection = z
  .object({
    connectionId: z.uuid(),
    label: z.string(),
    account: z
      .string()
      .nullable()
      .describe('The Apple Account, masked (a•••@icloud.com); null until it signs in again'),
    state: ICloudConnectionHealthSchema,
    unhealthySince: DateTime.nullable(),
    scope: z.object({
      kind: z
        .enum(['libraries', 'albums'])
        .describe('Whole libraries, or only some albums')
        .meta({ id: 'ICloudCoverageScopeKind' }),
      libraries: z.array(z.string()).describe('Library zones; empty means every supported library'),
      albums: z.array(z.string()),
    }),
    includeEdits: z.boolean(),
    lastCompleteInventoryAt: DateTime.nullable(),
    nextRunAt: DateTime.nullable(),
    sampled: z.int().describe('Samples that existed before the last complete inventory'),
    matched: z.int().describe('Of those, matched in the inventory as corroborated or better'),
    covers: z
      .boolean()
      .describe('At least 20 samples and 95 % of them matched: this connection covers the device library'),
  })
  .meta({ id: 'ICloudCoverageConnectionDto' });

export const ICloudCoverageResponseSchema = z
  .object({
    identityMatching: z
      .boolean()
      .describe('False when identity matching is switched off: no connection can then be shown to cover the library'),
    connections: z.array(CoverageConnection),
  })
  .meta({ id: 'ICloudCoverageResponseDto' });
export class ICloudCoverageResponseDto extends createZodDto(ICloudCoverageResponseSchema) {}

export const ICloudLookupSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256).describe("The client's own key for the item, echoed back"),
            ...ItemFields,
            roles: z.array(ICloudIdentityRoleSchema).min(1).max(4),
            sha256ByRole: z
              .partialRecord(ICloudIdentityRoleSchema, Sha256)
              .optional()
              .describe('SHA-256 of the resources the device holds locally, by role'),
            editVersion: z
              .string()
              .min(1)
              .max(256)
              .optional()
              .describe("The device's edit version (SHA-256 of the adjustment data and the modification date)"),
          })
          .meta({ id: 'ICloudLookupItemDto' }),
      )
      .min(1)
      .max(1000),
  })
  .meta({ id: 'ICloudLookupDto' });
export class ICloudLookupDto extends createZodDto(ICloudLookupSchema) {}

export const ICloudVerifySchema = z
  .object({
    connectionId: z.uuid(),
    requestKey: z.uuid(),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            assetId: z.uuid(),
            cloudIdentifier: ItemFields.cloudIdentifier,
            role: ICloudIdentityRoleSchema,
            editVersion: z.string().max(256).default(''),
          })
          .refine(
            (item) => (item.role === 'edit-render') === (item.editVersion !== ''),
            'Edit version requires edit-render',
          ),
      )
      .min(1)
      .max(100),
  })
  .refine((dto) => new Set(dto.items.map(({ id }) => id)).size === dto.items.length, 'Duplicate item IDs')
  .meta({ id: 'ICloudVerifyDto' });
export class ICloudVerifyDto extends createZodDto(ICloudVerifySchema) {}
export const ICloudVerifyResponseSchema = z
  .object({
    operationId: z.uuid(),
    items: z.array(z.object({ id: z.string(), state: z.enum(['queued', 'unavailable']) })),
  })
  .meta({ id: 'ICloudVerifyResponseDto' });
export class ICloudVerifyResponseDto extends createZodDto(ICloudVerifyResponseSchema) {}

export const ICloudItemStateSchema = z
  .enum(['on-server', 'sync-pending', 'claimed', 'out-of-scope', 'unknown', 'review'])
  .describe(
    'on-server: the server has it; sync-pending: a healthy sync will import it; claimed: a path is fetching it; out-of-scope: a known library, outside the sync selection; unknown: nothing known; review: conflicting identities',
  )
  .meta({ id: 'ICloudItemState' });

const RoleAnswer = z
  .object({
    role: ICloudIdentityRoleSchema,
    state: ICloudItemStateSchema,
    assetId: z.uuid().nullable(),
    sha256: z.string().nullable(),
    deliveredBy: z.string().nullable().describe('icloud-sync:<connectionId> or device:<deviceKey>'),
    lastVerifiedAt: DateTime.nullable(),
    auditVerifiedAt: DateTime.nullable().describe(
      'When an audit download proved an identity reuse; Free Up Space needs it',
    ),
    matchStrength: ICloudMatchStrengthSchema.nullable(),
    connectionId: z.uuid().nullable(),
    expectedBy: DateTime.nullable().describe('sync-pending: the next sync run'),
    pendingSince: DateTime.nullable(),
    claimedBy: ICloudClaimHolderSchema.nullable().describe('claimed: who is fetching it'),
    claimExpiresAt: DateTime.nullable(),
  })
  .meta({ id: 'ICloudLookupRoleDto' });

const LookupAnswer = z
  .object({
    id: z.string(),
    cplAssetRecordName: z.string().nullable(),
    editOwner: z
      .object({
        kind: z.enum(['icloud-sync', 'device']).meta({ id: 'ICloudEditOwnerKind' }),
        connectionId: z.uuid().nullable(),
      })
      .describe('Who delivers edit renders for this item; the other path never uploads one'),
    roles: z.array(RoleAnswer),
  })
  .meta({ id: 'ICloudLookupAnswerDto' });

export const ICloudLookupResponseSchema = z
  .object({
    identityMatching: z.boolean().describe('False when identity matching is switched off: only SHA-256 matches count'),
    items: z.array(LookupAnswer),
  })
  .meta({ id: 'ICloudLookupResponseDto' });
export class ICloudLookupResponseDto extends createZodDto(ICloudLookupResponseSchema) {}

const DeviceKey = z.uuid().describe("This device's backup identity (the backup device registry's deviceKey)");
const ClaimTtl = z
  .int()
  .min(60)
  .max(600)
  .optional()
  .describe('Seconds the claim lives before it must be renewed (default and most: 10 minutes)');

export const ICloudClaimSchema = z
  .object({
    deviceKey: DeviceKey,
    items: z
      .array(z.object({ id: z.string().min(1).max(256), ...ItemFields }).meta({ id: 'ICloudClaimItemDto' }))
      .min(1)
      .max(500),
    ttlSec: ClaimTtl,
    takeOver: z
      .boolean()
      .optional()
      .describe(
        'The person chose "Back them up from this iPhone": claim items an unhealthy sync connection covers without waiting 72 hours',
      ),
  })
  .meta({ id: 'ICloudClaimDto' });
export class ICloudClaimDto extends createZodDto(ICloudClaimSchema) {}

export const ICloudClaimStateSchema = z
  .enum(['granted', 'held', 'sync-covers', 'invalid'])
  .describe(
    'granted: this device holds the claim; held: another device or a sync run does; sync-covers: a healthy sync connection covers the item, so the server fetches it; invalid: the identifier is not an iCloud item identifier',
  )
  .meta({ id: 'ICloudClaimState' });

const ClaimAnswer = z
  .object({
    id: z.string(),
    cplAssetRecordName: z.string().nullable(),
    state: ICloudClaimStateSchema,
    claimId: z.uuid().nullable(),
    expiresAt: DateTime.nullable(),
    holder: ICloudClaimHolderSchema.nullable().describe('held: who holds it'),
    connectionId: z.uuid().nullable().describe('sync-covers: the connection that covers it'),
    takeOverAt: DateTime.nullable().describe(
      'sync-covers on an unhealthy connection: when this device may take over without asking (72 hours after it became unhealthy)',
    ),
  })
  .meta({ id: 'ICloudClaimAnswerDto' });

export const ICloudClaimResponseSchema = z
  .object({ items: z.array(ClaimAnswer) })
  .meta({ id: 'ICloudClaimResponseDto' });
export class ICloudClaimResponseDto extends createZodDto(ICloudClaimResponseSchema) {}

export const ICloudClaimRenewSchema = z
  .object({ deviceKey: DeviceKey, claimIds: z.array(z.uuid()).min(1).max(500), ttlSec: ClaimTtl })
  .meta({ id: 'ICloudClaimRenewDto' });
export class ICloudClaimRenewDto extends createZodDto(ICloudClaimRenewSchema) {}

export const ICloudClaimRenewResponseSchema = z
  .object({
    claims: z.array(z.object({ claimId: z.uuid(), expiresAt: DateTime }).meta({ id: 'ICloudClaimRenewedDto' })),
  })
  .describe('Only the claims still held; a missing one expired or was taken over')
  .meta({ id: 'ICloudClaimRenewResponseDto' });
export class ICloudClaimRenewResponseDto extends createZodDto(ICloudClaimRenewResponseSchema) {}

export const ICloudClaimReleaseSchema = z
  .object({ deviceKey: DeviceKey, claimIds: z.array(z.uuid()).min(1).max(500) })
  .meta({ id: 'ICloudClaimReleaseDto' });
export class ICloudClaimReleaseDto extends createZodDto(ICloudClaimReleaseSchema) {}

export const ICloudClaimReleaseResponseSchema = z
  .object({ released: z.array(z.uuid()) })
  .meta({ id: 'ICloudClaimReleaseResponseDto' });
export class ICloudClaimReleaseResponseDto extends createZodDto(ICloudClaimReleaseResponseSchema) {}

/** Attach PhotoKit identities to originals this device already uploaded, after matching SHA-256. */
export const ICloudAttachSchema = z
  .object({
    deviceKey: DeviceKey,
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(256),
            assetId: z.uuid(),
            ...ItemFields,
            role: ICloudIdentityRoleSchema,
            sha256: Sha256,
            editVersion: z.string().min(1).max(512).optional(),
          })
          .refine((item) => item.role !== 'edit-render' || !!item.editVersion, {
            message: 'An edit render requires its edit version',
            path: ['editVersion'],
          })
          .meta({ id: 'ICloudAttachItemDto' }),
      )
      .min(1)
      .max(500),
  })
  .meta({ id: 'ICloudAttachDto' });
export class ICloudAttachDto extends createZodDto(ICloudAttachSchema) {}

export const ICloudAttachResponseSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string(),
          state: z.enum(['attached', 'unavailable', 'invalid']).meta({ id: 'ICloudAttachState' }),
        })
        .meta({ id: 'ICloudAttachAnswerDto' }),
    ),
  })
  .meta({ id: 'ICloudAttachResponseDto' });
export class ICloudAttachResponseDto extends createZodDto(ICloudAttachResponseSchema) {}

/** Explicit owner decisions are administrative authority, never provider revision/equivalence proof. */
const EditDecisionBase = {
  requestId: z.uuid(),
  expectedGeneration: z.int().min(0).max(2_147_483_646),
};
export const ICloudEditBaselineSchema = z
  .object({
    ...EditDecisionBase,
    receiptId: z.uuid().describe('An accessible owned stored source identity with verified current asset digest'),
    holder: z.discriminatedUnion('kind', [
      z.object({ kind: z.enum(['device']).meta({ id: 'ICloudEditDeviceHolderKind' }), id: z.uuid() }).strict(),
      z.object({ kind: z.enum(['icloud-sync']).meta({ id: 'ICloudEditSyncHolderKind' }), id: z.uuid() }).strict(),
    ]),
    sourceIncarnation: z.uuid(),
    nativeVersion: z.string().min(1).max(256),
    takeOver: z.boolean().default(false).describe('Only bypasses the 72-hour wait for an unhealthy source'),
  })
  .strict()
  .meta({ id: 'ICloudEditBaselineDto' });
export class ICloudEditBaselineDto extends createZodDto(ICloudEditBaselineSchema) {}
export const ICloudEditSuccessorSchema = z
  .object({
    ...EditDecisionBase,
    expectedVersionId: z.uuid(),
    reuseVersionId: z
      .uuid()
      .optional()
      .describe(
        'Explicit administrative binding to a known canonical version with identical verified render bytes; never inferred provider equivalence',
      ),
    channel: z.enum(['device', 'icloud-sync']).meta({ id: 'ICloudEditPublicationChannel' }),
    resourceId: z.uuid().describe('Existing verified bytes; accepting this is an explicit owner successor decision'),
    policy: z.enum(['keep', 'supersede']).meta({ id: 'ICloudEditRetentionPolicy' }).default('keep'),
  })
  .strict()
  .meta({ id: 'ICloudEditSuccessorDto' });
export class ICloudEditSuccessorDto extends createZodDto(ICloudEditSuccessorSchema) {}
export const ICloudEditDecisionResponseSchema = z
  .object({
    decisionId: z.uuid(),
    generation: z.int().min(1),
    versionId: z.uuid(),
    evidenceType: z.literal('administrative'),
  })
  .meta({ id: 'ICloudEditDecisionResponseDto' });
export class ICloudEditDecisionResponseDto extends createZodDto(ICloudEditDecisionResponseSchema) {}

/** Discovery is a complete bounded snapshot, never a publication grant or provider ordering. */
export const ICloudEditEvidenceQuerySchema = z
  .object({ assetId: z.uuid() })
  .strict()
  .meta({ id: 'ICloudEditEvidenceQueryDto' });
export class ICloudEditEvidenceQueryDto extends createZodDto(ICloudEditEvidenceQuerySchema) {}
export const ICloudEditEvidenceResponseSchema = z
  .object({
    complete: z.literal(true),
    admissionGuaranteed: z.literal(false),
    items: z.array(
      z.object({
        item: z.string(),
        receipts: z.array(
          z.object({
            receiptId: z.uuid(),
            assetId: z.uuid(),
            sha256: Sha256,
            role: z.enum(['original', 'edit-render']).meta({ id: 'ICloudEditReceiptRole' }),
            nativeVersion: z.string(),
            suggestedAdministrativeLabel: z.literal('administrative-original').nullable(),
            deliveredBy: z.string(),
          }),
        ),
        authority: z
          .object({
            evidenceType: z.literal('administrative'),
            generation: z.int(),
            versionId: z.uuid(),
            assetId: z.uuid(),
            sha256: Sha256,
            holder: z.string(),
            sourceIncarnation: z.uuid(),
          })
          .nullable(),
        holders: z.array(
          z.object({
            holder: z.string(),
            state: z.string(),
            unhealthySince: DateTime.nullable(),
            automaticTakeoverEligible: z.boolean(),
          }),
        ),
        claims: z.array(z.object({ claimId: z.uuid(), holder: z.string(), expiresAt: DateTime })),
        incoming: z.array(
          z.object({
            channel: z.enum(['device', 'icloud-sync']).meta({ id: 'ICloudEditPublicationChannel' }),
            resourceId: z.uuid(),
            holder: z.string(),
            nativeVersion: z.string(),
            sha256: Sha256,
            state: z.string(),
            claimLive: z.boolean(),
            administrativeDecisionRequired: z.literal(true),
          }),
        ),
      }),
    ),
  })
  .meta({ id: 'ICloudEditEvidenceResponseDto' });
export class ICloudEditEvidenceResponseDto extends createZodDto(ICloudEditEvidenceResponseSchema) {}
