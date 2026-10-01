import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * FL-296 (NAPI-014): iCloud source identity, shared by iCloud Photos Sync and the native app, so the
 * two paths that bring one iCloud photo to the server never both download it.
 */

const DateTime = z.string().meta({ format: 'date-time' });
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
  creationDate: DateTime.optional(),
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
      kind: z.enum(['libraries', 'albums']).describe('Whole libraries, or only some albums'),
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
  .object({ connections: z.array(CoverageConnection) })
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
  })
  .meta({ id: 'ICloudLookupRoleDto' });

const LookupAnswer = z
  .object({
    id: z.string(),
    cplAssetRecordName: z.string().nullable(),
    editOwner: z
      .object({
        kind: z.enum(['icloud-sync', 'device']),
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
