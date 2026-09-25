/**
 * Render worker admission rules (FL-95 `STU-401`), kept free of NestJS and the database so the
 * gate can be read and tested on its own.
 *
 * Three things live here:
 *
 * 1. The admission decisions. Whether a worker may be given a session, whether it may claim a
 *    particular operation, and whether a running operation is still inside its limits. Each is a
 *    pure function over plain inputs that returns a stable `RenderWorkerRefusalReason` rather
 *    than throwing, because the same reason is written to the audit trail, onto the refused
 *    operation and into the HTTP answer.
 * 2. The operation-scoped input grant. A worker never reads library media with its own
 *    credential: every input is handed out as a short-lived URL whose signature is bound to the
 *    claim it was issued under. When the claim changes hands the URL is worthless, which is the
 *    property that makes "a worker may only read the inputs of operations it claimed" hold.
 * 3. The seams two sibling stories implement. FL-90 owns *which* inputs an operation may read
 *    (the authorized manifest); FL-110 owns whether a destination is *currently able* to take
 *    work (destination health). This story defines the interfaces and ships an honest default
 *    for each; it does not depend on their code.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MediaOperationDestination, MediaOperationKind, RenderWorkerRefusalReason } from 'src/enum.js';
import { isRenderWorkerMediaOperationKind } from 'src/utils/media-operation.js';

/* ------------------------------------------------------------------ */
/* Seams                                                                */
/* ------------------------------------------------------------------ */

/** NestJS injection token. FL-110 registers a provider under it; nothing else is needed. */
export const DESTINATION_HEALTH_PROVIDER = 'FRAMELEAF_DESTINATION_HEALTH_PROVIDER';

/**
 * One thing a render needs to read, as the worker sees it. `resourceId` is a library asset id or
 * an FL-90 resource id; never a path. `token` is FL-90's signed read grant for Studio resources,
 * carried opaquely inside the operation-scoped grant and verified by FL-90 on redemption.
 */
export type AuthorizedInput = {
  /** FL-90's resource key (`kind:id`), or `source` for a single-asset workload. */
  inputId: string;
  kind: string;
  resourceId: string;
  /** The checksum the manifest was resolved against, when known. The worker verifies it. */
  checksum: string | null;
  token: string | null;
};

/**
 * Everything an operation is allowed to read, resolved against the *current* access state of its
 * owner. For Studio kinds this is FL-90's `StudioAuthorizedManifest` reduced to what a worker may
 * see; for single-asset workloads it is the source asset, re-checked for owner access.
 */
export type AuthorizedManifest = {
  operationId: string;
  revisionId: string | null;
  inputs: AuthorizedInput[];
};

/**
 * Whether a destination can take work right now. `unknown` is the honest default when nothing
 * has probed it; admission refuses only on `unavailable`. FL-110 supplies the real provider
 * (RunPod endpoint state, LAN reachability, local GPU presence).
 */
export type DestinationHealth = {
  destination: MediaOperationDestination;
  state: 'available' | 'unavailable' | 'unknown';
  /** Operator detail, shown on the admin page. Never a credential. */
  reason: string | null;
  checkedAt: Date | null;
};

export interface DestinationHealthProvider {
  check(destination: MediaOperationDestination, destinationDetail: string | null): Promise<DestinationHealth>;
}

/** The default until FL-110 lands: nothing is probed, so nothing is claimed. */
export class UnknownDestinationHealthProvider implements DestinationHealthProvider {
  check(destination: MediaOperationDestination): Promise<DestinationHealth> {
    return Promise.resolve({ destination, state: 'unknown', reason: null, checkedAt: null });
  }
}

/* ------------------------------------------------------------------ */
/* Limits                                                               */
/* ------------------------------------------------------------------ */

/** A ceiling of null means "no ceiling". Values are plain numbers; bigint columns are converted first. */
export type RenderLimits = {
  maxConcurrentOperations: number;
  maxWallClockMs: number | null;
  maxOutputBytes: number | null;
};

/**
 * Combine ceilings from several sources by taking the tightest of each. A per-account row does
 * not loosen the instance default, and neither loosens the worker: the strictest source wins.
 */
