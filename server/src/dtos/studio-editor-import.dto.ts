import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MediaOperationStatusSchema } from 'src/enum.js';

export const StudioEditorImportSourceSchema = z
  .enum(['premiere', 'resolve', 'finalcut', 'imovie', 'otio', 'fcp7', 'edl', 'aaf'])
  .describe('The editor or interchange format the project came from')
  .meta({ id: 'StudioEditorImportSource' });

export const StudioEditorImportStepSchema = z
  .enum(['reading', 'media', 'building', 'checking', 'done'])
  .describe('What the job is doing: reading the file, finding media, building the project, checking it')
  .meta({ id: 'StudioEditorImportStep' });

export const StudioEditorImportMatchSchema = z
  .enum(['found', 'very-likely', 'likely', 'possible', 'missing'])
  .describe(
    '`found`: the file is in the library and is used; `very-likely`, `likely`, `possible`: a match to confirm; `missing`: not in the library',
  )
  .meta({ id: 'StudioEditorImportMatch' });

export class StudioEditorImportUploadDto extends createZodDto(
  z
    .object({
      id: z.uuid().describe('The upload; name it when starting the import'),
      fileName: z.string(),
      sizeBytes: z.int().min(0),
    })
    .meta({ id: 'StudioEditorImportUploadDto' }),
) {}

export class StudioEditorImportCreateDto extends createZodDto(
  z
    .object({
      uploadId: z.uuid().describe('The project file, uploaded with `POST /studio/editor-imports/uploads`'),
      sidecarUploadIds: z
        .array(z.uuid())
        .max(6)
        .optional()
        .describe('CDL (.cdl, .cc, .ccc) and LUT (.cube) files to apply to the clips they name'),
      frameRate: z
        .number()
        .positive()
        .max(240)
        .optional()
        .meta({ format: 'double' })
        .describe('For an edit decision list, which does not state its frame rate: frames a second, e.g. 23.976'),
    })
    .meta({ id: 'StudioEditorImportCreateDto' }),
) {}

export class StudioEditorImportQueuedDto extends createZodDto(
  z
    .object({
      id: z.uuidv7().describe('The job id; it also shows in Activity (`/media-operations/{id}`)'),
      status: MediaOperationStatusSchema,
    })
    .meta({ id: 'StudioEditorImportQueuedDto' }),
) {}

const NoteSchema = z
  .object({
    code: z.string().describe('What kind of difference, e.g. `transition-unmatched`'),
    clip: z.string().describe('The clip, transition or marker it is about'),
    what: z.string().describe('What it was in the other editor'),
    became: z.string().describe('What it became in Studio'),
    atSeconds: z.number().min(0).meta({ format: 'double' }).describe('Where on the timeline'),
  })
  .meta({ id: 'StudioEditorImportNote' });

const NoticeSchema = z
  .object({
    code: z
      .string()
      .describe(
        '`version-untested`, `clips-disabled`, `items-unknown`, `edl-limits`, `edl-frame-rate`, `lut-resampled`, `sidecar-unused` or `sidecar-unreadable`',
      ),
    subject: z.string().optional().describe('What it is about: a version, a count, a file name or a frame rate'),
    what: z.string().describe('In English, for reference'),
    became: z.string().describe('In English, for reference'),
  })
  .meta({ id: 'StudioEditorImportNotice' });

const TimelineSchema = z
  .object({
    index: z.int().min(0).describe('Name it in `timelines` when importing'),
    name: z.string(),
    durationSeconds: z.number().min(0).meta({ format: 'double' }),
    clips: z.int().min(0).describe('Video clips and stills'),
    transitions: z.int().min(0),
    titles: z.int().min(0),
    sound: z.int().min(0).describe('Sound clips'),
    markers: z.int().min(0),
    notes: z.array(NoteSchema).describe('What will come over differently, media aside'),
  })
  .meta({ id: 'StudioEditorImportTimeline' });

