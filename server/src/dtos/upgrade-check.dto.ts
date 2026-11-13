import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { UPGRADE_CHECK_FINDING_REASONS } from 'src/utils/library-fingerprint.js';

/**
 * FL-954: the library check after an upgrade. `none` until this server has upgraded once with the
 * check in place; `ok` when the library is as it was; `attention` when a difference was found.
 */
export const UPGRADE_CHECK_STATES = ['none', 'ok', 'attention'] as const;
export type UpgradeCheckState = (typeof UPGRADE_CHECK_STATES)[number];

/** Why the check needs someone. One value today; a field of its own, so attention reasons stay as they are. */
export const UPGRADE_CHECK_REASONS = ['upgrade-check-failed'] as const;

const UpgradeCheckStateSchema = z
  .enum(UPGRADE_CHECK_STATES)
  .describe('How the library check after the last upgrade came out; none when there has been no check yet')
  .meta({ id: 'UpgradeCheckState' });

const UpgradeCheckReasonSchema = z
  .enum(UPGRADE_CHECK_REASONS)
  .describe('Why the check needs an administrator')
  .meta({ id: 'UpgradeCheckReason' });

const UpgradeCheckFindingReasonSchema = z
  .enum(UPGRADE_CHECK_FINDING_REASONS)
  .describe(
    'What differs: a drive that is not mounted, fewer photos and videos, a newest photo older than before, or a folder that is empty now',
  )
  .meta({ id: 'UpgradeCheckFindingReason' });

const dateTime = () => z.string().meta({ format: 'date-time' });

const UpgradeCheckFindingSchema = z
  .object({
    reason: UpgradeCheckFindingReasonSchema,
    path: z.string().nullable().describe('The folder of the drive, or the folder that is empty now'),
    name: z.string().nullable().describe('The external library the folder belongs to, when it is one'),
    before: z
      .int()
      .min(0)
      .nullable()
      .describe('Photos and videos before the upgrade: in the library, in the folder, or on the drive'),
    after: z.int().min(0).nullable().describe('Photos and videos now; null for a drive that is not mounted'),
    beforeAt: dateTime().nullable().describe('When the newest photo was added, before the upgrade'),
    afterAt: dateTime().nullable().describe('When the newest photo was added, now'),
  })
  .meta({ id: 'UpgradeCheckFindingDto' });

const UpgradeCheckCountSchema = z
  .object({
    name: z.string().describe('What was counted, for example asset or person'),
    before: z.int().min(0).nullable().describe('Rows before the upgrade; null when it was not there'),
    after: z.int().min(0).nullable().describe('Rows now'),
  })
  .meta({ id: 'UpgradeCheckCountDto' });

const UpgradeCheckSummarySchema = z
  .object({
    state: UpgradeCheckStateSchema,
    reason: UpgradeCheckReasonSchema.nullable().describe('Set when the state is attention'),
    checkedAt: dateTime().nullable().describe('When the check ran'),
    fromVersion: z.string().nullable().describe('The version before the upgrade'),
    toVersion: z.string().nullable().describe('The version the upgrade installed'),
  })
  .meta({ id: 'UpgradeCheckSummaryDto' });

const UpgradeCheckResponseSchema = UpgradeCheckSummarySchema.extend({
  findings: z.array(UpgradeCheckFindingSchema).describe('Each difference found, a drive that is not mounted first'),
  assetsBefore: z.int().min(0).nullable().describe('Photos and videos before the upgrade'),
  assetsAfter: z.int().min(0).nullable().describe('Photos and videos after it'),
  counts: z.array(UpgradeCheckCountSchema).describe('Row counts of the key tables, before and after'),
}).meta({ id: 'UpgradeCheckResponseDto' });

export { UpgradeCheckSummarySchema };
export type UpgradeCheckSummary = z.infer<typeof UpgradeCheckSummarySchema>;
export class UpgradeCheckResponseDto extends createZodDto(UpgradeCheckResponseSchema) {}
