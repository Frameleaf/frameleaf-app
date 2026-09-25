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
    limit: z.int().positive().default(500).optional().describe('Number of items per page'),
  })
  .meta({ id: 'IntegrityGetReportDto' });

const IntegrityDeleteReportSchema = z.object({ type: IntegrityReport }).meta({ id: 'IntegrityDeleteReportDto' });

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

export class IntegrityReportSummaryResponseDto extends createZodDto(IntegrityReportSummaryResponseSchema) {}
export class IntegrityCheckRunsResponseDto extends createZodDto(IntegrityCheckRunsResponseSchema) {}
export class IntegrityGetReportDto extends createZodDto(IntegrityGetReportSchema) {}
export class IntegrityDeleteReportDto extends createZodDto(IntegrityDeleteReportSchema) {}
export class IntegrityReportResponseDto extends createZodDto(IntegrityReportResponseSchema) {}
export class IntegrityReportTypeParamDto extends createZodDto(IntegrityReportParamSchema) {}