const MediaSchema = z
  .object({
    key: z.string().describe('The file as the project names it; send it back in `media` when importing'),
    name: z.string().describe('The file name alone'),
    kind: z.enum(['video', 'audio', 'image']).nullable().meta({ id: 'StudioEditorImportMediaKind' }),
    clips: z.int().min(1).describe('How many clips use it'),
    match: StudioEditorImportMatchSchema,
    confidence: z.number().min(0).max(1).meta({ format: 'double' }),
    assetId: z.uuid().nullable().describe('The library item found or suggested'),
    assetName: z.string().nullable().describe('That item’s file name'),
    carried: z.boolean().describe('The file came inside the uploaded archive and is added to the library if needed'),
  })
  .meta({ id: 'StudioEditorImportMedia' });

export const StudioEditorImportCheckSchema = z
  .object({
    fileName: z.string(),
    source: StudioEditorImportSourceSchema,
    sourceVersion: z.string().nullable(),
    notices: z.array(NoticeSchema),
    timelines: z.array(TimelineSchema),
    media: z.array(MediaSchema),
  })
  .meta({ id: 'StudioEditorImportCheckDto' });
export type StudioEditorImportCheck = z.infer<typeof StudioEditorImportCheckSchema>;

export const StudioEditorImportBuildSchema = z
  .object({
    projectId: z.uuidv7(),
    name: z.string(),
    source: StudioEditorImportSourceSchema,
    fileName: z.string(),
    timeline: z.int().min(0),
    notes: z.array(NoteSchema).describe('What came over differently or could not come over'),
    notices: z.array(NoticeSchema),
    media: z
      .object({
        found: z.int().min(0).describe('Found in the library without asking'),
        matched: z.int().min(0).describe('Matches the person chose'),
        added: z.int().min(0).describe('Added to the library: sent from a folder or carried in the archive'),
        placeholders: z.int().min(0).describe('Still missing; the clip keeps its place until it is relinked'),
        total: z.int().min(0),
      })
      .meta({ id: 'StudioEditorImportMediaTotals' }),
  })
  .meta({ id: 'StudioEditorImportBuildDto' });
export type StudioEditorImportBuild = z.infer<typeof StudioEditorImportBuildSchema>;

export class StudioEditorImportDto extends createZodDto(
  z
    .object({
      id: z.uuidv7(),
      status: MediaOperationStatusSchema,
      stage: z
        .enum(['check', 'build'])
        .describe('`check`: reading the file and finding media; `build`: making one Studio project')
        .meta({ id: 'StudioEditorImportStage' }),
      step: StudioEditorImportStepSchema,
      progress: z.number().min(0).max(100).meta({ format: 'double' }),
      error: z.string().nullable(),
      check: StudioEditorImportCheckSchema.nullable().describe('Once a `check` job has completed'),
      build: StudioEditorImportBuildSchema.nullable().describe('Once a `build` job has completed'),
    })
    .meta({ id: 'StudioEditorImportDto' }),
) {}

export class StudioEditorImportStartDto extends createZodDto(
  z
    .object({
      timelines: z.array(z.int().min(0)).min(1).max(50).describe('The timelines to bring; each becomes a project'),
      media: z
        .array(
          z.object({
            key: z.string().min(1).max(4096),
            assetId: z.uuid().nullable().describe('The library item to use, or null to leave a placeholder'),
            added: z.boolean().optional().describe('The person sent this file from their folder just now'),
          }),
        )
        .max(5000)
        .describe('The person’s choice for each file; a file left out keeps what the check found'),
      albumName: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe('The album that added files go into, in the person’s language; defaults to the project name'),
    })
    .meta({ id: 'StudioEditorImportStartDto' }),
) {}

export class StudioEditorImportStartedDto extends createZodDto(
  z
    .object({
      jobs: z.array(
        z.object({ id: z.uuidv7(), timeline: z.int().min(0), status: MediaOperationStatusSchema }).meta({
          id: 'StudioEditorImportJob',
        }),
      ),
    })
    .meta({ id: 'StudioEditorImportStartedDto' }),
) {}

export class StudioEditorImportProjectNotesDto extends createZodDto(
  z
    .object({
      source: StudioEditorImportSourceSchema,
      fileName: z.string(),
      notes: z
        .array(NoteSchema)
        .describe('What came over differently or could not come over, with where on the timeline'),
      notices: z.array(NoticeSchema),
    })
    .meta({ id: 'StudioEditorImportProjectNotesDto' }),
) {}
