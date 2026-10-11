import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { ApiCustomExtension } from 'src/enum.js';
import { RetainedProcessingProvenanceSchema } from 'src/utils/studio-import-provenance.js';

/**
 * Files uploaded into a Studio project rather than the library (FL-103, FL-105): microphone
 * recordings, sound and music files, stills, short video, SVG and Lottie graphics, caption files
 * (.srt, .vtt) and .cube LUTs. The server
 * records the owner, the type it read from the bytes, the SHA-256 and the size; no server path ever
 * appears here. A clip names the import by `importId` and the editor reads it through the file
 * route.
 */

const StudioProjectImportCreateSchema = z
  .object({
    id: z.uuid().describe('The media id the editor gave this file; retrying the same file with it is idempotent'),
    publicationId: z.uuid().optional().describe('Already registered publication id; required with provenance'),
    processingProvenance: z
      .string()
      .max(4096)
      .optional()
      .describe('Processing provenance JSON, encoded exactly once; outputSha256 is server-only'),
    // File parts never reach the request body; this documents the field and the controller checks it.
    file: z
      .any()
      .optional()
      .describe('The file to import')
      .meta({ type: 'string', format: 'binary', [ApiCustomExtension.Required]: true }),
  })
  .meta({ id: 'StudioProjectImportCreateDto' });

export class StudioProjectImportCreateDto extends createZodDto(StudioProjectImportCreateSchema) {}

export const StudioProjectImportSchema = z
  .object({
    id: z.uuid().describe('Import id; clips reference it as `importId`'),
    kind: z
      .enum(['audio', 'image', 'video', 'vector', 'captions', 'lut'])
      .describe('What the file is, read from its bytes')
      .meta({ id: 'StudioProjectImportKind' }),
    contentType: z.string().describe('Content type read from the bytes, not the name'),
    fileName: z.string().describe('The name the file was uploaded with'),
    sizeBytes: z.int().min(1).describe('Size in bytes'),
    checksum: z.string().describe('SHA-256 of the bytes, hex'),
    externalReferences: z
      .int()
      .min(0)
      .nullable()
      .describe('External subresources an SVG or Lottie graphic names; a graphic with any cannot be rendered'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When it was uploaded'),
    processingProvenance: RetainedProcessingProvenanceSchema.meta({ id: 'RetainedProcessingProvenance' }).optional(),
  })
  .meta({ id: 'StudioProjectImportDto' });

export class StudioProjectImportDto extends createZodDto(StudioProjectImportSchema) {}

const StudioProjectImportParamSchema = z.object({
  id: z.uuidv7().describe('Project id'),
  importId: z.uuid().describe('Import id'),
});

export class StudioProjectImportParamDto extends createZodDto(StudioProjectImportParamSchema) {}

const StudioImportPublicationRegisterSchema = z
  .strictObject({ publicationId: z.uuid(), importId: z.uuid() })
  .meta({ id: 'StudioImportPublicationRegisterDto' });
export class StudioImportPublicationRegisterDto extends createZodDto(StudioImportPublicationRegisterSchema) {}

const StudioImportPublicationParamSchema = z.strictObject({ id: z.uuidv7(), publicationId: z.uuid() });
export class StudioImportPublicationParamDto extends createZodDto(StudioImportPublicationParamSchema) {}
export class StudioImportPublicationCancelParamDto extends createZodDto(
  StudioImportPublicationParamSchema.extend({ importId: z.uuid() }),
) {}

const PublicationStateSchema = z
  .enum(['registered', 'preparing', 'published', 'aborted'])
  .meta({ id: 'StudioImportPublicationState' });
const OpaqueCursorSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+$/);
const StudioImportPublicationQuerySchema = z.strictObject({
  state: PublicationStateSchema.optional(),
  cursor: OpaqueCursorSchema.optional(),
});
export class StudioImportPublicationQueryDto extends createZodDto(StudioImportPublicationQuerySchema) {}

const StudioImportPublicationSchema = z
  .strictObject({
    publicationId: z.uuid(),
    importId: z.uuid(),
    state: PublicationStateSchema,
    createdAt: z.string().meta({ format: 'date-time' }),
    expiresAt: z.string().meta({ format: 'date-time' }),
    cleanupPending: z.boolean(),
    imported: StudioProjectImportSchema.optional(),
  })
  .meta({ id: 'StudioImportPublicationDto' });
export class StudioImportPublicationDto extends createZodDto(StudioImportPublicationSchema) {}
export class StudioImportPublicationPageDto extends createZodDto(
  z
    .strictObject({ items: z.array(StudioImportPublicationSchema).max(100), nextCursor: OpaqueCursorSchema.nullable() })
    .meta({ id: 'StudioImportPublicationPageDto' }),
) {}
export class StudioImportPublicationCancelDto extends createZodDto(
  z
    .strictObject({ status: z.enum(['cancelled', 'already-published']), receipt: StudioImportPublicationSchema })
    .meta({ id: 'StudioImportPublicationCancelDto' }),
) {}