export const tightestLimits = (...sources: Array<Partial<RenderLimits> | null | undefined>): RenderLimits => {
  const result: RenderLimits = {
    maxConcurrentOperations: Infinity,
    maxWallClockMs: null,
    maxOutputBytes: null,
  };

  for (const source of sources) {
    if (!source) {
      continue;
    }

    if (typeof source.maxConcurrentOperations === 'number') {
      result.maxConcurrentOperations = Math.min(result.maxConcurrentOperations, source.maxConcurrentOperations);
    }

    result.maxWallClockMs = tighter(result.maxWallClockMs, source.maxWallClockMs);
    result.maxOutputBytes = tighter(result.maxOutputBytes, source.maxOutputBytes);
  }

  return result;
};

const tighter = (current: number | null, candidate: number | null | undefined): number | null => {
  if (candidate === null || candidate === undefined) {
    return current;
  }
  return current === null ? candidate : Math.min(current, candidate);
};

/* ------------------------------------------------------------------ */
/* Admission                                                            */
/* ------------------------------------------------------------------ */

export type AdmissionDecision = { admitted: true } | { admitted: false; reason: RenderWorkerRefusalReason };

const refuse = (reason: RenderWorkerRefusalReason): AdmissionDecision => ({ admitted: false, reason });
const ADMIT: AdmissionDecision = { admitted: true };

export type SessionAdmissionInput = {
  worker: {
    revoked: boolean;
    engineDigest: string | null;
    conformanceMaxAgeMs: number;
    lastConformanceReportedAt: Date | null;
  };
  report: {
    engineDigest: string;
    /** When the worker ran its conformance check. Must be recent and must be newer than the last one accepted. */
    conformanceReportedAt: Date;
    /** True when the renderer is a software or fallback device. Refused outright. */
    softwareRenderer: boolean;
  };
  now: Date;
};

/**
 * May this worker be given a session?
 *
 * The order is deliberate: revocation first because nothing else matters after it; then the
 * report's freshness, replay and digest, in the order that fails fastest for the common mistakes
 * (an old report, a re-sent report, an upgraded engine); then the hardware class. A software GPU
 * is refused even when everything else is in order, because a software renderer cannot produce
 * the HDR and Dolby Vision output full Studio is gated on and must never be admitted as if it could.
 */
export const evaluateSessionAdmission = ({ worker, report, now }: SessionAdmissionInput): AdmissionDecision => {
  if (worker.revoked) {
    return refuse(RenderWorkerRefusalReason.WorkerRevoked);
  }

  const reportedAt = report.conformanceReportedAt.getTime();
  if (Number.isNaN(reportedAt) || reportedAt > now.getTime() + CLOCK_SKEW_MS) {
    // A report from the future is not evidence of anything that has happened.
    return refuse(RenderWorkerRefusalReason.ConformanceStale);
  }

  if (now.getTime() - reportedAt > worker.conformanceMaxAgeMs) {
    return refuse(RenderWorkerRefusalReason.ConformanceStale);
  }

  if (worker.lastConformanceReportedAt && reportedAt <= worker.lastConformanceReportedAt.getTime()) {
    return refuse(RenderWorkerRefusalReason.ConformanceReplayed);
  }

  if (worker.engineDigest && worker.engineDigest !== report.engineDigest) {
    return refuse(RenderWorkerRefusalReason.EngineDigestMismatch);
  }

  if (report.softwareRenderer) {
    return refuse(RenderWorkerRefusalReason.SoftwareRenderer);
  }

  return ADMIT;
};

export type LiveRenderSessionInput = {
  worker: {
    revoked: boolean;
    engineDigest: string | null;
    conformanceMaxAgeMs: number;
  };
  session: {
    revoked: boolean;
    expiresAt: Date;
    engineDigest: string | null;
    conformanceReportedAt: Date;
    scopes: readonly MediaOperationKind[];
  };
  now: Date;
};

/**
 * Is this admitted session still evidence of a qualified renderer (FL-42)? It must be live
 * (unrevoked, unexpired, its worker active), its conformance report still within the worker's
 * freshness window, and — when the worker is pinned to an engine digest — admitted on that digest.
 * A digest the administrator changed after admission disqualifies the session until it re-admits.
 * Admission already refuses software renderers, so a qualified session is a GPU renderer.
 */
