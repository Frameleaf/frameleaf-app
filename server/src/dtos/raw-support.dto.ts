import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * RAW support (FL-420): how the caller's RAW originals are doing, for the Universal RAW page under
 * Library Care. Read-only; the originals are never touched. Repair reuses the existing thumbnail job
 * (`POST /assets/jobs`, `regenerate-thumbnail`).
 */
export enum RawSupportStatus {
  /** A preview rendered from the sensor data exists. */
  Ready = 'ready',
  /** Only the camera's embedded preview is used (embedded previews are on and no full-size render exists). */
  Preview = 'preview',
  /** No preview yet: not processed, or the last attempt failed without a recorded reason. */
  Pending = 'pending',
  /** A check timed out or ran out of memory decoding it. */
  Timeout = 'timeout',
  /** The decoder cannot read this camera or compression mode. */
  Unsupported = 'unsupported',
  /** A check could not read the file. */
  Damaged = 'damaged',
  /** The RAW decoder was missing when the file was checked. */
  Dependency = 'dependency',
}

export const RawSupportStatusSchema = z
  .enum(RawSupportStatus)
  .describe('How a RAW original is doing')
  .meta({ id: 'RawSupportStatus' });

export enum RawSupportSource {
  Sensor = 'sensor',
  Embedded = 'embedded',
  None = 'none',
}

const RawSupportSourceSchema = z
  .enum(RawSupportSource)
  .describe('Where the preview shown for a RAW original comes from')
  .meta({ id: 'RawSupportSource' });

const count = () => z.int().min(0);

const RawSupportCountsSchema = z
  .object({
    ready: count(),
    preview: count(),
    pending: count(),
    timeout: count(),
    unsupported: count(),
    damaged: count(),
    dependency: count(),
  })
  .describe('How many RAW originals are in each state')
  .meta({ id: 'RawSupportCountsDto' });

const RawSupportItemSchema = z
  .object({
    assetId: z.uuidv4(),
    fileName: z.string(),
    extension: z.string().describe('Lowercase file extension without the dot'),
    make: z.string().nullable(),
    model: z.string().nullable(),
    width: z.int().nullable(),
    height: z.int().nullable(),
    status: RawSupportStatusSchema,
    source: RawSupportSourceSchema,
    hasFullsize: z.boolean().describe('A full-resolution render exists'),
    renderedAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When the preview was last written; repair progress compares against it'),
    pairedFileName: z.string().nullable().describe('The other photo stacked with it, such as the camera JPEG'),
  })
  .meta({ id: 'RawSupportItemDto' });

const RawSupportFormatSchema = z
  .object({
    extension: z.string().describe('Lowercase file extension without the dot'),
    count: count(),
    ready: count(),
    attention: count().describe('Unsupported, damaged, timed out or decoder missing'),
    tested: z.array(z.string()).describe('Cameras this server build was qualified with for this format'),
  })
  .meta({ id: 'RawSupportFormatDto' });

const RawSupportEngineSchema = z
  .object({
    available: z.boolean(),
    version: z.string().nullable(),
  })
  .meta({ id: 'RawSupportEngineDto' });

const RawSupportResponseSchema = z
  .object({
    decoder: RawSupportEngineSchema.describe('Viewing: the RAW decoder that renders previews'),
    developer: RawSupportEngineSchema.describe('Full RAW development'),
    embeddedPreviews: z.boolean().describe('Fast previews come from the camera JPEG inside the RAW file'),
    fullResolution: z.boolean().describe('Full-resolution renders are made for RAW originals'),
    colorspace: z.enum(['srgb', 'p3']).describe('Colour profile of rendered previews'),
    total: count().describe('Every RAW original the caller can see, not only the listed ones'),
    counts: RawSupportCountsSchema,
    formats: z.array(RawSupportFormatSchema).describe('One row per RAW extension in the library'),
    items: z.array(RawSupportItemSchema).describe('Files needing attention first, then the newest'),
  })
  .meta({ id: 'RawSupportResponseDto' });

const RawSupportQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(200).describe('How many files to list'),
  })
  .meta({ id: 'RawSupportQueryDto' });

export class RawSupportItemDto extends createZodDto(RawSupportItemSchema) {}
export class RawSupportFormatDto extends createZodDto(RawSupportFormatSchema) {}
export class RawSupportResponseDto extends createZodDto(RawSupportResponseSchema) {}
export class RawSupportQueryDto extends createZodDto(RawSupportQuerySchema) {}
