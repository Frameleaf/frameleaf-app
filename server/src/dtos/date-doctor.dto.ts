import { IANAZone } from 'luxon';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { DateFindingCause } from 'src/utils/date-doctor.js';

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
    groups: z.array(DateDoctorGroupSchema),
  })
  .meta({ id: 'DateDoctorFindingsResponseDto' });

export class DateDoctorFindingsResponseDto extends createZodDto(DateDoctorFindingsResponseSchema) {}
export type DateDoctorGroup = z.infer<typeof DateDoctorGroupSchema>;

/** FL-930: what to fix, the Doctor's own proposals or a zone and shift chosen for a selection. */
// an IANA zone, or a fixed offset as the Doctor writes one (`UTC+2`, `UTC-5:30`); never `local` or `system`
const isZone = (zone: string) => IANAZone.isValidZone(zone) || /^UTC[+-]\d{1,2}(?::\d{2})?$/.test(zone);

const DateDoctorFixSchema = z
  .object({
    findings: z
      .array(z.object({ assetId: z.uuidv4().describe('Asset ID'), cause: DateFindingCauseSchema }))
      .max(MAX_DATE_FIXES)
      .optional()
      .describe('Proposals to apply as the Doctor made them; one per photo'),
    assetIds: z
      .array(z.uuidv4())
      .max(MAX_DATE_FIXES)
      .optional()
      .describe('Photos to fix with `timeZone` and `shiftMinutes`'),
    timeZone: z
      .string()
      .refine(isZone, 'Unknown time zone')
      .optional()
      .describe(
        'For `assetIds`: their time zone (IANA, or UTC+2 for a fixed offset). The clock time shown stays the same',
      ),
    shiftMinutes: z
      .int()
      .min(-525_600 * 100)
      .max(525_600 * 100)
      .optional()
      .describe('For `assetIds`: move their dates this many minutes (a camera clock that was off)'),
  })
  .refine((dto) => (dto.findings === undefined) !== (dto.assetIds === undefined), 'Send either findings or assetIds')
  .refine((dto) => {
    const ids = dto.findings?.map(({ assetId }) => assetId) ?? dto.assetIds ?? [];
    return ids.length > 0 && new Set(ids).size === ids.length;
  }, 'Name each photo once')
  .refine(
    (dto) => !dto.assetIds || dto.timeZone !== undefined || (dto.shiftMinutes ?? 0) !== 0,
    'Send a timeZone or shiftMinutes with assetIds',
  )
  .meta({ id: 'DateDoctorFixDto' });

const DateFixItemSchema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID'),
    previousDate: z.string().describe('When the photo is dated now'),
    previousZone: z.string().nullable().describe('Its time zone now'),
    newDate: z.string().describe('When it will be dated'),
    newZone: z.string().nullable().describe('Its time zone after the fix'),
  })
  .meta({ id: 'DateFixItemDto' });

const DateDoctorPreviewResponseSchema = z
  .object({ items: z.array(DateFixItemSchema).describe('Each photo that would change, before and after') })
  .meta({ id: 'DateDoctorPreviewResponseDto' });

const DateFixBatchResponseSchema = z
  .object({
    id: z.uuidv7().describe('Batch ID, for undo'),
    count: z.int().min(0).describe('Photos fixed'),
    createdAt: z.string().describe('When the fix was applied'),
    undoneAt: z.string().nullable().describe('When it was undone'),
    undoUntil: z.string().describe('Undo is possible until then'),
    restored: z.int().min(0).optional().describe('After undo: photos put back; one changed since keeps its new date'),
  })
  .meta({ id: 'DateFixBatchResponseDto' });

export class DateDoctorFixDto extends createZodDto(DateDoctorFixSchema) {}
export class DateDoctorPreviewResponseDto extends createZodDto(DateDoctorPreviewResponseSchema) {}
export class DateFixBatchResponseDto extends createZodDto(DateFixBatchResponseSchema) {}
export type DateFixItem = z.infer<typeof DateFixItemSchema>;
