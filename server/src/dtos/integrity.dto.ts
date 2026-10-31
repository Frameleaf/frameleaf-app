import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { IntegrityReport, IntegrityReportSchema } from 'src/enum.js';

const IntegrityReportSummaryResponseSchema = z
  .object({
    [IntegrityReport.ChecksumFail]: z.int().nonnegative(),
    [IntegrityReport.MissingFile]: z.int().nonnegative(),
    [IntegrityReport.UntrackedFile]: z.int().nonnegative(),
  })
  .meta({ id: 'IntegrityReportSummaryResponseDto' });

/** FL-81 (CC-21, `Maintenance.jsx` 467): when each check last completed a full run; null when none is recorded. */
const lastRunAt = z.string().meta({ format: 'date-time' }).nullable();
const IntegrityCheckRunsResponseSchema = z
  .object({
    [IntegrityReport.ChecksumFail]: lastRunAt.describe('When the checksum check last completed a full pass'),
    [IntegrityReport.MissingFile]: lastRunAt.describe('When the missing-file check last completed'),
    [IntegrityReport.UntrackedFile]: lastRunAt.describe('When the untracked-file check last completed'),
  })
  .meta({ id: 'IntegrityCheckRunsResponseDto' });

const IntegrityGetReportSchema = z
  .object({
    type: IntegrityReportSchema,
    cursor: z.string().optional().describe('Cursor for pagination'),
    // D2: a query string value is text, so coerce it (`?limit=50`) as the other query DTOs do.
    limit: z.coerce.number().int().positive().default(500).optional().describe('Number of items per page'),
  })
  .meta({ id: 'IntegrityGetReportDto' });

const IntegrityDeleteReportSchema = z.object({ type: IntegrityReportSchema }).meta({ id: 'IntegrityDeleteReportDto' });

const IntegrityReportResponseItemSchema = z.object({
  id: z.uuidv4().describe('Integrity report item id'),
  type: IntegrityReportSchema,
  path: z.string().describe('Integrity report item path'),
});

const IntegrityReportResponseSchema = z
  .object({
    items: z.array(IntegrityReportResponseItemSchema),
    nextCursor: z.string().optional(),
  })
  .meta({ id: 'IntegrityReportResponseDto' });

const IntegrityReportParamSchema = z.object({ type: IntegrityReportSchema }).meta({ id: 'IntegrityReportDto' });

/** FL-366: how many findings "Clear this list" forgot. */
const IntegrityReportClearResponseSchema = z
  .object({ cleared: z.int().nonnegative().describe('Findings removed from the list; no file or photo was changed') })
  .meta({ id: 'IntegrityReportClearResponseDto' });

/** FL-520: a folder of originals that cannot be reached (a drive unplugged, a share not mounted). */
const IntegrityUnreachableFolderSchema = z
  .object({
    kind: z
      .enum(['storage', 'library'])
      .describe("storage: Frameleaf's own folders; library: an external library's folder")
      .meta({ id: 'IntegrityUnreachableFolderKind' }),
    name: z.string().describe('The external library’s name; empty for Frameleaf’s own folders'),
    path: z.string().describe('The folder on the server'),
    missing: z.int().nonnegative().describe('Missing-file findings inside this folder'),
  })
  .meta({ id: 'IntegrityUnreachableFolderDto' });

const IntegrityCheckProgressSchema = z
  .object({
    type: IntegrityReportSchema,
    startedAt: z.string().meta({ format: 'date-time' }),
    done: z.int().nonnegative().describe('Parts finished: batches of files, or files read by the damage check'),
    total: z.int().nonnegative().nullable().describe('Parts in this run; null until they are all counted'),
  })
  .meta({ id: 'IntegrityCheckProgressDto' });

const IntegrityCheckHistoryEntrySchema = z
  .object({
    type: IntegrityReportSchema,
    startedAt: z.string().meta({ format: 'date-time' }),
    finishedAt: z.string().meta({ format: 'date-time' }),
    outcome: z
      .enum(['completed', 'paused', 'stopped'])
      .describe(
        'completed: it looked at everything; paused: the damage check reached its nightly limit and carries on next night; stopped: an administrator stopped it',
      )
      .meta({ id: 'IntegrityCheckOutcome' }),
    found: z.int().nonnegative().describe('Findings in its list when it ended'),
    checked: z.int().nonnegative().nullable().describe('Files it looked at, when counted'),
    encrypted: z
      .int()
      .nonnegative()
      .optional()
      .describe('Encrypted Locked files the damage check passed over: encrypted, not checked (not counted in checked)'),
  })
  .meta({ id: 'IntegrityCheckHistoryEntryDto' });

/** FL-520: Library care's one source of findings, what is running now, and the recent checks. */
const IntegrityOverviewResponseSchema = z
  .object({
    missing: z.int().nonnegative().describe('Missing files, each counted once across both checkers'),
    damaged: z.int().nonnegative().describe('Damaged files, each counted once across both checkers'),
    stray: z.int().nonnegative().describe('Files on the drive that are in no library'),
    rawToMatch: z.int().nonnegative().describe('Missing photos whose original is a RAW file'),
    unreachable: z.array(IntegrityUnreachableFolderSchema).describe('Folders of originals that cannot be reached'),
    running: z.array(IntegrityCheckProgressSchema).describe('Checks in progress'),
    history: z.array(IntegrityCheckHistoryEntrySchema).describe('The most recent checks, newest first'),
  })
  .meta({ id: 'IntegrityOverviewResponseDto' });

const IntegrityFindingAssetsSchema = z
  .object({
    kind: z.enum(['missing', 'damaged']).describe('Which findings').meta({ id: 'IntegrityFindingKind' }),
  })
  .meta({ id: 'IntegrityFindingAssetsDto' });

const IntegrityFindingAssetsResponseSchema = z
  .object({ assetIds: z.array(z.uuidv4()).describe('Photos behind the findings, at most 10,000') })
  .meta({ id: 'IntegrityFindingAssetsResponseDto' });

export class IntegrityOverviewResponseDto extends createZodDto(IntegrityOverviewResponseSchema) {}
export class IntegrityFindingAssetsDto extends createZodDto(IntegrityFindingAssetsSchema) {}
export class IntegrityFindingAssetsResponseDto extends createZodDto(IntegrityFindingAssetsResponseSchema) {}
export type IntegrityUnreachableFolder = z.infer<typeof IntegrityUnreachableFolderSchema>;

export class IntegrityReportClearResponseDto extends createZodDto(IntegrityReportClearResponseSchema) {}
export class IntegrityReportSummaryResponseDto extends createZodDto(IntegrityReportSummaryResponseSchema) {}
export class IntegrityCheckRunsResponseDto extends createZodDto(IntegrityCheckRunsResponseSchema) {}
export class IntegrityGetReportDto extends createZodDto(IntegrityGetReportSchema) {}
export class IntegrityDeleteReportDto extends createZodDto(IntegrityDeleteReportSchema) {}
export class IntegrityReportResponseDto extends createZodDto(IntegrityReportResponseSchema) {}
export class IntegrityReportTypeParamDto extends createZodDto(IntegrityReportParamSchema) {}
