import { IANAZone } from 'luxon';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { DateFindingCause } from 'src/utils/date-doctor.js';
import { DATE_ACCURACIES, DATE_DETAILS, MIN_APPROXIMATE_YEAR, isApproximateYear } from 'src/utils/date.js';

/** FL-912: what the Date & Time Doctor found, a shoot (camera and day) at a time. */

/** FL-930: the most photos one Apply takes. */
export const MAX_DATE_FIXES = 5000;

const DateFindingCauseSchema = z
  .enum(DateFindingCause)
  .describe('Why the date or zone looks wrong')
  .meta({ id: 'DateFindingCause' });

const DateDoctorFindingSchema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID'),
    cause: DateFindingCauseSchema,
    currentDate: z.string().describe('When the photo is dated now'),
    currentZone: z.string().nullable().describe('Its time zone now'),
    proposedDate: z.string().nullable().describe('When it should be dated; null when there is nothing to go on'),
    proposedZone: z.string().nullable().describe('The time zone it should have'),
    confidence: z.number().min(0).max(1).meta({ format: 'double' }).describe('How sure the Doctor is, 0 to 1'),
  })
  .meta({ id: 'DateDoctorFindingDto' });

const DateDoctorGroupSchema = z
  .object({
    groupKey: z.string().describe('Camera and local day'),
    camera: z.string().nullable().describe('The camera, when the photos say'),
    day: z.string().describe('The local day, YYYY-MM-DD'),
    findings: z.array(DateDoctorFindingSchema),
  })
  .meta({ id: 'DateDoctorGroupDto' });

const DateDoctorFindingsResponseSchema = z
  .object({
    total: z.int().min(0).describe('Findings in all groups'),
    scanning: z.boolean().describe('A check of your photos is waiting or running; the findings update when it ends'),
    groups: z.array(DateDoctorGroupSchema),
  })
  .meta({ id: 'DateDoctorFindingsResponseDto' });

export class DateDoctorFindingsResponseDto extends createZodDto(DateDoctorFindingsResponseSchema) {}
export type DateDoctorGroup = z.infer<typeof DateDoctorGroupSchema>;

/** FL-930: what to fix: photos, and the Doctor's proposals for them or a zone and shift. */
// an IANA zone, or a fixed offset as the Doctor writes one (`UTC+2`, `UTC-5:30`); never `local` or `system`
const isZone = (zone: string) => IANAZone.isValidZone(zone) || /^UTC[+-](?:1[0-4]|0?\d)(?::[0-5]\d)?$/.test(zone);

const DateDoctorFixSchema = z
  .object({
    assetIds: z
      .array(z.uuidv4())
      .min(1)
      .max(MAX_DATE_FIXES)
      .refine((ids) => new Set(ids).size === ids.length, 'Name each photo once')
      .describe('The photos to fix'),
    useProposal: z
      .boolean()
      .optional()
      .describe(
        'Give each photo the date and zone the Doctor proposes for it; photos without a proposal are left alone',
      ),
    timeZone: z
      .string()
      .refine(isZone, 'Unknown time zone')
      .optional()
      .describe('The time zone they were taken in (IANA, or UTC+2 for a fixed offset)'),
    keepWallTime: z
      .boolean()
      .optional()
      .describe('With timeZone: keep the clock time shown and read it in the new zone; otherwise the moment stays'),
    shiftMinutes: z
      .int()
      .min(-52_560_000)
      .max(52_560_000)
      .optional()
      .describe('Move their dates this many minutes (a camera clock that was off)'),
    // FL-936
    dateAccuracy: z
      .enum(DATE_ACCURACIES)
      .optional()
      .describe('Date them to a year (`year`) or a decade (`decade`): only that much is known. Sent with `year` alone'),
    year: z
      .int()
      .min(MIN_APPROXIMATE_YEAR)
      .optional()
      .describe('With dateAccuracy: the year, or any year of the decade; not after this year'),
    // FL-1814: beside dateAccuracy, as on the asset, so a client that knows only dateAccuracy is unaffected
    dateDetail: z
      .enum(DATE_DETAILS)
      .optional()
      .describe(
        'With dateAccuracy `year` only: `month` dates them to the 1st of `month` (midnight UTC), `about` says the year is a guess',
      ),
    month: z.int().min(1).max(12).optional().describe('With dateDetail `month` only: the month, 1 to 12'),
  })
  .refine((dto) => {
    const noZoneOrShift =
      dto.timeZone === undefined && dto.shiftMinutes === undefined && dto.keepWallTime === undefined;
    if (dto.dateAccuracy !== undefined || dto.year !== undefined) {
      return (
        dto.dateAccuracy !== undefined &&
        dto.year !== undefined &&
        !dto.useProposal &&
        noZoneOrShift &&
        isApproximateYear(dto.year, dto.dateAccuracy)
      );
    }
    return dto.useProposal ? noZoneOrShift : dto.timeZone !== undefined || (dto.shiftMinutes ?? 0) !== 0;
  }, 'Send useProposal alone, a timeZone and/or shiftMinutes, or a dateAccuracy with a year up to this one')
  .refine((dto) => dto.keepWallTime === undefined || dto.timeZone !== undefined, 'keepWallTime needs a timeZone')
  .refine(
    (dto) => dto.dateDetail === undefined || dto.dateAccuracy === 'year',
    'dateDetail goes with dateAccuracy year',
  )
  .refine(
    (dto) => (dto.dateDetail === 'month') === (dto.month !== undefined),
    'month goes with dateDetail month, and dateDetail month needs one',
  )
  .refine((dto) => {
    if (dto.month === undefined || dto.year === undefined) {
      return true;
    }
    const now = new Date();
    return dto.year * 12 + dto.month <= now.getUTCFullYear() * 12 + now.getUTCMonth() + 1;
  }, 'A month is not after this one')
  .describe(
    'Send `useProposal: true` alone, or a `timeZone` and/or a non-zero `shiftMinutes` (`keepWallTime` only with `timeZone`), or a `dateAccuracy` with its `year` (and with `year`, optionally a `dateDetail`; `month` needs its `month`). Any other combination is refused (400). A zone or shift leaves photos dated to a year or a decade as they are.',
  )
  .meta({ id: 'DateDoctorFixDto' });

