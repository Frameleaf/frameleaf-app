import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { ManifestKeySchema } from 'src/dtos/cloud-backup.dto.js';
import {
  CLOUD_BACKUP_SELECTION_MAX_ITEMS,
  CLOUD_BACKUP_SELECTION_MAX_RANGES,
} from 'src/utils/cloud-backup-selection.js';

/** FL-362: a period whose photos a choice adds: between two dates (inclusive), or the last N months. */
const CloudBackupDateRangeSchema = z
  .object({
    kind: z.enum(['between', 'recent']).meta({ id: 'CloudBackupDateRangeKind' }),
    from: z.iso.date().optional().describe('between: the first day'),
    to: z.iso.date().optional().describe('between: the last day'),
    months: z.int().min(1).max(1200).optional().describe('recent: how many months back from each backup'),
  })
  .superRefine((range, ctx) => {
    if (range.kind === 'between' && (!range.from || !range.to || range.from > range.to)) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'A period needs a first day on or before its last' });
    }
    if (range.kind === 'recent' && !range.months) {
      ctx.addIssue({ code: 'custom', path: ['months'], message: 'A recent period needs a number of months' });
    }
  })
  .meta({ id: 'CloudBackupDateRangeDto' });

const ids = z.array(z.uuid()).max(CLOUD_BACKUP_SELECTION_MAX_ITEMS).default([]);

const CloudBackupChoiceSchema = z.object({
  mode: z
    .enum(['everything', 'chosen'])
    .describe('everything: the whole library (the default); chosen: what matches any choice')
    .meta({ id: 'CloudBackupSelectionMode' }),
  albumIds: ids,
  collectionIds: ids.describe('A collection chooses the albums it holds'),
  personIds: ids,
  tagIds: ids.describe('A tag also chooses the tags inside it'),
  folders: z
    .array(z.string().min(1).max(4096))
    .max(CLOUD_BACKUP_SELECTION_MAX_ITEMS)
    .default([])
    .describe('Folders as the Folders view names them; a folder also chooses the folders inside it'),
  favorites: z.boolean().default(false),
  dateRanges: z.array(CloudBackupDateRangeSchema).max(CLOUD_BACKUP_SELECTION_MAX_RANGES).default([]),
});

export class CloudBackupSelectionUpdateDto extends createZodDto(
  CloudBackupChoiceSchema.meta({ id: 'CloudBackupSelectionUpdateDto' }),
) {}

export class CloudBackupSelectionResponseDto extends createZodDto(
  CloudBackupChoiceSchema.extend({
    totalOriginals: z.int().describe('Photos and videos of yours that Cloud Backup can keep'),
    selectedOriginals: z.int().describe('Of those, the ones your choice keeps now'),
  }).meta({ id: 'CloudBackupSelectionResponseDto' }),
) {}

/** FL-362: one account's numbers in the newest run's coverage. Never what it chose. */
const CloudBackupCoverageAccountSchema = z
  .object({
    userId: z.uuid(),
    name: z.string(),
    email: z.string(),
    totalOriginals: z.int(),
    selectedOriginals: z.int(),
    licenceEligible: z.boolean(),
    includedOriginals: z.int().nullable().describe('null: not known for this run'),
  })
  .meta({ id: 'CloudBackupCoverageAccountDto' });

export class CloudBackupCoverageResponseDto extends createZodDto(
  z
    .object({
      runId: z.uuid().nullable(),
      inventoryAt: z.string().nullable(),
      state: z
        .enum(['published', 'pending', 'not-reported', 'local', 'unknown'])
        .describe('unknown: no run has taken an inventory yet')
        .meta({ id: 'CloudBackupCoverageReportState' }),
      accounts: z.array(CloudBackupCoverageAccountSchema),
    })
    .meta({ id: 'CloudBackupCoverageResponseDto' }),
) {}

export const CloudBackupExclusionReasonSchema = z
  .enum(['selection', 'licence', 'not-committed', 'unknown'])
  .describe(
    'selection: left out by the account’s choice; licence: the licence did not cover the account; not-committed: chosen but not in this backup yet; unknown: the backup holds no decision',
  )
  .meta({ id: 'CloudBackupExclusionReason' });

export class CloudBackupExclusionsDto extends createZodDto(
  z.object({ manifestKey: ManifestKeySchema }).meta({ id: 'CloudBackupExclusionsDto' }),
) {}

const ExclusionCountsSchema = z.object({
  selection: z.int(),
  licence: z.int(),
  notCommitted: z.int(),
  unknown: z.int(),
});

export class CloudBackupExclusionsResponseDto extends createZodDto(
  z
    .object({
      manifestKey: z.string(),
      decisionKnown: z.boolean().describe('This database holds the decision of the run that wrote the backup'),
      totals: ExclusionCountsSchema.meta({ id: 'CloudBackupExclusionCountsDto' }),
      accounts: z.array(
        ExclusionCountsSchema.extend({ userId: z.uuid(), name: z.string() }).meta({
          id: 'CloudBackupAccountExclusionsDto',
        }),
      ),
    })
    .meta({ id: 'CloudBackupExclusionsResponseDto' }),
) {}

export class OwnerBackupExclusionsDto extends createZodDto(
  z
    .object({
      manifestKey: ManifestKeySchema,
      afterId: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    })
    .meta({ id: 'OwnerBackupExclusionsDto' }),
) {}

export class OwnerBackupExclusionsResponseDto extends createZodDto(
  z
    .object({
      manifestKey: z.string(),
      decisionKnown: z.boolean(),
      items: z.array(
        z
          .object({ assetId: z.uuid(), name: z.string(), reason: CloudBackupExclusionReasonSchema })
          .meta({ id: 'OwnerBackupExclusionDto' }),
      ),
      nextAfterId: z.uuid().nullable(),
    })
    .meta({ id: 'OwnerBackupExclusionsResponseDto' }),
) {}