export const isQualifiedRenderSession = ({ worker, session, now }: LiveRenderSessionInput): boolean => {
  if (worker.revoked || session.revoked || session.expiresAt.getTime() <= now.getTime()) {
    return false;
  }
  const reportedAt = session.conformanceReportedAt.getTime();
  if (
    Number.isNaN(reportedAt) ||
    reportedAt > now.getTime() + CLOCK_SKEW_MS ||
    now.getTime() - reportedAt > worker.conformanceMaxAgeMs
  ) {
    return false;
  }
  if (worker.engineDigest && worker.engineDigest !== session.engineDigest) {
    return false;
  }
  return session.scopes.some((kind) => isRenderWorkerMediaOperationKind(kind));
};

/** How far ahead of the server a worker's clock may be before its report is treated as invalid. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

export type ClaimAdmissionInput = {
  worker: {
    id: string;
    name: string;
    destination: MediaOperationDestination;
    revoked: boolean;
    kinds: readonly MediaOperationKind[];
    gpuMemoryBytes: number | null;
    /** Operations this worker already holds. */
    activeOperations: number;
    limits: RenderLimits;
  };
  session: {
    expiresAt: Date;
    revoked: boolean;
    scopes: readonly MediaOperationKind[];
    /** What the worker was admitted with. A claim is measured against this, not a fresh figure. */
    gpuMemoryBytes: number | null;
    engineDigest: string | null;
    /**
     * The encoders and containers the session's conformance check verified (FL-95). Null when the
     * session proved none, which admits no job that names an output format.
     */
    capabilities?: { codecs: readonly string[]; formats: readonly string[] } | null;
  };
  operation: {
    kind: MediaOperationKind;
    destination: MediaOperationDestination;
    destinationDetail: string | null;
    snapshot: Record<string, unknown>;
    /** The job's output settings; `format` names what it writes (FL-106 Studio export formats). */
    settings?: Record<string, unknown>;
  };
  owner: {
    /** Operations this account already has claimed, across every worker. */
    activeOperations: number;
    limits: RenderLimits;
  };
  destinationHealth: DestinationHealth;
  now: Date;
};

/**
 * May this worker take this operation?
 *
 * Refusals about the worker (revoked, expired, wrong destination, out of scope) mean the worker
 * should stop asking; refusals about the operation (limits, memory) mean it should try the next
 * one. The caller uses {@link isWorkerRefusal} to tell them apart and records the second kind on
 * the operation, so its owner can see why it is still queued.
 */
export const evaluateClaimAdmission = (input: ClaimAdmissionInput): AdmissionDecision => {
  const { worker, session, operation, owner, destinationHealth, now } = input;

  if (worker.revoked || session.revoked) {
    return refuse(RenderWorkerRefusalReason.WorkerRevoked);
  }

  if (session.expiresAt.getTime() <= now.getTime()) {
    return refuse(RenderWorkerRefusalReason.SessionExpired);
  }

  if (operation.destination !== worker.destination) {
    // A LAN worker never takes a RunPod job and a RunPod worker never takes a local one. The
    // destination was the person's explicit choice; admission does not reinterpret it.
    return refuse(RenderWorkerRefusalReason.DestinationMismatch);
  }

  if (
    operation.destinationDetail &&
    operation.destinationDetail !== worker.id &&
    operation.destinationDetail !== worker.name
  ) {
    return refuse(RenderWorkerRefusalReason.WorkerMismatch);
  }

  // FL-73: whatever a scope says, a remote renderer is never handed a job that runs on the server.
  if (
    !isRenderWorkerMediaOperationKind(operation.kind) ||
    !session.scopes.includes(operation.kind) ||
    !worker.kinds.includes(operation.kind)
  ) {
    return refuse(RenderWorkerRefusalReason.ScopeExceeded);
  }

  if (destinationHealth.state === 'unavailable') {
    return refuse(RenderWorkerRefusalReason.DestinationUnavailable);
  }

  const requiredEngine = snapshotString(operation.snapshot, 'engineDigest');
  if (requiredEngine && session.engineDigest && requiredEngine !== session.engineDigest) {
    // The job was snapshotted against one engine; rendering it on another is different work.
    return refuse(RenderWorkerRefusalReason.EngineDigestMismatch);
  }

  const output = requiredOutput(operation.settings);
  if (output && !provesOutput(session.capabilities ?? null, output)) {
    // Bound to the evidence, not to a hope: an unproven encoder would fail or fall back mid-render.
    return refuse(RenderWorkerRefusalReason.CodecUnsupported);
  }

  const gpuHint = snapshotNumber(operation.snapshot, 'gpuMemoryHintBytes');
  if (gpuHint !== null) {
    const available = session.gpuMemoryBytes ?? worker.gpuMemoryBytes;
    if (available === null || gpuHint > available) {
      return refuse(RenderWorkerRefusalReason.GpuMemoryInsufficient);
    }
  }

  if (worker.activeOperations >= worker.limits.maxConcurrentOperations) {
    return refuse(RenderWorkerRefusalReason.WorkerConcurrency);
  }

  if (owner.activeOperations >= owner.limits.maxConcurrentOperations) {
    return refuse(RenderWorkerRefusalReason.UserConcurrency);
  }

  return ADMIT;
};

