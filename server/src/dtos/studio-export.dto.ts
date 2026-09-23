import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MediaOperationSchema } from 'src/dtos/media-operation.dto.js';
import { MediaOperationDestinationSchema, StudioExportScopeSchema, StudioExportVersionStateSchema } from 'src/enum.js';
import { STUDIO_EXPORT_COLORS, STUDIO_EXPORT_FORMATS, STUDIO_EXPORT_RESOLUTIONS } from 'src/utils/studio-export.js';

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

const StudioExportResolutionSchema = z
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
    requestKey: IdentifierSchema.optional().describe(
      'Idempotency key; a repeated submit answers with the first export',
    ),
  })
  .meta({ id: 'StudioExportCreateDto' });

const StudioExportSettingsSchema = z
  .object({
    format: StudioExportFormatSchema,
    color: StudioExportColorSchema,
    resolution: StudioExportResolutionSchema,
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
