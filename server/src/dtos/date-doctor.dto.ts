import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { DateFindingCause } from 'src/utils/date-doctor.js';

/** FL-912: what the Date & Time Doctor found, a shoot (camera and day) at a time. */

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