const DateDoctorTimeSchema = z
  .object({
    date: z.string().describe('The moment, ISO 8601'),
    zone: z.string().nullable().describe('The time zone; null when the photo has none'),
    local: z.string().describe('The clock time shown, YYYY-MM-DDTHH:mm:ss'),
  })
  .meta({ id: 'DateDoctorTimeDto' });

const DateDoctorPreviewItemSchema = z
  .object({ assetId: z.uuidv4().describe('Asset ID'), before: DateDoctorTimeSchema, after: DateDoctorTimeSchema })
  .meta({ id: 'DateDoctorPreviewItemDto' });

const DateDoctorPreviewResponseSchema = z
  .object({ items: z.array(DateDoctorPreviewItemSchema).describe('Each photo that would change, before and after') })
  .meta({ id: 'DateDoctorPreviewResponseDto' });

const DateDoctorBatchSchema = z
  .object({
    id: z.uuidv7().describe('Batch ID, for undo'),
    createdAt: z.string().describe('When the fix was applied'),
    expiresAt: z.string().describe('Undo is possible until then'),
    count: z.int().min(0).describe('Photos fixed'),
    cause: DateFindingCauseSchema.nullable().describe(
      'The cause of the proposals applied, when they all had one; null for a zone or shift chosen by hand',
    ),
    shiftMinutes: z.int().nullable().describe('The shift chosen, in minutes'),
    timeZone: z.string().nullable().describe('The time zone chosen'),
    // plain strings, not an enum: a response enum can never gain a value without breaking the native apps
    dateAccuracy: z
      .string()
      .nullish()
      .describe('`year` or `decade` when the fix dated the photos to one; other values may be added'),
    periodStart: z.int().nullish().describe('With dateAccuracy: the year that year or decade starts in'),
    undoneAt: z.string().nullable().describe('When it was undone'),
    restored: z
      .int()
      .min(0)
      .optional()
      .describe('After undo: photos put back. A photo dated again since keeps that date'),
  })
  .meta({ id: 'DateDoctorBatchDto' });

const DateDoctorApplyResponseSchema = z
  .object({
    batch: DateDoctorBatchSchema,
    skipped: z.array(z.uuidv4()).describe('Photos left as they were: nothing to change, or dated again meanwhile'),
  })
  .meta({ id: 'DateDoctorApplyResponseDto' });

export class DateDoctorFixDto extends createZodDto(DateDoctorFixSchema) {}
export class DateDoctorPreviewResponseDto extends createZodDto(DateDoctorPreviewResponseSchema) {}
export class DateDoctorBatchDto extends createZodDto(DateDoctorBatchSchema) {}
export class DateDoctorApplyResponseDto extends createZodDto(DateDoctorApplyResponseSchema) {}