/** Refusals that are about the worker itself. After one of these the worker should stop claiming. */
export const WORKER_REFUSALS: ReadonlySet<RenderWorkerRefusalReason> = new Set([
  RenderWorkerRefusalReason.InvalidCredential,
  RenderWorkerRefusalReason.WorkerRevoked,
  RenderWorkerRefusalReason.SessionExpired,
  RenderWorkerRefusalReason.ConformanceStale,
  RenderWorkerRefusalReason.ConformanceReplayed,
  RenderWorkerRefusalReason.SoftwareRenderer,
  RenderWorkerRefusalReason.WorkerConcurrency,
]);

export const isWorkerRefusal = (reason: RenderWorkerRefusalReason) => WORKER_REFUSALS.has(reason);

export type RunningLimitsInput = {
  startedAt: Date | null;
  outputBytes: number;
  limits: RenderLimits;
  now: Date;
};

/**
 * Is a claimed operation still within its ceilings? Checked on every heartbeat and progress
 * report, so a runaway render is stopped by the server rather than trusted to stop itself.
 */
export const evaluateRunningLimits = ({
  startedAt,
  outputBytes,
  limits,
  now,
}: RunningLimitsInput): AdmissionDecision => {
  if (limits.maxWallClockMs !== null && startedAt && now.getTime() - startedAt.getTime() > limits.maxWallClockMs) {
    return refuse(RenderWorkerRefusalReason.WallClockExceeded);
  }

  if (limits.maxOutputBytes !== null && outputBytes > limits.maxOutputBytes) {
    return refuse(RenderWorkerRefusalReason.OutputBytesExceeded);
  }

  return ADMIT;
};

/**
 * The encoder family and container each Studio export format writes (`STUDIO_EXPORT_FORMATS`).
 * A worker proves a family by reporting any encoder whose name carries one of its tokens, so
 * `hevc_nvenc`, `libx265` and `hevc_vaapi` all prove HEVC.
 */
/**
 * The ffmpeg *encoder* names that can write each export format. Evidence must name one of them
 * exactly: a decoder such as `h264_cuvid` or `hevc_qsv`'s decode-only sibling proves nothing about
 * writing the format, so substring matching is not allowed.
 */
const OUTPUT_FORMATS: Readonly<Record<string, { codec: readonly string[]; container: string }>> = {
  'mp4-hevc-main10': {
    codec: [
      'libx265',
      'hevc_nvenc',
      'hevc_qsv',
      'hevc_vaapi',
      'hevc_videotoolbox',
      'hevc_amf',
      'hevc_rkmpp',
      'hevc_v4l2m2m',
    ],
    container: 'mp4',
  },
  'mp4-h264': {
    codec: [
      'libx264',
      'h264_nvenc',
      'h264_qsv',
      'h264_vaapi',
      'h264_videotoolbox',
      'h264_amf',
      'h264_rkmpp',
      'h264_v4l2m2m',
    ],
    container: 'mp4',
  },
  'webm-av1': {
    codec: ['libsvtav1', 'libaom-av1', 'librav1e', 'av1_nvenc', 'av1_qsv', 'av1_vaapi', 'av1_amf'],
    container: 'webm',
  },
  'prores-422-hq': { codec: ['prores_ks', 'prores', 'prores_aw', 'prores_videotoolbox'], container: 'mov' },
};

export type RequiredOutput = { format: string; codec: readonly string[]; container: string };

