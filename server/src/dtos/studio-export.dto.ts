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
  STUDIO_EXPORT_SUBTITLE_MODES,
} from 'src/utils/studio-export.js';
import { REFRAME_MAX_POINTS, STUDIO_EXPORT_SHAPES } from 'src/utils/studio-reframe.js';

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

const StudioExportSubtitleModeSchema = z
  .enum(STUDIO_EXPORT_SUBTITLE_MODES)
  .describe(
    'Burn captions, omit captions, publish a private SRT sibling, or embed a qualified MP4 text track; ordinary titles are preserved',
  )
  .meta({ id: 'StudioExportSubtitleMode' });

const StudioExportRangeSchema = z
  .object({
    inPoint: z.int().min(0).describe('First included frame on the main timeline'),
    outPoint: z.int().min(1).describe('First excluded frame on the main timeline'),
  })
  .strict()
  .refine((range) => range.outPoint > range.inPoint, { message: 'The end frame must follow the start frame' })
  .meta({ id: 'StudioExportRangeDto' });

const StudioExportShapeSchema = z
  .enum(['original', 'vertical', 'square'])
  .describe('Shape of the picture: the project’s own, vertical 9:16 or square 1:1')
  .meta({ id: 'StudioExportShape' });

const StudioExportRequestShapeSchema = z
  .enum(STUDIO_EXPORT_SHAPES)
  .describe('Delivery shape, including landscape 16:9')
  .meta({ id: 'StudioExportRequestShape' });

export const StudioReframePointSchema = z
  .object({
    t: z.number().min(0).max(1).meta({ format: 'double' }).describe('Progress through the shot, 0 to 1'),
    x: z
      .number()
      .min(0)
      .max(1)
      .meta({ format: 'double' })
      .describe('Centre of the crop (or of the subject) as a share of the project frame width, 0 left to 1 right'),
  })
  .strict()
  .meta({ id: 'StudioReframePointDto' });

const StudioExportFramingSchema = z
  .object({
    clipId: z.string().min(1).max(128).describe('A video or still on the main timeline'),
    path: z
      .array(StudioReframePointSchema)
      .min(1)
      .max(REFRAME_MAX_POINTS)
      .describe('Where the crop centre is through the shot, in order of progress'),
  })
  .strict()
  .meta({ id: 'StudioExportFramingDto' });

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
    subtitleMode: StudioExportSubtitleModeSchema.optional().describe('Defaults to `burn`'),
    range: StudioExportRangeSchema.optional().describe('Absent renders the whole main timeline'),
    audio: StudioExportAudioSchema.optional().describe(
      'Defaults to `preserve`; a stereo downmix happens only when asked for',
    ),
    mastering: StudioExportMasteringSchema.optional().describe(
      'Explicit mastering display used for PQ output; required for HDR10 or preserved PQ. Never inferred from source metadata or preview defaults',
    ),
    requestKey: IdentifierSchema.optional().describe(
      'Idempotency key; a repeated submit answers with the first export',
    ),
    // FL-563
    shape: StudioExportRequestShapeSchema.optional().describe(
      'Defaults to `original`. Landscape, vertical and square exports are SDR video at 720p to 2160p; the project is not changed',
    ),
    framing: z
      .array(StudioExportFramingSchema)
      .max(2000)
      .optional()
      .describe(
        'For a landscape, vertical or square export: the crop path of each shot as shown in the export dialog (`GET /studio/projects/{id}/framing` and your moves). A shot left out is centred on its picture; a clip no longer in the version is ignored',
      ),
    // FL-162
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
        'Smooth motion of the exported video as its own job after it is published. The export itself always renders at home; a Frameleaf Cloud job is confirmed and billed on its own.',
      )
      .meta({ id: 'StudioExportSmoothMotionDto' }),
  })
  .strict()
  .meta({ id: 'StudioExportCreateDto' });

const StudioDeliveryShapeSchema = z.enum(['landscape', 'vertical', 'square']).meta({ id: 'StudioDeliveryShape' });

const StudioExportBatchVariantSchema = StudioExportCreateSchema.omit({
  expectedRevision: true,
  destination: true,
  cloudConsent: true,
  requestKey: true,
  smoothMotion: true,
})
  .extend({ shape: StudioDeliveryShapeSchema })
  .meta({ id: 'StudioExportBatchVariantDto' });

const StudioExportBatchCreateSchema = z
  .object({
    expectedRevision: z.int().min(1),
    requestKey: IdentifierSchema,
    destination: z.enum(['local', 'lan']).meta({ id: 'StudioDeliveryDestination' }),
    variants: z
      .array(StudioExportBatchVariantSchema)
      .min(1)
      .max(3)
      .refine(
        (variants) => new Set(variants.map((variant) => variant.shape)).size === variants.length,
        'Each delivery shape may be queued only once',
      ),
  })
  .strict()
  .meta({ id: 'StudioExportBatchCreateDto' });

const StudioExportSettingsSchema = z
  .object({
    format: StudioExportFormatSchema,
    color: StudioExportColorSchema,
    resolution: StudioExportResolutionSchema,
    quality: StudioExportQualitySchema.optional().describe('Absent on exports made before quality was a choice'),
    subtitleMode: StudioExportSubtitleModeSchema.optional().describe('Absent uses the native `burn` default'),
    range: StudioExportRangeSchema.optional().describe('Absent renders the whole main timeline'),
    audio: StudioExportAudioSchema.optional().describe('Absent on exports made before audio was a choice'),
    mastering: StudioExportMasteringSchema.optional().describe(
      'Declared PQ mastering display, fixed when this export was submitted',
    ),
    shape: StudioExportShapeSchema.optional().describe(
      'Legacy shape values; newer shapes are reported in deliveryShape',
    ),
    deliveryShape: z
      .string()
      .optional()
      .describe('Actual delivery shape, including future values; fall back to shape when absent'),
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
    subtitle: z
      .object({
        codec: z.literal('srt'),
        required: z.literal(true),
        cueCount: z.int().nonnegative(),
        sizeInBytes: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        available: z.boolean(),
      })
      .nullable()
      .optional()
      .describe('Owner-private sibling. Never contains text, server paths or a public grant'),
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

const StudioExportBatchCreateResponseSchema = z
  .object({
    revision: z.int().min(1),
    items: z.array(
      z
        .object({
          shape: StudioDeliveryShapeSchema,
          result: StudioExportCreateResponseSchema.nullable(),
          errorCode: z.string().nullable(),
          error: z.string().nullable(),
        })
        .meta({ id: 'StudioExportBatchItemDto' }),
    ),
  })
  .meta({ id: 'StudioExportBatchCreateResponseDto' });

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

export class StudioExportBatchCreateDto extends createZodDto(StudioExportBatchCreateSchema) {}
export class StudioExportBatchCreateResponseDto extends createZodDto(StudioExportBatchCreateResponseSchema) {}
