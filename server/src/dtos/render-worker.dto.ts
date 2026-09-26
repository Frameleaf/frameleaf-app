import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MediaOperationCheckpointDto } from 'src/dtos/media-operation.dto.js';
import {
  MediaOperationDestinationSchema,
  MediaOperationKindSchema,
  MediaOperationStatus,
  RenderWorkerAuditEventSchema,
  RenderWorkerRefusalReasonSchema,
  RenderWorkerStatusSchema,
  StudioExportRemoteReasonSchema,
} from 'src/enum.js';

const JsonObjectSchema = z.record(z.string(), z.unknown());

/** Bigint columns cross the wire as decimal strings, the way `MediaOperationDto` already does it. */
const BigIntString = z.string().regex(/^\d+$/, 'must be a non-negative integer string');

/* ------------------------------------------------------------------ */
/* Administrator: identities                                            */
/* ------------------------------------------------------------------ */

/**
 * A worker identity as the administrator sees it.
 *
 * Deliberately absent: the enrolment secret and any session credential. The secret is shown once,
 * on creation, in `RenderWorkerCreateResponseDto`; a session is only ever shown to the worker it
 * was issued to.
 */
const RenderWorkerSchema = z
  .object({
    id: z.uuidv7().describe('Render worker ID'),
    name: z.string().describe('What the administrator calls this worker'),
    destination: MediaOperationDestinationSchema,
    status: RenderWorkerStatusSchema,
    kinds: z.array(MediaOperationKindSchema).describe('Operation kinds this worker may claim'),
    engineDigest: z.string().nullable().describe('Engine and patch digest the worker must keep reporting'),
    conformanceMaxAgeMs: z.int().describe('Oldest conformance evidence admission accepts, in milliseconds'),
    maxConcurrentOperations: z.int().describe('Operations this worker may hold at once'),
    maxWallClockMs: z.string().nullable().describe('Longest one operation may run here, in milliseconds'),
    maxOutputBytes: z.string().nullable().describe('Most output bytes one operation may produce here'),
    gpuMemoryBytes: z.string().nullable().describe('GPU memory the worker was qualified with, in bytes'),
    activeOperations: z.int().describe('Operations the worker currently holds'),
    lastAdmittedAt: z.string().meta({ format: 'date-time' }).nullable(),
    lastSeenAt: z.string().meta({ format: 'date-time' }).nullable(),
    revokedAt: z.string().meta({ format: 'date-time' }).nullable(),
    createdAt: z.string().meta({ format: 'date-time' }),
    updatedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'RenderWorkerDto' });

const RenderWorkerLimitFieldsSchema = {
  maxConcurrentOperations: z.int().min(1).max(64).optional(),
  maxWallClockMs: BigIntString.nullable().optional(),
  maxOutputBytes: BigIntString.nullable().optional(),
};

const RenderWorkerCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    destination: MediaOperationDestinationSchema,
    kinds: z.array(MediaOperationKindSchema).min(1).describe('Operation kinds this worker may claim'),
    engineDigest: z.string().trim().min(1).max(200).nullable().optional(),
    conformanceMaxAgeMs: z.int().min(60_000).optional(),
    gpuMemoryBytes: BigIntString.nullable().optional(),
    ...RenderWorkerLimitFieldsSchema,
  })
  .meta({ id: 'RenderWorkerCreateDto' });

/** The one time the enrolment secret is visible. It is stored hashed and cannot be recovered. */
const RenderWorkerCreateResponseSchema = z
  .object({
    worker: RenderWorkerSchema,
    enrolmentSecret: z.string().describe('Shown once. Give it to the worker; the server keeps only its hash'),
  })
  .meta({ id: 'RenderWorkerCreateResponseDto' });

const RenderWorkerUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    kinds: z.array(MediaOperationKindSchema).min(1).optional(),
    engineDigest: z.string().trim().min(1).max(200).nullable().optional(),
    conformanceMaxAgeMs: z.int().min(60_000).optional(),
    gpuMemoryBytes: BigIntString.nullable().optional(),
    ...RenderWorkerLimitFieldsSchema,
  })
  .meta({ id: 'RenderWorkerUpdateDto' });

/* ------------------------------------------------------------------ */
/* Administrator: limits and audit                                      */
/* ------------------------------------------------------------------ */

const RenderWorkerLimitSchema = z
  .object({
    subject: z.string().describe('`instance` for the default, otherwise a user ID'),
    userId: z.uuidv4().nullable(),
    maxConcurrentOperations: z.int().describe('Operations one account may have claimed at once'),
    maxWallClockMs: z.string().nullable(),
    maxOutputBytes: z.string().nullable(),
    updatedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'RenderWorkerLimitDto' });

