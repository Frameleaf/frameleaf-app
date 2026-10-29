import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** FL-639: "Cut out the subject" for one video clip of a Studio project. */

const StudioCutoutSubjectKindSchema = z
  .enum(['person', 'subject'])
  .describe('A person recognised in the clip, or the main subject when there is no one')
  .meta({ id: 'StudioCutoutSubjectKind' });

const StudioCutoutSubjectSchema = z
  .object({
    kind: StudioCutoutSubjectKindSchema,
    personId: z.uuid().nullable().describe('The person, for a person subject'),
    name: z.string().nullable().describe('The person’s name, for a person subject'),
  })
  .meta({ id: 'StudioCutoutSubjectDto' });

const StudioCutoutSubjectsSchema = z
  .object({
    subjects: z
      .array(StudioCutoutSubjectSchema)
      .min(1)
      .describe('The named people face recognition found in the clip’s video, or just the main subject'),
  })
  .meta({ id: 'StudioCutoutSubjectsDto' });

const StudioCutoutSubjectsQuerySchema = z
  .object({ clipId: z.string().min(1).max(200).describe('A video clip on the main timeline of the head revision') })
  .meta({ id: 'StudioCutoutSubjectsQueryDto' });

const StudioCutoutPointSchema = z
  .object({
    sourceSeconds: z.number().min(0).describe('When in the source video the point was painted, in seconds').meta({ format: 'double' }),
    x: z.number().min(0).max(1).describe('Across the picture, 0 at the left edge and 1 at the right').meta({ format: 'double' }),
    y: z.number().min(0).max(1).describe('Down the picture, 0 at the top and 1 at the bottom').meta({ format: 'double' }),
    label: z.union([z.literal(0), z.literal(1)]).describe('1 adds to the subject, 0 takes away'),
  })
  .meta({ id: 'StudioCutoutPointDto' });

const StudioCutoutCreateSchema = z
  .object({
    clipId: z.string().min(1).max(200).describe('A video clip on the main timeline of the head revision'),
    personId: z.uuid().nullable().describe('The person to cut out, or null for the main subject'),
    points: z
      .array(StudioCutoutPointSchema)
      .max(64)
      .default([])
      .describe('Add to subject and Take away points, followed through the shot from where they were painted'),
  })
  .meta({ id: 'StudioCutoutCreateDto' });

const StudioCutoutStatusSchema = z
  .enum(['queued', 'running', 'completed', 'failed'])
  .describe('Where the cut-out is')
  .meta({ id: 'StudioCutoutStatus' });

const StudioCutoutMatteSchema = z
  .object({
    importId: z.uuid().describe('The matte, kept with the project as a file: frames side by side, row after row'),
    startSeconds: z.number().min(0).describe('Where the followed part of the source starts, in seconds').meta({ format: 'double' }),
    durationSeconds: z.number().positive().describe('How long the followed part is, in seconds').meta({ format: 'double' }),
    fps: z.number().positive().describe('Matte frames a second').meta({ format: 'double' }),
    frames: z.int().min(1).describe('Matte frames in the file'),
    columns: z.int().min(1).describe('Matte frames in each row of the file'),
    frameWidth: z.int().min(1).describe('Width of one matte frame in pixels'),
    frameHeight: z.int().min(1).describe('Height of one matte frame in pixels'),
  })
  .meta({ id: 'StudioCutoutMatteDto' });

const StudioCutoutSchema = z
  .object({
    id: z.uuid().describe('The cut-out job'),
    projectId: z.string().describe('The Studio project'),
    clipId: z.string().describe('The video clip'),
    subject: StudioCutoutSubjectSchema,
    status: StudioCutoutStatusSchema,
    progress: z.number().min(0).max(100).describe('Frames followed so far, in percent').meta({ format: 'double' }),
    error: z.string().nullable().describe('Why it failed, in words a person can read'),
    matte: StudioCutoutMatteSchema.nullable().describe('Once completed: the matte to name on the clip'),
  })
  .meta({ id: 'StudioCutoutDto' });

const StudioCutoutParamSchema = z.object({
  id: z.uuidv7().describe('Studio project id'),
  cutoutId: z.uuid().describe('Cut-out job id'),
});

export class StudioCutoutSubjectsDto extends createZodDto(StudioCutoutSubjectsSchema) {}
export class StudioCutoutSubjectsQueryDto extends createZodDto(StudioCutoutSubjectsQuerySchema) {}
export class StudioCutoutCreateDto extends createZodDto(StudioCutoutCreateSchema) {}
export class StudioCutoutDto extends createZodDto(StudioCutoutSchema) {}
export class StudioCutoutParamDto extends createZodDto(StudioCutoutParamSchema) {}
export type StudioCutoutSubject = z.infer<typeof StudioCutoutSubjectSchema>;
export type StudioCutoutMatte = z.infer<typeof StudioCutoutMatteSchema>;
export type StudioCutoutStatus = z.infer<typeof StudioCutoutStatusSchema>;
