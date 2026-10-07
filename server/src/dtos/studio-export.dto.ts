import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MediaOperationSchema } from 'src/dtos/media-operation.dto.js';
import { MediaOperationDestinationSchema, StudioExportScopeSchema, StudioExportVersionStateSchema } from 'src/enum.js';
import { STUDIO_EXPORT_AUDIO, StudioExportMasteringSchema } from 'src/utils/studio-export-contract.js';
import {
  STUDIO_EXPORT_COLORS,
  STUDIO_EXPORT_FORMATS,
  STUDIO_EXPORT_QUALITIES,
  STUDIO_EXPORT_RESOLUTIONS,
} from 'src/utils/studio-export.js';

/**
 * Studio exports and the versions they publish (FL-106, `STU-404`).
 *
 * No server path ever appears here. A `library` result is an asset and is reached like any other; a
 * `project` result, which used media shared with you, is reached only through its owner-scoped
 * download route, which checks every source is still yours to see on every request.
 */

const IdentifierSchema = z
  .string()
  .regex(/^[\w.:-]{1,128}$/)
  .describe('Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters');

const StudioExportFormatSchema = z
  .enum(STUDIO_EXPORT_FORMATS)
  .describe('Container and codec')
  .meta({ id: 'StudioExportFormat' });

const StudioExportColorSchema = z
  .enum(STUDIO_EXPORT_COLORS)
  .describe('Colour handling; Dolby Vision needs a qualified worker')
  .meta({ id: 'StudioExportColor' });

const StudioExportAudioSchema = z
  .enum(STUDIO_EXPORT_AUDIO)
  .describe(
    'Audio of the result: `preserve` keeps the widest source channel layout at its sample rate; `stereo` is an explicit downmix',
  )
  .meta({ id: 'StudioExportAudio' });

const StudioExportQualitySchema = z
  .enum(STUDIO_EXPORT_QUALITIES)
  .describe('Encoder quality preset')
  .meta({ id: 'StudioExportQuality' });

export const StudioExportResolutionSchema = z
  .enum(STUDIO_EXPORT_RESOLUTIONS)
  .describe('Output resolution')
  .meta({ id: 'StudioExportResolution' });

const StudioExportCreateSchema = z
  .object({
    expectedRevision: z
      .int()
      .min(1)
      .optional()
      .describe('The revision you are looking at; a newer head refuses the export with `409` instead of rendering it'),
    destination: MediaOperationDestinationSchema.describe('Where it renders. A cloud destination needs `cloudConsent`'),
    cloudConsent: z.boolean().optional().describe('You agree to the media leaving your network for this export'),
    format: StudioExportFormatSchema,
    color: StudioExportColorSchema,
    resolution: StudioExportResolutionSchema,
    quality: StudioExportQualitySchema.optional().describe('Defaults to `high`'),
    audio: StudioExportAudioSchema.optional().describe(
      'Defaults to `preserve`; a stereo downmix happens only when asked for',
    ),
    mastering: StudioExportMasteringSchema.optional().describe(
      'Explicit mastering display used for PQ output; required for HDR10 or preserved PQ. Never inferred from source metadata or preview defaults',
    ),
    requestKey: IdentifierSchema.optional().describe(
      'Idempotency key; a repeated submit answers with the first export',
    ),
    smoothMotion: z
      .object({
        factor: z
          .union([
            z.literal(2).meta({ format: 'double' }),
            z.literal(4).meta({ format: 'double' }),
            z.literal(8).meta({ format: 'double' }),
          ])
          .describe('How many frames each frame becomes'),
        destinationId: z.uuidv4().describe('Where the Smooth motion job runs; Frameleaf Cloud is confirmed separately'),
      })
      .optional()
      .describe(
        'FL-162: Smooth motion of the exported video as its own job after it is published. The export itself always renders at home; a Frameleaf Cloud job is confirmed and billed on its own.',
      )
      .meta({ id: 'StudioExportSmoothMotionDto' }),
  })
  .meta({ id: 'StudioExportCreateDto' });

const StudioExportSettingsSchema = z
  .object({
    format: StudioExportFormatSchema,
    color: StudioExportColorSchema,
    resolution: StudioExportResolutionSchema,
    quality: StudioExportQualitySchema.optional().describe('Absent on exports made before quality was a choice'),
    audio: StudioExportAudioSchema.optional().describe('Absent on exports made before audio was a choice'),
    mastering: StudioExportMasteringSchema.optional().describe(
      'Declared PQ mastering display, fixed when this export was submitted',
    ),
  })
  .meta({ id: 'StudioExportSettingsDto' });

const StudioExportVersionSchema = z
  .object({
    id: z.uuidv7().describe('Export version ID'),
    projectId: z.uuidv7().nullable().describe('Null once the project was deleted for good'),
    revision: z.int().min(1).describe('The project revision that was rendered'),
    state: StudioExportVersionStateSchema,
    version: z.int().min(1).nullable().describe('The version number, once published'),
    scope: StudioExportScopeSchema.nullable().describe('Where the published result lives'),
    destination: MediaOperationDestinationSchema,
    settings: StudioExportSettingsSchema,
    renderOperationId: z.uuidv7().nullable(),
    publishOperationId: z.uuidv7().nullable(),
    resultAssetId: z.uuidv4().nullable().describe('The asset a `library` result became'),
    locked: z.boolean().describe('The result inherited a lock from a Locked or sensitive source'),
    sensitive: z.boolean().describe('The result inherited sensitive evidence from a source'),
    includesSharedSources: z.boolean().describe('At least one source is shared with you rather than yours'),
    sourceCount: z.int().min(0).describe('Library sources the result was made from'),
    sizeInBytes: z.string().nullable(),
    contentType: z.string().nullable(),
    errorCode: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: z.string().meta({ format: 'date-time' }),
    publishedAt: z.string().meta({ format: 'date-time' }).nullable(),
    cancelledAt: z.string().meta({ format: 'date-time' }).nullable(),
  })
  .meta({ id: 'StudioExportVersionDto' });

const StudioExportCreateResponseSchema = z
  .object({
    version: StudioExportVersionSchema,
    operation: MediaOperationSchema.describe('The render job; follow it in Activity'),
  })
  .meta({ id: 'StudioExportCreateResponseDto' });

const StudioExportListResponseSchema = z
  .object({
    items: z.array(StudioExportVersionSchema),
    total: z.int().describe('Matching versions, before paging'),
  })
  .meta({ id: 'StudioExportListResponseDto' });

const StudioExportSearchSchema = z
  .object({
    take: z.coerce.number().int().min(1).max(200).default(50).optional(),
    skip: z.coerce.number().int().min(0).default(0).optional(),
  })
  .meta({ id: 'StudioExportSearchDto' });

export class StudioExportCreateDto extends createZodDto(StudioExportCreateSchema) {}
export class StudioExportSettingsDto extends createZodDto(StudioExportSettingsSchema) {}
export class StudioExportVersionDto extends createZodDto(StudioExportVersionSchema) {}
export class StudioExportCreateResponseDto extends createZodDto(StudioExportCreateResponseSchema) {}
export class StudioExportListResponseDto extends createZodDto(StudioExportListResponseSchema) {}
export class StudioExportSearchDto extends createZodDto(StudioExportSearchSchema) {}
