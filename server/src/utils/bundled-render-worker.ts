/**
 * FL-408: the Studio render worker that ships inside the bundled machine-learning container.
 *
 * Every other render worker is enrolled by an administrator and admitted only with measured
 * hardware-GPU working-budget evidence (`gpu-working-budget-policy.ts`). The bundled worker is
 * different in exactly two ways, and nothing else about the protocol changes:
 *
 * 1. **Trust.** The server enrols it itself, at boot, and records that decision on the worker row
 *    as {@link BundledRenderWorkerApproval}. The approval column is trusted policy written only by
 *    the server: the administrator API validates it against the measured-evidence schema, which
 *    cannot express this marker. The enrolment secret reaches the machine-learning container
 *    through a private volume both containers mount (or a secret both are given), never over the
 *    network from the server, and admission is refused from any non-internal origin.
 * 2. **Evidence.** It may render on the CPU. Instead of hardware working-budget evidence it reports,
 *    honestly, whether its renderer is software, the encoders/containers its start-up conformance
 *    encode actually produced, and the working memory it may use. Claim admission still applies
 *    every other rule: scopes, destination, engine digest, verified output, limits, leases.
 */
import { BlockList, isIP } from 'node:net';
import z from 'zod';
import type { GpuWorkingBudgetDecision } from 'src/utils/gpu-working-budget.js';
import { MediaOperationKind, RenderWorkerStatus } from 'src/enum.js';
import { isQualifiedRenderSession } from 'src/utils/render-admission.js';

export const BUNDLED_RENDER_WORKER_MARKER = 'frameleaf-bundled-studio-worker-v1';

export const BundledRenderWorkerApprovalSchema = z.strictObject({
  bundled: z.literal(BUNDLED_RENDER_WORKER_MARKER),
});
export type BundledRenderWorkerApproval = z.infer<typeof BundledRenderWorkerApprovalSchema>;

export const BUNDLED_RENDER_WORKER_APPROVAL: BundledRenderWorkerApproval = Object.freeze({
  bundled: BUNDLED_RENDER_WORKER_MARKER,
});

export const BUNDLED_RENDER_WORKER_NAME = 'Studio worker (machine learning)';

/** What the bundled worker may claim: whole exports only, not remote previews or conforms. */
export const BUNDLED_RENDER_WORKER_KINDS: readonly MediaOperationKind[] = Object.freeze([
  MediaOperationKind.StudioExport,
]);

/** The file in the shared trust directory the machine-learning container reads its enrolment from. */
export const BUNDLED_RENDER_WORKER_TRUST_FILE = 'enrolment.json';

/** Smallest working memory a bundled session may claim against (the 720p render budget). */
export const BUNDLED_RENDER_WORKER_MIN_MEMORY = 2n * 1024n ** 3n;

export const isBundledRenderWorker = (worker: { gpuWorkingBudgetApproval: unknown }): boolean =>
  BundledRenderWorkerApprovalSchema.safeParse(worker.gpuWorkingBudgetApproval).success;

/** Where an admission request came from: the socket peer, and whether any proxy forwarded it. */
export type RenderWorkerOrigin = { remoteAddress: string | undefined | null; forwarded: boolean };

/** The origin of an Express request, read from the socket rather than trusted-proxy headers. */
export const renderWorkerOriginOf = (request: {
  socket?: { remoteAddress?: string };
  headers: Record<string, string | string[] | undefined>;
}): RenderWorkerOrigin => ({
  remoteAddress: request.socket?.remoteAddress ?? null,
  forwarded: ['x-forwarded-for', 'forwarded', 'x-real-ip'].some((name) => request.headers[name] !== undefined),
});

const internalNetworks = (): BlockList => {
  const list = new BlockList();
  list.addSubnet('127.0.0.0', 8, 'ipv4');
  list.addSubnet('10.0.0.0', 8, 'ipv4');
  list.addSubnet('172.16.0.0', 12, 'ipv4');
  list.addSubnet('192.168.0.0', 16, 'ipv4');
  list.addSubnet('169.254.0.0', 16, 'ipv4');
  list.addAddress('::1', 'ipv6');
  list.addSubnet('fc00::', 7, 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  return list;
};

/**
 * Is this request from the container network rather than through a proxy or from the internet?
 * The socket address must be loopback or private, and the request must carry no forwarding
 * header: a reverse proxy on the same network would otherwise make a remote caller look local.
 */
export const isInternalWorkerOrigin = (origin: RenderWorkerOrigin): boolean => {
  if (origin.forwarded || !origin.remoteAddress) {
    return false;
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(origin.remoteAddress);
  const address = mapped ? mapped[1] : origin.remoteAddress;
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  return internalNetworks().check(address, family === 4 ? 'ipv4' : 'ipv6');
};

/**
 * Admission for the bundled worker. Freshness, replay and engine pinning are the same rules every
 * worker gets; a software renderer is allowed because it is reported, and the working memory it
 * reports must at least cover the smallest export resolution.
 */
export const evaluateBundledAdmissionBudget = (input: {
  reportedBytes: string | null | undefined;
  conformanceExpiresAt: Date;
  credentialExpiresAt: Date;
}): GpuWorkingBudgetDecision => {
  const reported = input.reportedBytes;
  if (!reported || !/^(0|[1-9][0-9]{0,18})$/.test(reported) || BigInt(reported) < BUNDLED_RENDER_WORKER_MIN_MEMORY) {
    return { valid: false, reason: 'evidence-invalid' };
  }
  const expiresAt =
    input.conformanceExpiresAt.getTime() < input.credentialExpiresAt.getTime()
      ? input.conformanceExpiresAt
      : input.credentialExpiresAt;
  return { valid: true, measuredBytes: reported, qualifiedBytes: reported, expiresAt: expiresAt.toISOString() };
};

/** Is a live bundled session still qualified to render, and with how much working memory? */
export const evaluateBundledRenderSession = (input: {
  worker: {
    id: string;
    status: RenderWorkerStatus;
    kinds: readonly MediaOperationKind[];
    engineDigest: string | null;
    conformanceMaxAgeMs: number;
    maxConcurrentOperations: number;
  };
  session: {
    workerId: string;
    revokedAt: Date | null;
    expiresAt: Date;
    engineDigest: string | null;
    conformanceReportedAt: Date;
    scopes: readonly MediaOperationKind[];
    gpuMemoryBytes: string | null;
    codecs: readonly string[] | null;
  };
  capabilities: { codecs: readonly string[]; formats: readonly string[] } | null | undefined;
  now: Date;
}): GpuWorkingBudgetDecision => {
  const { worker, session, capabilities, now } = input;
  if (
    session.workerId !== worker.id ||
    !capabilities ||
    JSON.stringify(session.codecs) !== JSON.stringify(capabilities.codecs) ||
    worker.maxConcurrentOperations !== 1 ||
    !isQualifiedRenderSession({
      worker: { ...worker, revoked: worker.status !== RenderWorkerStatus.Active },
      session: {
        ...session,
        revoked: session.revokedAt !== null,
        scopes: session.scopes.filter((kind) => worker.kinds.includes(kind)),
      },
      now,
    })
  ) {
    return { valid: false, reason: 'session-unqualified' };
  }
  return evaluateBundledAdmissionBudget({
    reportedBytes: session.gpuMemoryBytes,
    conformanceExpiresAt: new Date(new Date(session.conformanceReportedAt).getTime() + worker.conformanceMaxAgeMs),
    credentialExpiresAt: new Date(session.expiresAt),
  });
};
