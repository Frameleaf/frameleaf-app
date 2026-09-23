import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { StudioPreviewQualitySchema, StudioPreviewStatusSchema } from 'src/enum.js';
import { PREVIEW_MAX_VIEWPORT, PREVIEW_MIN_VIEWPORT } from 'src/utils/studio-preview.js';

/**
 * Exact time on the sequence timeline (FL-96, `STU-402`).
 *
 * A rational, never a float. Minimal local shape standing in for FL-93 (`VID-102`), which owns
 * the production rational-time model on another branch: when it lands this schema is replaced
 * by its own, and because every consumer goes through the canonicalising helpers in
 * `src/utils/studio-preview.ts` the swap does not reach a call site.
 *
 * Carried as strings because the values are 64-bit: a tick count at a 1/90000 timebase over a
 * long project is not exactly representable as a JSON number, and "close enough" is exactly the
 * failure this story exists to prevent.
 */
const PreviewTimeSchema = z
  .object({
    numerator: z
      .string()
      .regex(/^-?\d{1,19}$/)
      .describe('Time numerator, in seconds over the denominator'),
    denominator: z
      .string()
      .regex(/^\d{1,19}$/)
      .describe('Time denominator; must not be zero'),
  })
  .meta({ id: 'StudioPreviewTimeDto' });

/**
 * Ask for one frame.
 *
 * Every field is part of the frame's identity. `revisionDigest` in particular is not advisory:
 * a request naming a revision the project has moved past is refused rather than rendered,
 * because the answer would be obsolete before it arrived.
 */
const StudioPreviewRequestSchema = z
  .object({
    projectId: z.string().min(1).max(255).describe('Studio project the frame belongs to'),
    revisionDigest: z
      .string()
      .min(1)
      .max(255)
      .describe('Exact graph revision digest the frame is bound to; a superseded revision is refused'),
    time: PreviewTimeSchema,
    quality: StudioPreviewQualitySchema,
    viewportWidth: z.coerce.number().int().min(PREVIEW_MIN_VIEWPORT).max(PREVIEW_MAX_VIEWPORT),
    viewportHeight: z.coerce.number().int().min(PREVIEW_MIN_VIEWPORT).max(PREVIEW_MAX_VIEWPORT),
    /**
     * The client's monotonic seek counter. Echoed back on the result so a frame answering an
     * older seek is discarded by the client rather than painted over the current one.
     */
    seekGeneration: z.coerce.number().int().min(0).default(0).optional(),
  })
  .meta({ id: 'StudioPreviewRequestDto' });

/**
 * One preview frame, as its owner sees it.
 *
 * Deliberately absent: the path on disk, the render worker's identity and the resource grant.
 * They are how the server keeps the frame honest, not something a browser needs to read.
 *
 * `etag` is present so the client can send `If-None-Match` without having fetched the bytes
 * first. It contains the revision digest, which is why a cached frame cannot revalidate its way
 * into being served after the revision advances.
 */
const StudioPreviewSchema = z
  .object({
    id: z.uuidv7().describe('Preview frame ID'),
    projectId: z.string(),
    revisionDigest: z.string().describe('The exact revision this frame is bound to'),
    time: PreviewTimeSchema,
    quality: StudioPreviewQualitySchema,
    viewportWidth: z.int(),
    viewportHeight: z.int(),
    status: StudioPreviewStatusSchema,
    /** The durable job rendering this frame, when one has been created. */
    operationId: z.uuidv7().nullable(),
    seekGeneration: z.string().describe('The seek this frame answers'),
    etag: z.string().describe('Revision-bound entity tag for the frame endpoint'),
    /** Frame identity: the delivered picture's own PTS in its timebase. */
    framePts: z.string().nullable(),
    framePtsTimebase: z.string().nullable(),
    sizeInBytes: z.string().nullable(),
    contentType: z.string().nullable(),
    /** The frame is an explicitly tone-mapped SDR rendering; never the colour authority. */
    toneMapped: z.boolean(),
    errorCode: z.string().nullable().describe('Stable code the client turns into a message'),
    requestedAt: z.string().meta({ format: 'date-time' }),
    readyAt: z.string().meta({ format: 'date-time' }).nullable(),
    expiresAt: z.string().meta({ format: 'date-time' }).nullable(),
  })
  .meta({ id: 'StudioPreviewDto' });

/**
 * What the server did with a request.
 *
 * `currentRevisionDigest` is always reported, including on a refusal, so a client that fell
 * behind can reconcile in one round trip instead of guessing. `superseded` lists the previews
 * this request cancelled, which is how the client knows which cached frames to drop.
 */
const StudioPreviewResponseSchema = z
  .object({
    preview: StudioPreviewSchema,
    currentRevisionDigest: z.string().describe('The revision the project is on now'),
    supersededPreviewIds: z
      .array(z.uuidv7())
      .describe('Previews cancelled because the revision advanced'),
  })
  .meta({ id: 'StudioPreviewResponseDto' });

export class StudioPreviewRequestDto extends createZodDto(StudioPreviewRequestSchema) {}
export class StudioPreviewDto extends createZodDto(StudioPreviewSchema) {}
export class StudioPreviewResponseDto extends createZodDto(StudioPreviewResponseSchema) {}
export class StudioPreviewTimeDto extends createZodDto(PreviewTimeSchema) {}