const RenderWorkerLimitsResponseSchema = z
  .object({
    instance: RenderWorkerLimitSchema,
    users: z.array(RenderWorkerLimitSchema),
  })
  .meta({ id: 'RenderWorkerLimitsResponseDto' });

const RenderWorkerLimitUpdateSchema = z
  .object({
    userId: z.uuidv4().nullable().optional().describe('Omit or null for the instance default'),
    maxConcurrentOperations: z.int().min(0).max(64),
    maxWallClockMs: BigIntString.nullable(),
    maxOutputBytes: BigIntString.nullable(),
  })
  .meta({ id: 'RenderWorkerLimitUpdateDto' });

const RenderWorkerAuditSchema = z
  .object({
    id: z.uuidv7(),
    workerId: z.uuidv7().nullable(),
    event: RenderWorkerAuditEventSchema,
    reason: RenderWorkerRefusalReasonSchema.nullable(),
    operationId: z.uuidv7().nullable(),
    actorId: z.uuidv4().nullable().describe('The administrator who acted, when one did'),
    detail: JsonObjectSchema.nullable().describe('Operator detail. Never a secret, never a path'),
    createdAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'RenderWorkerAuditDto' });

const RenderWorkerAuditSearchSchema = z
  .object({
    workerId: z.uuidv7().optional(),
    take: z.coerce.number().int().min(1).max(500).default(100).optional(),
  })
  .meta({ id: 'RenderWorkerAuditSearchDto' });

/* ------------------------------------------------------------------ */
/* Worker: admission                                                    */
/* ------------------------------------------------------------------ */

/**
 * What a worker presents to be admitted. The secret is compared by digest; the rest is the
 * evidence admission binds the session to. Nothing here is stored in the clear.
 */
const RenderWorkerAdmissionSchema = z
  .object({
    workerId: z.uuidv7(),
    enrolmentSecret: z.string().min(16),
    engineDigest: z.string().trim().min(1).max(200).describe('Digest of the engine and patches actually loaded'),
    conformanceReportedAt: z.string().meta({ format: 'date-time' }).describe('When the conformance check ran'),
    softwareRenderer: z.boolean().describe('True when the renderer is a software or fallback device'),
    gpuMemoryBytes: BigIntString.nullable().describe('GPU memory measured by the conformance check'),
    codecs: z.array(z.string().max(60)).max(64).optional().describe('Encoder and decoder names the check verified'),
    colorPrecision: z
      .object({
        maxBitDepth: z.int().min(8).max(16).describe('Highest bit depth the check rendered and verified'),
        hdr10: z.boolean().describe('The check verified HDR10 (PQ, BT.2020) output'),
        dolbyVision: z.boolean().describe('The check verified Dolby Vision output'),
      })
      .optional()
      .describe('Colour precision the conformance check verified; absent means 8-bit SDR only (FL-42)'),
    formats: z
      .array(z.string().max(30))
      .max(32)
      .optional()
      .describe('Containers the check verified writing, such as `mp4`, `webm` or `mov`'),
  })
  .meta({ id: 'RenderWorkerAdmissionDto' });

const RenderWorkerSessionSchema = z
  .object({
    workerId: z.uuidv7(),
    sessionToken: z.string().describe('Present as the x-frameleaf-worker-session header on every worker call'),
    expiresAt: z.string().meta({ format: 'date-time' }),
    scopes: z.array(MediaOperationKindSchema),
    leaseMs: z.int().describe('How long a claim lasts without a heartbeat'),
    heartbeatIntervalMs: z.int().describe('How often the worker should heartbeat a held claim'),
  })
  .meta({ id: 'RenderWorkerSessionDto' });

/* ------------------------------------------------------------------ */
/* Worker: claims                                                       */
/* ------------------------------------------------------------------ */

const RenderWorkerClaimRequestSchema = z
  .object({
    kinds: z.array(MediaOperationKindSchema).min(1).optional().describe('Narrow the claim to these kinds'),
  })
  .meta({ id: 'RenderWorkerClaimRequestDto' });

const RenderWorkerInputGrantSchema = z
  .object({
    inputId: z.string().describe('FL-90 resource key, or `source` for a single-asset workload'),
    kind: z.string().describe('Resource class: library-asset, edited-master, font, lut, …'),
    resourceId: z.string().describe('Asset or resource id. Never a path'),
    checksum: z.string().nullable().describe('Digest the manifest was resolved against, when known'),
    url: z.string().describe('Relative URL, valid for this claim only and only until expiresAt'),
    expiresAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'RenderWorkerInputGrantDto' });

const RenderWorkerClaimLimitsSchema = z
  .object({
    maxWallClockMs: z.string().nullable(),
    maxOutputBytes: z.string().nullable(),
  })
  .meta({ id: 'RenderWorkerClaimLimitsDto' });

