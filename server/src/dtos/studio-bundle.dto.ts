import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MediaOperationKindSchema, MediaOperationStatusSchema } from 'src/enum.js';

/**
 * Portable Studio project bundles (FL-91, `STU-204`).
 *
 * A bundle is written and read by durable media operations, so these DTOs describe a request to
 * start one and what a finished one produced. No server-side path ever appears here: the file of a
 * finished export is reached only through its owner-scoped download route, and an uploaded bundle
 * only through its id.
 */

const IdentifierSchema = z
  .string()
  .regex(/^[\w.:-]{1,128}$/)
  .describe('Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters');

const StudioBundleExportCreateSchema = z
  .object({
    includeMedia: z
      .boolean()
      .optional()
      .describe(
        'Copy the media you own into the bundle. Shared media always travels as a reference, and nothing Locked is ever copied.',
      ),
    requestKey: IdentifierSchema.optional().describe('Idempotency key; a repeated submit answers with the first job'),
  })
  .meta({ id: 'StudioBundleExportCreateDto' });

const StudioBundleUploadCreateSchema = z
  .object({
    file: z.file().describe('A `.frameleaf-studio.zip` bundle'),
  })
  .meta({ id: 'StudioBundleUploadCreateDto' });

const StudioBundleSourceModeSchema = z
  .enum(['embedded', 'reference'])
  .describe('`embedded` carries a verified copy; `reference` names media on the exporting server')
  .meta({ id: 'StudioBundleSourceMode' });

const StudioBundleSourceResolutionSchema = z
  .enum(['kept', 'suggested', 'missing'])
  .describe(
    '`kept`: the original is already available to you; `suggested`: an item of yours has the same content; `missing`: choose one or import without it',
  )
  .meta({ id: 'StudioBundleSourceResolution' });

const StudioBundleSourceSchema = z
  .object({
    key: z.string().describe('Mapping key for the import request'),
    kind: z.string().describe('`library-asset` or `edited-master`'),
    id: z.string().describe('Identifier on the exporting server'),
    mode: StudioBundleSourceModeSchema,
    fileName: z.string().nullable(),
    contentType: z.string().nullable(),
    sizeBytes: z.string().nullable().describe('Size of the source file, when the exporting server knew it'),
    resolution: StudioBundleSourceResolutionSchema,
    suggestedAssetId: z.uuidv4().nullable().describe('An asset of yours with the same content'),
  })
  .meta({ id: 'StudioBundleSourceDto' });

const StudioBundleUploadSchema = z
  .object({
    id: z.uuidv7().describe('Upload ID, used to start an import'),
    fileName: z.string().describe('The file name as uploaded'),
    sizeBytes: z.string(),
    digest: z.string().describe('SHA-256 of the whole file'),
    expiresAt: z.string().meta({ format: 'date-time' }).describe('When the upload is discarded'),
    consumedAt: z.string().meta({ format: 'date-time' }).nullable().describe('When an import first read it'),
    projectName: z.string(),
    revision: z.int().min(1).describe('The revision the bundle was made from'),
    exportedAt: z.string().meta({ format: 'date-time' }),
    engineRevision: z.string(),
    producerVersion: z.string(),
    sources: z.array(StudioBundleSourceSchema),
  })
  .meta({ id: 'StudioBundleUploadDto' });

const StudioBundleImportCreateSchema = z
  .object({
    uploadId: z.uuidv7(),
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Name of the new project; the bundle name when omitted'),
    mapping: z
      .record(z.string().max(200), z.uuidv4())
      .optional()
      .describe('Source key to an asset of yours to use in its place; every choice is checked for access'),
    requestKey: IdentifierSchema.optional(),
  })
  .meta({ id: 'StudioBundleImportCreateDto' });

const StudioBundleExportResultSchema = z
  .object({
    fileName: z.string(),
    sizeBytes: z.string(),
    digest: z.string().describe('SHA-256 of the finished file'),
    expiresAt: z.string().meta({ format: 'date-time' }),
    downloadable: z.boolean().describe('The file can still be downloaded'),
    embedded: z.int().min(0).describe('Sources copied into the bundle'),
    referenced: z.int().min(0).describe('Sources that travel as references'),
  })
  .meta({ id: 'StudioBundleExportResultDto' });

const StudioBundleMissingSourceSchema = z
  .object({
    key: z.string(),
    kind: z.string(),
    id: z.string(),
    fileName: z.string().nullable(),
    embedded: z.boolean().describe('The bundle carries a verified copy that can be added to the library later'),
  })
  .meta({ id: 'StudioBundleMissingSourceDto' });

const StudioBundleImportResultSchema = z
  .object({
    projectId: z.uuidv7().nullable().describe('The project the import created'),
    relinked: z.int().min(0),
    kept: z.int().min(0),
    embeddedVerified: z.int().min(0),
    missing: z.array(StudioBundleMissingSourceSchema),
  })
  .meta({ id: 'StudioBundleImportResultDto' });

const StudioBundleOperationSchema = z
  .object({
    operationId: z.uuidv7(),
    kind: MediaOperationKindSchema,
    status: MediaOperationStatusSchema,
    progress: z.number().meta({ format: 'double' }),
    attempt: z.int(),
    maxAttempts: z.int(),
    autoRetries: z
      .int()
      .describe('Automatic retries this job has used; every job gets one before a failure is reported'),
    retryAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When a job waiting for its automatic retry may run again'),
    error: z.string().nullable(),
    errorCode: z.string().nullable(),
    projectId: z.string().nullable().describe('The exported project, or the project an import created'),
    export: StudioBundleExportResultSchema.nullable(),
    import: StudioBundleImportResultSchema.nullable(),
  })
  .meta({ id: 'StudioBundleOperationDto' });

export class StudioBundleExportCreateDto extends createZodDto(StudioBundleExportCreateSchema) {}
export class StudioBundleUploadCreateDto extends createZodDto(StudioBundleUploadCreateSchema) {}
export class StudioBundleSourceDto extends createZodDto(StudioBundleSourceSchema) {}
export class StudioBundleUploadDto extends createZodDto(StudioBundleUploadSchema) {}
export class StudioBundleImportCreateDto extends createZodDto(StudioBundleImportCreateSchema) {}
export class StudioBundleExportResultDto extends createZodDto(StudioBundleExportResultSchema) {}
export class StudioBundleMissingSourceDto extends createZodDto(StudioBundleMissingSourceSchema) {}
export class StudioBundleImportResultDto extends createZodDto(StudioBundleImportResultSchema) {}
export class StudioBundleOperationDto extends createZodDto(StudioBundleOperationSchema) {}
