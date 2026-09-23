import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { StudioPreviewQualitySchema, StudioPreviewStatusSchema } from 'src/enum.js';
import { PREVIEW_MAX_VIEWPORT, PREVIEW_MIN_VIEWPORT } from 'src/utils/studio-preview.js';

/**
 * Exact time on the sequence timeline (FL-93's `Rational`, on the wire).
 *
 * A rational, never a float: a preview must address the same frame the export does, and
 * `1/30000` is already wrong in the 17th digit as a double. Carried as decimal strings so JSON
 * cannot quietly widen them, and validated to the safe-integer range `rational()` requires.
 */
const safeIntegerString = (label: string) =>
  z
    .string()
    .regex(/^-?\d{1,16}$/)
    .refine((value) => Number.isSafeInteger(Number(value)), { message: `${label} must be a safe integer` });

const PreviewTimeSchema = z
  .object({
    numerator: safeIntegerString('numerator').describe('Time numerator, in seconds over the denominator'),
    denominator: safeIntegerString('denominator')
      .refine((value) => Number(value) > 0, { message: 'denominator must be positive' })
      .describe('Time denominator; must be positive'),
  })
  .meta({ id: 'StudioPreviewTimeDto' });

/**
 * Ask for one frame of a stored project revision (FL-89).
 *
 * Every field is part of the frame's identity. The client names the project and the stored
 * revision it is looking at; it never supplies a graph or a digest of its own. The server reads
 * the graph from storage, resolves it for the acting account (FL-90) and binds the frame to that
 * authorized resolution. `revision` is not advisory: a request naming a revision the project has
 * moved past is refused rather than rendered, because the answer would be obsolete before it
 * arrived.
 */
const StudioPreviewRequestSchema = z
  .object({
    projectId: z.uuidv7().describe('Studio project the frame belongs to'),
    revision: z
      .int()
      .min(1)
      .describe('Stored project revision the frame is bound to; a superseded revision is refused'),
    time: PreviewTimeSchema,
    quality: StudioPreviewQualitySchema,
    viewportWidth: z.coerce.number().int().min(PREVIEW_MIN_VIEWPORT).max(PREVIEW_MAX_VIEWPORT),
    viewportHeight: z.coerce.number().int().min(PREVIEW_MIN_VIEWPORT).max(PREVIEW_MAX_VIEWPORT),
    /**
     * The client's monotonic seek counter. Echoed back on the result so a frame answering an
     * older seek is discarded by the client rather than painted over the current one.
     */
    seekGeneration: z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .optional()
      .describe("The client's monotonic seek counter, echoed back on the result"),
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
    revision: z.int().min(0).describe('The stored project revision this frame was rendered for'),
    revisionDigest: z
      .string()
      .describe(
        'Digest of the authorized resolution the frame is bound to; changes with the revision and whenever access is re-resolved',
      ),
    time: PreviewTimeSchema,
    quality: StudioPreviewQualitySchema,
    viewportWidth: z.int(),
    viewportHeight: z.int(),
    status: StudioPreviewStatusSchema,
    operationId: z.uuidv7().nullable().describe('The durable job rendering this frame, when one has been created'),
    seekGeneration: z.string().describe('The seek this frame answers'),
    etag: z.string().describe('Revision-bound entity tag for the frame endpoint'),
    /** Frame identity: the delivered picture's own PTS in its timebase. */
    framePts: z.string().nullable(),
    framePtsTimebase: z.string().nullable(),
    sizeInBytes: z.string().nullable(),
    contentType: z.string().nullable(),
    toneMapped: z
      .boolean()
      .describe('The frame is an explicitly tone-mapped SDR rendering; never the colour authority'),
    errorCode: z.string().nullable().describe('Stable code the client turns into a message'),
    requestedAt: z.string().meta({ format: 'date-time' }),
    readyAt: z.string().meta({ format: 'date-time' }).nullable(),
    expiresAt: z.string().meta({ format: 'date-time' }).nullable(),
  })
  .meta({ id: 'StudioPreviewDto' });

/**
 * What the server did with a request.
 *
 * `currentRevision` is always reported, including on a refusal, so a client that fell behind
 * can reconcile in one round trip instead of guessing. `superseded` lists the previews
 * this request cancelled, which is how the client knows which cached frames to drop.
 */
const StudioPreviewResponseSchema = z
  .object({
    preview: StudioPreviewSchema,
    currentRevision: z.int().min(0).describe('The stored revision the project is on now'),
    supersededPreviewIds: z.array(z.uuidv7()).describe('Previews cancelled because the revision advanced'),
  })
  .meta({ id: 'StudioPreviewResponseDto' });

export class StudioPreviewRequestDto extends createZodDto(StudioPreviewRequestSchema) {}
export class StudioPreviewDto extends createZodDto(StudioPreviewSchema) {}
export class StudioPreviewResponseDto extends createZodDto(StudioPreviewResponseSchema) {}
export class StudioPreviewTimeDto extends createZodDto(PreviewTimeSchema) {}