/**
 * What a worker is handed when it claims. There is no owner, no label and no asset path here:
 * the worker gets the immutable snapshot, the checkpoints it may resume from and grants for the
 * inputs the authorized manifest allows.
 */
const RenderWorkerClaimSchema = z
  .object({
    operationId: z.uuidv7(),
    kind: MediaOperationKindSchema,
    claimToken: z.uuid().describe('Required on every write to this operation'),
    leaseMs: z.int(),
    projectId: z.string().nullable(),
    revisionId: z.string().nullable(),
    snapshot: JsonObjectSchema,
    settings: JsonObjectSchema,
    attempt: z.int(),
    checkpoints: z.array(MediaOperationCheckpointDto.schema),
    inputs: z.array(RenderWorkerInputGrantSchema),
    limits: RenderWorkerClaimLimitsSchema,
  })
  .meta({ id: 'RenderWorkerClaimDto' });

const ClaimTokenSchema = z.uuid().describe('The claim token this operation was handed out with');

const RenderWorkerHeartbeatSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    outputBytes: BigIntString.optional().describe('Total output bytes produced so far'),
  })
  .meta({ id: 'RenderWorkerHeartbeatDto' });

const RenderWorkerHeartbeatResponseSchema = z
  .object({
    leaseExtended: z.boolean(),
    leaseMs: z.int(),
    cancelRequested: z.boolean().describe('The owner asked to stop; acknowledge with cancel-ack'),
    pauseRequested: z
      .boolean()
      .describe('The owner paused the job and its claim has been handed back; stop without reporting a failure'),
    refusal: RenderWorkerRefusalReasonSchema.nullable().describe('Set when a limit stopped the operation'),
  })
  .meta({ id: 'RenderWorkerHeartbeatResponseDto' });

const RenderWorkerProgressSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    status: z.enum([MediaOperationStatus.Preparing, MediaOperationStatus.Rendering]),
    processedUnits: z.int().min(0),
    totalUnits: z.int().min(0).nullable(),
    outputBytes: BigIntString.optional(),
  })
  .meta({ id: 'RenderWorkerProgressDto' });

const RenderWorkerCheckpointPlanSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    sequence: z.int().min(0),
    chunkKey: z.string().min(1),
    inputDigest: z.string().min(1),
    historyDigest: z.string().min(1),
    configDigest: z.string().min(1),
    seed: z.string().nullable(),
    timebase: z.string().regex(/^\d+\/\d+$/, 'rational timebase, e.g. 30000/1001'),
    startTicks: BigIntString,
    endTicks: BigIntString,
    prerollTicks: BigIntString.optional(),
    requiresSequentialContext: z.boolean().optional(),
  })
  .meta({ id: 'RenderWorkerCheckpointPlanDto' });

const RenderWorkerCheckpointCompleteSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    chunkKey: z.string().min(1).describe('Must match the planned chunk; a re-planned chunk cannot be completed'),
    outputPath: z.string().min(1),
    outputChecksum: z.string().regex(/^[\da-f]+$/i, 'hex digest'),
    sizeInBytes: BigIntString,
  })
  .meta({ id: 'RenderWorkerCheckpointCompleteDto' });

/**
 * The file a Studio export render produced (FL-106). It must be inside the directory the claim
 * named for this render; publication hashes it again and never trusts the worker's word alone.
 */
const RenderWorkerOutputSchema = z
  .object({
    path: z.string().min(1).max(4096).describe('Absolute path inside the render directory the claim named'),
    checksum: z
      .string()
      .regex(/^[\da-f]{64}$/i, 'SHA-256 hex digest')
      .describe('SHA-256 of the whole file'),
    sizeInBytes: BigIntString,
    contentType: z.string().min(1).max(100).describe('`video/mp4`, `video/webm` or `video/quicktime`'),
    remoteRef: z
      .string()
      .min(1)
      .max(512)
      .nullable()
      .optional()
      .describe('What the worker calls a copy it kept; it is asked to delete it until it acknowledges'),
  })
  .meta({ id: 'RenderWorkerOutputDto' });

const RenderWorkerCompleteSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    resultAssetId: z
      .uuidv4()
      .nullable()
      .describe('Must be null for a Studio export: its result is adopted by publication, never named by a worker'),
    output: RenderWorkerOutputSchema.optional().describe('Required for a Studio export'),
  })
  .meta({ id: 'RenderWorkerCompleteDto' });

const RenderWorkerFailSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    error: z.string().max(4000),
    errorCode: z.string().min(1).max(80),
  })
  .meta({ id: 'RenderWorkerFailDto' });