/** What a job's output needs, or null when it names no output format. An unknown format needs the impossible. */
export const requiredOutput = (settings: Record<string, unknown> | undefined): RequiredOutput | null => {
  const format = settings?.format;
  if (typeof format !== 'string' || format.length === 0) {
    return null;
  }
  const known = Object.hasOwn(OUTPUT_FORMATS, format) ? OUTPUT_FORMATS[format] : undefined;
  return known ? { format, ...known } : { format, codec: [], container: format };
};

/** Did the session's evidence name one of this format's encoders, exactly, and its container? */
export const provesOutput = (
  capabilities: { codecs: readonly string[]; formats: readonly string[] } | null,
  output: RequiredOutput,
): boolean => {
  if (!capabilities || output.codec.length === 0) {
    return false;
  }
  const codecs = new Set(capabilities.codecs.map((codec) => codec.toLowerCase()));
  const formats = capabilities.formats.map((format) => format.toLowerCase());
  return output.codec.some((encoder) => codecs.has(encoder)) && formats.includes(output.container);
};

const snapshotString = (snapshot: Record<string, unknown>, key: string): string | null => {
  const value = snapshot[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const snapshotNumber = (snapshot: Record<string, unknown>, key: string): number | null => {
  const value = snapshot[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
};

/* ------------------------------------------------------------------ */
/* Input grants                                                         */
/* ------------------------------------------------------------------ */

/** How long an input URL is good for. Long enough to open a stream, not long enough to keep. */
export const INPUT_GRANT_TTL_MS = 10 * 60 * 1000;

export type InputGrantPayload = {
  operationId: string;
  inputId: string;
  resourceId: string;
  /** FL-90's read grant for a Studio resource, verified again on redemption. Null for a plain asset. */
  token: string | null;
  /** Milliseconds since the epoch. */
  expiresAt: number;
};

export type InputGrantBinding = {
  /** The claim the grant was minted under. A different claim on the same operation cannot verify it. */
  claimToken: string;
  /** The session credential's stored digest. A different session cannot verify it either. */
  sessionTokenHash: Buffer;
};

/**
 * The signing key is derived from the claim and the session rather than from a server-wide
 * secret. There is nothing to leak that outlives the claim, and a resurrected worker with a
 * stale token cannot mint or verify anything for the job its replacement is running.
 */
const grantKey = ({ claimToken, sessionTokenHash }: InputGrantBinding) =>
  createHmac('sha256', sessionTokenHash).update(claimToken).digest();

const encode = (value: Buffer | string) => Buffer.from(value).toString('base64url');

export const signInputGrant = (payload: InputGrantPayload, binding: InputGrantBinding): string => {
  const body = encode(JSON.stringify(payload));
  const signature = createHmac('sha256', grantKey(binding)).update(body).digest();
  return `${body}.${encode(signature)}`;
};

export type InputGrantRejection = 'malformed' | 'signature' | 'expired' | 'operation-mismatch';

export type InputGrantDecision =
  { valid: true; payload: InputGrantPayload } | { valid: false; reason: InputGrantRejection };

/**
 * Verify a grant against the operation it is being used on and the claim and session presenting
 * it. The operation id in the URL path must match the one signed into the grant, so a grant for
 * one job cannot be replayed against another even by the same worker.
 */
export const verifyInputGrant = (
  grant: string,
  expected: { operationId: string; binding: InputGrantBinding; now: Date },
): InputGrantDecision => {
  const [body, signature, ...rest] = grant.split('.');
  if (!body || !signature || rest.length > 0) {
    return { valid: false, reason: 'malformed' };
  }

  const expectedSignature = createHmac('sha256', grantKey(expected.binding)).update(body).digest();
  const givenSignature = Buffer.from(signature, 'base64url');
  if (givenSignature.length !== expectedSignature.length || !timingSafeEqual(givenSignature, expectedSignature)) {
    return { valid: false, reason: 'signature' };
  }

  let payload: InputGrantPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as InputGrantPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (
    typeof payload?.operationId !== 'string' ||
    typeof payload.inputId !== 'string' ||
    typeof payload.resourceId !== 'string' ||
    (payload.token !== null && typeof payload.token !== 'string') ||
    typeof payload.expiresAt !== 'number'
  ) {
    return { valid: false, reason: 'malformed' };
  }

  if (payload.operationId !== expected.operationId) {
    return { valid: false, reason: 'operation-mismatch' };
  }

  if (payload.expiresAt <= expected.now.getTime()) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, payload };
};
