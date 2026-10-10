import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { PreviewTimeSchema } from 'src/dtos/studio-preview.dto.js';
import { StudioPreviewQualitySchema } from 'src/enum.js';
import { STREAM_CLOSE_REASONS, STREAM_MAX_SDP_BYTES } from 'src/utils/studio-preview-stream.js';
import { PREVIEW_MAX_VIEWPORT, PREVIEW_MIN_VIEWPORT } from 'src/utils/studio-preview.js';

/**
 * Bounded WebRTC playback of a stored Studio revision (FL-96). See `studio-preview-stream.ts` for
 * the signalling rules. Session descriptions are carried whole (non-trickle ICE).
 */

const SdpSchema = z.string().min(1).max(STREAM_MAX_SDP_BYTES).describe('A complete session description (SDP)');

const StreamStateSchema = z
  .enum(['queued', 'negotiating', 'offered', 'answered', 'closed'])
  .describe('Where the session is')
  .meta({ id: 'StudioPreviewStreamState' });

const StreamCloseReasonSchema = z
  .enum(STREAM_CLOSE_REASONS)
  .describe('Why a closed session closed')
  .meta({ id: 'StudioPreviewStreamCloseReason' });

const StreamBoundsSchema = z
  .object({
    maxBitrateKbps: z.int().describe('Bitrate the worker may not exceed; the server writes it into the relayed answer'),
    maxWidth: z.int(),
    maxHeight: z.int(),
    maxFrameRate: z.int(),
    maxDurationSeconds: z.int().describe('The session closes after this long; playing on opens a new one'),
  })
  .meta({ id: 'StudioPreviewStreamBoundsDto' });

/** Open a playback session of the project's current stored revision, starting at `time`. */
const StudioPreviewStreamOpenSchema = z
  .object({
    projectId: z.uuidv7().describe('Studio project to play'),
    revision: z.int().min(1).describe('Stored project revision to play; a superseded revision is refused'),
    time: PreviewTimeSchema,
    quality: StudioPreviewQualitySchema,
    viewportWidth: z.coerce.number().int().min(PREVIEW_MIN_VIEWPORT).max(PREVIEW_MAX_VIEWPORT),
    viewportHeight: z.coerce.number().int().min(PREVIEW_MIN_VIEWPORT).max(PREVIEW_MAX_VIEWPORT),
  })
  .meta({ id: 'StudioPreviewStreamOpenDto' });

/**
 * One playback session, as the browser that opened it sees it. Polling it is the keepalive, and
 * each poll re-checks project access and the stored head.
 */
const StudioPreviewStreamSchema = z
  .object({
    id: z.uuidv7().describe('Stream session ID'),
    projectId: z.string(),
    revision: z.int().min(1).describe('The stored project revision this session plays'),
    state: StreamStateSchema,
    closeReason: StreamCloseReasonSchema.nullable(),
    currentRevision: z.int().min(0).nullable().describe('The stored head, when the session closed as stale'),
    negotiation: z.int().min(0).describe('The offer/answer round; an answer must name it'),
    offer: SdpSchema.nullable().describe("The worker's offer for this round, while it waits for an answer"),
    start: PreviewTimeSchema.describe('Where playback starts'),
    bounds: StreamBoundsSchema,
    keepaliveMs: z.int().describe('Poll at least this often, or the session is closed'),
    expiresAt: z.string().meta({ format: 'date-time' }).describe('The hard end of this session'),
  })
  .meta({ id: 'StudioPreviewStreamDto' });

const StudioPreviewStreamAnswerSchema = z
  .object({
    negotiation: z.int().min(0).describe('The round this answer answers'),
    sdp: SdpSchema,
  })
  .meta({ id: 'StudioPreviewStreamAnswerDto' });

/* Worker side ------------------------------------------------------------------------------------ */

const ClaimTokenSchema = z.uuid().describe('The claim token this operation was handed out with');

const RenderWorkerStreamSignalRequestSchema = z
  .object({ claimToken: ClaimTokenSchema })
  .meta({ id: 'RenderWorkerStreamSignalRequestDto' });

/**
 * What the worker holding a session must do now. `close` means stop sending and acknowledge the
 * cancel; while it is false the worker polls this at least every two seconds.
 */
const RenderWorkerStreamSignalSchema = z
  .object({
    close: z.boolean(),
    closeReason: StreamCloseReasonSchema.nullable(),
    revision: z.int().min(1),
    negotiation: z.int().min(0).describe('The round to offer on'),
    offerNeeded: z.boolean().describe('No offer from this claim for this round yet: create one (with an ICE restart)'),
    answer: SdpSchema.nullable().describe("The browser's answer, with the server's bitrate bound written in"),
    start: PreviewTimeSchema,
    bounds: StreamBoundsSchema,
  })
  .meta({ id: 'RenderWorkerStreamSignalDto' });

const RenderWorkerStreamOfferSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    negotiation: z.int().min(0),
    sdp: SdpSchema,
  })
  .meta({ id: 'RenderWorkerStreamOfferDto' });

export class StudioPreviewStreamOpenDto extends createZodDto(StudioPreviewStreamOpenSchema) {}
export class StudioPreviewStreamDto extends createZodDto(StudioPreviewStreamSchema) {}
export class StudioPreviewStreamAnswerDto extends createZodDto(StudioPreviewStreamAnswerSchema) {}
export class RenderWorkerStreamSignalRequestDto extends createZodDto(RenderWorkerStreamSignalRequestSchema) {}
export class RenderWorkerStreamSignalDto extends createZodDto(RenderWorkerStreamSignalSchema) {}
export class RenderWorkerStreamOfferDto extends createZodDto(RenderWorkerStreamOfferSchema) {}