const RenderWorkerCancelAckSchema = z
  .object({
    claimToken: ClaimTokenSchema,
    released: z.boolean().describe('True when remote resources are confirmed gone'),
  })
  .meta({ id: 'RenderWorkerCancelAckDto' });

/** Something this worker holds for a Studio export that it must stop or delete (FL-106). */
const RenderWorkerRemoteReferenceSchema = z
  .object({
    id: z.uuidv7(),
    operationId: z.uuidv7().describe('The render job'),
    reason: StudioExportRemoteReasonSchema,
    remoteRef: z.string().nullable().describe('The copy to delete, for a `delete` reference'),
    requestedAt: z.string().meta({ format: 'date-time' }),
  })
  .meta({ id: 'RenderWorkerRemoteReferenceDto' });

/** The answer to every guarded write. `accepted: false` means the claim no longer authorizes it. */
const RenderWorkerWriteResultSchema = z
  .object({
    accepted: z.boolean(),
    refusal: RenderWorkerRefusalReasonSchema.nullable(),
  })
  .meta({ id: 'RenderWorkerWriteResultDto' });

export class RenderWorkerDto extends createZodDto(RenderWorkerSchema) {}
export class RenderWorkerCreateDto extends createZodDto(RenderWorkerCreateSchema) {}
export class RenderWorkerCreateResponseDto extends createZodDto(RenderWorkerCreateResponseSchema) {}
export class RenderWorkerUpdateDto extends createZodDto(RenderWorkerUpdateSchema) {}
export class RenderWorkerLimitDto extends createZodDto(RenderWorkerLimitSchema) {}
export class RenderWorkerLimitsResponseDto extends createZodDto(RenderWorkerLimitsResponseSchema) {}
export class RenderWorkerLimitUpdateDto extends createZodDto(RenderWorkerLimitUpdateSchema) {}
export class RenderWorkerAuditDto extends createZodDto(RenderWorkerAuditSchema) {}
export class RenderWorkerAuditSearchDto extends createZodDto(RenderWorkerAuditSearchSchema) {}
export class RenderWorkerAdmissionDto extends createZodDto(RenderWorkerAdmissionSchema) {}
export class RenderWorkerSessionDto extends createZodDto(RenderWorkerSessionSchema) {}
export class RenderWorkerClaimRequestDto extends createZodDto(RenderWorkerClaimRequestSchema) {}
export class RenderWorkerInputGrantDto extends createZodDto(RenderWorkerInputGrantSchema) {}
export class RenderWorkerClaimLimitsDto extends createZodDto(RenderWorkerClaimLimitsSchema) {}
export class RenderWorkerClaimDto extends createZodDto(RenderWorkerClaimSchema) {}
export class RenderWorkerHeartbeatDto extends createZodDto(RenderWorkerHeartbeatSchema) {}
export class RenderWorkerHeartbeatResponseDto extends createZodDto(RenderWorkerHeartbeatResponseSchema) {}
export class RenderWorkerProgressDto extends createZodDto(RenderWorkerProgressSchema) {}
export class RenderWorkerCheckpointPlanDto extends createZodDto(RenderWorkerCheckpointPlanSchema) {}
export class RenderWorkerCheckpointCompleteDto extends createZodDto(RenderWorkerCheckpointCompleteSchema) {}
export class RenderWorkerCompleteDto extends createZodDto(RenderWorkerCompleteSchema) {}
export class RenderWorkerOutputDto extends createZodDto(RenderWorkerOutputSchema) {}
export class RenderWorkerRemoteReferenceDto extends createZodDto(RenderWorkerRemoteReferenceSchema) {}
export class RenderWorkerFailDto extends createZodDto(RenderWorkerFailSchema) {}
export class RenderWorkerCancelAckDto extends createZodDto(RenderWorkerCancelAckSchema) {}
export class RenderWorkerWriteResultDto extends createZodDto(RenderWorkerWriteResultSchema) {}

/**
 * FL-71 (CC-9): which render kinds have a qualified GPU worker right now, for the Overview's "GPU
 * Studio" and "Check worker compatibility" (CommandCenter.jsx:1800-1812, 1911-1914). A kind is
 * qualified while a live, unrevoked session carrying fresh conformance on its worker's engine digest
 * is scoped to it (`isQualifiedRenderSession`).
 */
const RenderWorkerCompatibilityResponseSchema = z
  .object({
    qualified: z.array(MediaOperationKindSchema).describe('Render kinds a qualified worker can take now'),
    unavailable: z.array(MediaOperationKindSchema).describe('Render kinds no qualified worker can take now'),
  })
  .meta({ id: 'RenderWorkerCompatibilityResponseDto' });

export class RenderWorkerCompatibilityResponseDto extends createZodDto(RenderWorkerCompatibilityResponseSchema) {}
