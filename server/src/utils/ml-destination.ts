import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { MlProbeHardware } from 'src/schema/tables/ml-destination.table.js';
import {
  CLOUD_ML_DESTINATION_KINDS,
  FRAMELEAF_CLOUD_ML_WORKLOADS,
  LIBRARY_ML_WORKLOADS,
  MlAdmissionRefusal,
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkerAcceleration,
  MlWorkerReadiness,
  MlWorkerRole,
  MlWorkload,
  RESTORATION_ML_WORKLOADS,
} from 'src/enum.js';
import {
  FRAMELEAF_CLOUD_ENDPOINT,
  ML_PROBE_FRESHNESS_MS,
  MachineLearningRepository,
  MlEndpoint,
  MlEndpointProbe,
  MlSelection,
  MlUsage,
} from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository, MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { cloudModelFor, isLocalOnlyModel } from 'src/utils/frameleaf-cloud.js';

/**
 * Explicit destination selection (FL-110).
 *
 * A caller names a workload and a destination. The destination is admitted only when it
 * exists, is enabled, allows the workload, was probed healthy just now and reports that it
 * serves the workload; a cloud destination additionally needs the administrator's recorded
 * consent and must be inside its budget. Any other outcome is a refusal that names the
 * reason. Nothing in this module ever picks a different destination: there is no ordering,
 * no "next URL" and no cloud fallback, so a job whose destination is gone fails in place
 * instead of quietly moving the media somewhere else.
 */

/** Window over which a destination's spend is compared with its budget limit. */
export const ML_BUDGET_WINDOW_DAYS = 30;

export class MlDestinationRefusedError extends BadRequestException {
  constructor(
    readonly refusal: MlAdmissionRefusal,
    readonly workload: MlWorkload,
    readonly destinationId: string | null,
    detail: string,
  ) {
    super(`Machine learning destination refused (${refusal}) for ${workload}: ${detail}`);
  }
}

export class MlDestinationNotFoundError extends NotFoundException {
  readonly refusal = MlAdmissionRefusal.DestinationMissing;

  constructor(
    readonly workload: MlWorkload,
    readonly destinationId: string,
  ) {
    super(`Machine learning destination ${destinationId} does not exist (${MlAdmissionRefusal.DestinationMissing})`);
  }
}

export type MlSelectionRequest = {
  workload: MlWorkload;
  destinationId: string;
  /** The durable job this request belongs to, recorded with the accounting row. */
  jobId?: string | null;
  jobName?: string | null;
  /** FL-159: the AI Wallet hold a time-priced Frameleaf Cloud job needs, when it is known. */
  holdUsd?: number | null;
};

export type MlSelectionDeps = {
  mlDestinationRepository: MlDestinationRepository;
  machineLearningRepository: MachineLearningRepository;
};

export const isCloudDestination = (kind: MlDestinationKind): boolean => CLOUD_ML_DESTINATION_KINDS.has(kind);

/** Whether a destination row carries the consent a cloud kind requires. Local and LAN never need it. */
export const hasRequiredConsent = (destination: Pick<MlDestinationRow, 'kind' | 'consentAcknowledgedAt'>) =>
  !isCloudDestination(destination.kind) || destination.consentAcknowledgedAt !== null;

/**
 * Resolve where a destination row actually points. Local and LAN rows carry their URL; the
 * Frameleaf Cloud destination resolves to the `FRAMELEAF_CLOUD_ENDPOINT` sentinel, whose check the
 * cloud processing service answers from the regional gateway (FL-159).
 */
export const resolveEndpoint = (
  destination: Pick<MlDestinationRow, 'kind' | 'url' | 'authToken'>,
): MlEndpoint | null => {
  if (destination.kind === MlDestinationKind.FrameleafCloud) {
    return FRAMELEAF_CLOUD_ENDPOINT;
  }
  if (!destination.url) {
    return null;
  }
  return destination.authToken ? { url: destination.url, authToken: destination.authToken } : { url: destination.url };
};

/** What a check records for a destination that resolves to no endpoint. */
export const unresolvedEndpointSummary = (kind: MlDestinationKind): string =>
  kind === MlDestinationKind.FrameleafCloud ? 'Frameleaf Cloud is not linked to this server' : 'No URL configured';

/**
 * A worker that may run library analysis and restoration together without either holding the
 * other's hardware: only Frameleaf Cloud, whose gateway schedules each job on its own capacity.
 */
export const mayMixRoles = (kind: MlDestinationKind): boolean => kind === MlDestinationKind.FrameleafCloud;

/* ------------------------------------------------------------------ */
/* Worker roles (FL-72)                                                */
/* ------------------------------------------------------------------ */

export const isLibraryWorkload = (workload: MlWorkload): boolean => LIBRARY_ML_WORKLOADS.includes(workload);
export const isRestorationWorkload = (workload: MlWorkload): boolean => RESTORATION_ML_WORKLOADS.includes(workload);

/** What a worker is for, from the workloads it is allowed to run. */
export const mlWorkerRoleOf = (workloads: readonly MlWorkload[]): MlWorkerRole => {
  const library = workloads.some((workload) => isLibraryWorkload(workload));
  const restoration = workloads.some((workload) => isRestorationWorkload(workload));
  if (library && restoration) {
    return MlWorkerRole.Mixed;
  }
  if (library) {
    return MlWorkerRole.LibraryAnalysis;
  }
  if (restoration) {
    return MlWorkerRole.Restoration;
  }
  return workloads.length > 0 ? MlWorkerRole.Studio : MlWorkerRole.Unassigned;
};

/**
 * Why a destination may not be allowed these workloads, or null when it may.
 *
 * - Library analysis and restoration never share a local or LAN worker, so a long restoration
 *   cannot hold the hardware library analysis needs.
 * - Frameleaf Cloud may mix them (each cloud job gets its own capacity) but only for the
 *   workloads it offers; faces are refused by policy and search embeddings and OCR stay local.
 */
export const workloadPolicyProblem = (kind: MlDestinationKind, workloads: readonly MlWorkload[]): string | null => {
  if (kind === MlDestinationKind.FrameleafCloud) {
    const refused = workloads.filter((workload) => !FRAMELEAF_CLOUD_ML_WORKLOADS.includes(workload));
    return refused.length > 0
      ? `Frameleaf Cloud runs descriptions, restoration and Studio AI only; ${refused.join(', ')} stays on this network`
      : null;
  }
  const role = mlWorkerRoleOf(workloads);
  if (role === MlWorkerRole.Mixed) {
    return 'A worker runs library analysis or restoration, not both; add the restoration worker as its own destination';
  }
  return null;
};

/** Normalize an endpoint URL for comparison: trailing slashes and letter case of the host do not matter. */
export const sameEndpointUrl = (a: string, b: string): boolean => {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname.replace(/\/+$/, '') === right.pathname.replace(/\/+$/, '');
  } catch {
    return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
  }
};

/**
 * Refuse a restoration on an endpoint library analysis uses (FL-72): the destination itself
 * is routed for a library workload, or another destination routed for one points at the same
 * URL. Only restoration is ever refused here; library analysis keeps its route.
 */
export const restorationRoleConflict = async (
  { mlDestinationRepository }: Pick<MlSelectionDeps, 'mlDestinationRepository'> & Partial<MlSelectionDeps>,
  destination: MlDestinationRow,
  workload: MlWorkload,
): Promise<string | null> => {
  if (!isRestorationWorkload(workload)) {
    return null;
  }
  if (mayMixRoles(destination.kind)) {
    return null;
  }
  if (mlWorkerRoleOf(destination.workloads) === MlWorkerRole.Mixed) {
    return `${destination.name} is also allowed library analysis; restoration runs only on a separate worker`;
  }
  const endpoint = resolveEndpoint(destination);
  const routes = await mlDestinationRepository.getRoutes();
  for (const route of routes) {
    if (!isLibraryWorkload(route.workload)) {
      continue;
    }
    if (route.destinationId === destination.id) {
      return `${destination.name} is routed for ${route.workload}; restoration runs only on a separate worker`;
    }
    if (!endpoint) {
      continue;
    }
    const routed = await mlDestinationRepository.getById(route.destinationId);
    const routedEndpoint = routed ? resolveEndpoint(routed) : null;
    if (routedEndpoint && sameEndpointUrl(routedEndpoint.url, endpoint.url)) {
      return `${destination.name} points at the endpoint ${routed?.name ?? route.destinationId} uses for ${route.workload}; restoration runs only on a separate worker`;
    }
  }
  return null;
};

/* ------------------------------------------------------------------ */
/* Hardware and readiness (FL-72)                                      */
/* ------------------------------------------------------------------ */

/** Execution providers that mean "no accelerator". */
const CPU_PROVIDERS = new Set(['CPUExecutionProvider', 'AzureExecutionProvider']);

/** The hardware facts worth keeping from one probe, or null when the worker did not report them. */
export const hardwareFromProbe = (
  probe: Pick<MlEndpointProbe, 'reachable' | 'hardware'>,
  gpus: MlProbeHardware['gpus'] = [],
): MlProbeHardware | null => {
  if (!probe.reachable || (!probe.hardware && gpus.length === 0)) {
    return null;
  }
  return {
    preferredAcceleration: probe.hardware?.preferredAcceleration ?? null,
    providers: [...(probe.hardware?.providers ?? [])],
    cudaDeviceCount: Math.max(probe.hardware?.cudaDeviceCount ?? 0, gpus.length),
    gpus,
  };
};

/** CPU or accelerator, from stored hardware facts. Missing facts are `unknown`, never assumed. */
export const accelerationOf = (hardware: MlProbeHardware | null): MlWorkerAcceleration => {
  if (!hardware) {
    return MlWorkerAcceleration.Unknown;
  }
  const accelerated =
    hardware.gpus.length > 0 ||
    hardware.cudaDeviceCount > 0 ||
    (hardware.preferredAcceleration !== null && hardware.preferredAcceleration !== 'auto') ||
    hardware.providers.some((provider) => !CPU_PROVIDERS.has(provider));
  return accelerated ? MlWorkerAcceleration.Gpu : MlWorkerAcceleration.Cpu;
};

/**
 * The inventory state of one destination from its stored check. `not-serving` means the worker
 * answered but reports none of the work it is allowed; `cpu` means it serves that work on the
 * CPU only. A worker that serves its work and did not report hardware is `model-ready`, with
 * its acceleration shown separately as unknown.
 */
export const readinessOf = (
  row: Pick<MlDestinationRow, 'enabled' | 'workloads' | 'lastProbeHealth' | 'lastProbeWorkloads' | 'lastProbeHardware'>,
): MlWorkerReadiness => {
  if (!row.enabled) {
    return MlWorkerReadiness.Disabled;
  }
  if (row.lastProbeHealth === MlDestinationHealth.Unknown) {
    return MlWorkerReadiness.Unknown;
  }
  if (row.lastProbeHealth === MlDestinationHealth.Unhealthy || row.lastProbeWorkloads === null) {
    return MlWorkerReadiness.Unreachable;
  }
  const served = row.lastProbeWorkloads.filter((workload) => row.workloads.includes(workload));
  if (served.length === 0) {
    return MlWorkerReadiness.NotServing;
  }
  return accelerationOf(row.lastProbeHardware) === MlWorkerAcceleration.Cpu
    ? MlWorkerReadiness.Cpu
    : MlWorkerReadiness.ModelReady;
};

/** The persisted check as an admission input, so a read never contacts a worker. */
export const storedProbe = (
  row: Pick<
    MlDestinationRow,
    'lastProbeAt' | 'lastProbeHealth' | 'lastProbeWorkloads' | 'lastProbeSummary' | 'lastProbeCloud'
  >,
): MlEndpointProbe | null => {
  if (!row.lastProbeAt) {
    return null;
  }
  const healthy = row.lastProbeHealth === MlDestinationHealth.Healthy;
  return {
    reachable: healthy,
    workloads: row.lastProbeWorkloads ?? [],
    hardware: null,
    latencyMs: 0,
    probedAt: new Date(row.lastProbeAt),
    error: healthy ? null : (row.lastProbeSummary ?? 'not probed'),
    cloud: row.lastProbeCloud,
  };
};

/**
 * The least GPU memory a workload needs, where one is known (FL-58). It is only held against a
 * worker that reported its GPUs and their memory (restoration workers do; the `/predict` container
 * reports providers only), so a worker that says nothing about memory is never refused for it.
 * Pet recognition encodes short CLIP text prompts; 1 GiB covers the largest supported CLIP text
 * encoder with its runtime.
 */
export const ML_WORKLOAD_MIN_GPU_MEMORY_BYTES: Partial<Record<MlWorkload, number>> = {
  [MlWorkload.PetRecognition]: 1024 ** 3,
};

/** Why a worker's reported GPU memory is too small for a workload, or null when it is not known to be. */
export const insufficientMemoryDetail = (
  destination: Pick<MlDestinationRow, 'name' | 'lastProbeHardware'>,
  workload: MlWorkload,
): string | null => {
  const required = ML_WORKLOAD_MIN_GPU_MEMORY_BYTES[workload];
  const gpus = destination.lastProbeHardware?.gpus ?? [];
  if (!required || gpus.length === 0) {
    return null;
  }
  const largest = Math.max(...gpus.map((gpu) => gpu.memoryTotalBytes));
  if (largest >= required) {
    return null;
  }
  const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
  return `${destination.name} has ${gib(largest)} GiB of GPU memory; ${workload} needs ${gib(required)} GiB`;
};

export type MlAdmissionInput = {
  destination: MlDestinationRow | undefined;
  workload: MlWorkload;
  endpoint: MlEndpoint | null;
  probe: MlEndpointProbe | null;
  /** Spend attributed to the destination inside the budget window, in USD. */
  spentUsd: number;
  /** FL-159: the catalogue model the request names, checked against Frameleaf Cloud's catalogue. */
  modelId?: string | null;
  /** FL-159: the hold a time-priced Frameleaf Cloud job needs from the AI Wallet, in USD. */
  holdUsd?: number | null;
};

export type MlAdmissionVerdict = { admitted: true } | { admitted: false; refusal: MlAdmissionRefusal; detail: string };

type Refused = Extract<MlAdmissionVerdict, { admitted: false }>;
const refuse = (refusal: MlAdmissionRefusal, detail: string): Refused => ({ admitted: false, refusal, detail });

/**
 * FL-159: the Frameleaf Cloud rules, checked once the destination is enabled, allowed the workload
 * and consented. Evaluated from the gateway's own report (`probe.cloud`), in the order a person can
 * act on: reachability, entitlement, consent version, catalogue model, wallet, then the daily cap.
 * Every outcome refuses this destination; none picks another one.
 */
const evaluateCloudAdmission = (
  destination: MlDestinationRow,
  workload: MlWorkload,
  probe: MlEndpointProbe | null,
  modelId: string | null | undefined,
  holdUsd: number | null | undefined,
): Refused | null => {
  const facts = probe?.cloud ?? null;
  if (!probe || !probe.reachable || !facts) {
    if (facts?.refusal) {
      return refuse(facts.refusal.refusal, `${destination.name}: ${facts.refusal.detail}`);
    }
    return refuse(
      MlAdmissionRefusal.CloudUnavailable,
      `${destination.name}: Frameleaf Cloud is not available${probe?.error ? ` (${probe.error})` : ''}`,
    );
  }
  if (facts.refusal) {
    return refuse(facts.refusal.refusal, `${destination.name}: ${facts.refusal.detail}`);
  }
  if (!facts.entitled) {
    return refuse(
      MlAdmissionRefusal.EntitlementMissing,
      `${destination.name}: the Frameleaf account has no cloud processing entitlement`,
    );
  }
  if (facts.consentRequiredVersion !== null && destination.consentVersion !== facts.consentRequiredVersion) {
    return refuse(
      MlAdmissionRefusal.ConsentVersionOutdated,
      `${destination.name}: consent ${destination.consentVersion ?? 'none'} was given, Frameleaf Cloud now requires ${facts.consentRequiredVersion}`,
    );
  }
  if (isLocalOnlyModel(modelId)) {
    return refuse(
      MlAdmissionRefusal.ModelMismatch,
      `${destination.name}: the model ${modelId} runs on this server only and is never sent to Frameleaf Cloud`,
    );
  }
  if (modelId && !facts.modelIds.includes(modelId)) {
    return refuse(
      MlAdmissionRefusal.ModelMismatch,
      `${destination.name}: the model ${modelId} is not in the Frameleaf Cloud catalogue any more`,
    );
  }
  const available = facts.balanceUsd - facts.heldUsd;
  if (facts.balanceUsd <= 0 || available <= 0) {
    return refuse(MlAdmissionRefusal.WalletInsufficient, `${destination.name}: the AI Wallet is empty`);
  }
  if (holdUsd !== null && holdUsd !== undefined && holdUsd > available) {
    return refuse(
      MlAdmissionRefusal.WalletInsufficient,
      `${destination.name}: this job needs ${holdUsd.toFixed(2)} USD held and the AI Wallet has ${available.toFixed(2)} USD available`,
    );
  }
  if (facts.dailyCapUsd !== null && facts.spentTodayUsd >= facts.dailyCapUsd) {
    return refuse(
      MlAdmissionRefusal.BudgetExceeded,
      `${destination.name}: today's AI Wallet limit of ${facts.dailyCapUsd.toFixed(2)} USD is reached`,
    );
  }
  if (!probe.workloads.includes(workload)) {
    return refuse(
      MlAdmissionRefusal.WorkloadNotServed,
      `${destination.name}: Frameleaf Cloud does not offer ${workload} to this account right now`,
    );
  }
  return null;
};

/**
 * The pure admission rule. Evaluated in order so the most fundamental problem is the one
 * reported: a missing destination is not also "unhealthy", and a destination without
 * consent is refused before any probe result is considered.
 */
export const evaluateAdmission = ({
  destination,
  workload,
  endpoint,
  probe,
  spentUsd,
  modelId,
  holdUsd,
}: MlAdmissionInput): MlAdmissionVerdict => {
  if (!destination) {
    return refuse(MlAdmissionRefusal.DestinationMissing, 'the destination does not exist');
  }
  if (!destination.enabled) {
    return refuse(MlAdmissionRefusal.DestinationDisabled, `${destination.name} is disabled`);
  }
  if (!destination.workloads.includes(workload)) {
    return refuse(MlAdmissionRefusal.WorkloadNotAllowed, `${destination.name} is not allowed to run ${workload}`);
  }
  const isCloud = destination.kind === MlDestinationKind.FrameleafCloud;
  if (isCloud && !FRAMELEAF_CLOUD_ML_WORKLOADS.includes(workload)) {
    return refuse(
      MlAdmissionRefusal.WorkloadNotAllowed,
      `${destination.name}: ${workload} never runs on Frameleaf Cloud`,
    );
  }
  if (
    isRestorationWorkload(workload) &&
    !mayMixRoles(destination.kind) &&
    mlWorkerRoleOf(destination.workloads) === MlWorkerRole.Mixed
  ) {
    return refuse(
      MlAdmissionRefusal.RoleConflict,
      `${destination.name} is also allowed library analysis; restoration runs only on a separate worker`,
    );
  }
  if (!hasRequiredConsent(destination)) {
    return refuse(
      MlAdmissionRefusal.ConsentMissing,
      `${destination.name} sends media off this network and has no recorded consent`,
    );
  }
  if (destination.budgetLimitUsd !== null && spentUsd >= destination.budgetLimitUsd) {
    return refuse(
      MlAdmissionRefusal.BudgetExceeded,
      `${destination.name} has spent ${spentUsd.toFixed(2)} USD of its ${destination.budgetLimitUsd.toFixed(2)} USD limit`,
    );
  }
  if (isCloud) {
    // The pre-flight (no probe yet) only settles the rules above; the cloud rules need its report.
    if (probe === null) {
      return refuse(MlAdmissionRefusal.DestinationUnhealthy, `${destination.name} has not been checked yet`);
    }
    return evaluateCloudAdmission(destination, workload, probe, modelId, holdUsd) ?? { admitted: true };
  }
  if (!endpoint) {
    return refuse(MlAdmissionRefusal.EndpointUnresolved, `${destination.name} has no URL`);
  }
  if (!probe || !probe.reachable) {
    return refuse(
      MlAdmissionRefusal.DestinationUnhealthy,
      `${destination.name} did not answer${probe?.error ? `: ${probe.error}` : ''}`,
    );
  }
  if (!probe.workloads.includes(workload)) {
    return refuse(
      MlAdmissionRefusal.WorkloadNotServed,
      `${destination.name} reports it does not serve ${workload}${probe.error ? ` (${probe.error})` : ''}`,
    );
  }
  const memory = insufficientMemoryDetail(destination, workload);
  if (memory) {
    return { admitted: false, refusal: MlAdmissionRefusal.InsufficientMemory, detail: memory };
  }
  return { admitted: true };
};

export const healthFromProbe = (probe: MlEndpointProbe): MlDestinationHealth =>
  probe.reachable && probe.error === null ? MlDestinationHealth.Healthy : MlDestinationHealth.Unhealthy;

export const summarizeProbe = (probe: MlEndpointProbe): string => {
  if (!probe.reachable) {
    return probe.error ? `Unreachable: ${probe.error}` : 'Unreachable';
  }
  if (probe.error) {
    return `Reachable, capabilities unavailable: ${probe.error}`;
  }
  const served = probe.workloads.length > 0 ? probe.workloads.join(', ') : 'no workloads';
  const acceleration = probe.hardware?.preferredAcceleration ?? 'unknown acceleration';
  return `Serves ${served}; ${acceleration}; ${probe.latencyMs} ms`;
};

const budgetWindowStart = () => new Date(Date.now() - ML_BUDGET_WINDOW_DAYS * 24 * 60 * 60 * 1000);

/**
 * Admit one request against one explicitly named destination, or refuse it.
 *
 * The probe is live (bounded by `ML_PROBE_FRESHNESS_MS`) so an endpoint that vanished since
 * the last periodic check is refused at admission rather than discovered mid-request. The
 * returned selection carries the accounting hook; the machine-learning repository calls it
 * once per request and the row lands in `ml_workload_accounting` for FL-115.
 */
export const selectMlDestination = async (
  { mlDestinationRepository, machineLearningRepository }: MlSelectionDeps,
  request: MlSelectionRequest,
): Promise<MlSelection> => {
  const destination = await mlDestinationRepository.getById(request.destinationId);
  if (!destination) {
    throw new MlDestinationNotFoundError(request.workload, request.destinationId);
  }

  const endpoint = resolveEndpoint(destination);
  // FL-159: a catalogue model is chosen per workload for Frameleaf Cloud only; other destinations never
  // consult the routes here, so a pinned plan keeps going to exactly the destination it pinned.
  const route =
    destination.kind === MlDestinationKind.FrameleafCloud
      ? await mlDestinationRepository.getRoute(request.workload)
      : undefined;
  const modelId = route?.destinationId === destination.id ? route.modelId : null;
  const spentUsd =
    destination.budgetLimitUsd === null
      ? 0
      : await mlDestinationRepository.getSpend(destination.id, budgetWindowStart());

  // Consent, allow-list and budget are decided before the network is touched, so a cloud
  // destination without consent is never even pinged with this request in hand.
  const preflight = evaluateAdmission({
    destination,
    workload: request.workload,
    endpoint,
    probe: null,
    spentUsd,
    modelId,
    holdUsd: request.holdUsd,
  });
  if (!preflight.admitted && preflight.refusal !== MlAdmissionRefusal.DestinationUnhealthy) {
    throw new MlDestinationRefusedError(preflight.refusal, request.workload, destination.id, preflight.detail);
  }

  const probe = await machineLearningRepository.probe(endpoint as MlEndpoint, { maxAgeMs: ML_PROBE_FRESHNESS_MS });
  await mlDestinationRepository.recordProbe(destination.id, {
    health: healthFromProbe(probe),
    summary: summarizeProbe(probe),
    workloads: probe.reachable ? probe.workloads : null,
    probedAt: probe.probedAt,
    ...(probe.cloud !== undefined && { cloud: probe.cloud }),
  });

  const verdict = evaluateAdmission({
    destination,
    workload: request.workload,
    endpoint,
    probe,
    spentUsd,
    modelId,
    holdUsd: request.holdUsd,
  });
  if (!verdict.admitted) {
    throw new MlDestinationRefusedError(verdict.refusal, request.workload, destination.id, verdict.detail);
  }

  const startedAt = new Date();
  return {
    destinationId: destination.id,
    kind: destination.kind,
    workload: request.workload,
    endpoint: endpoint as MlEndpoint,
    cloudModelId:
      destination.kind === MlDestinationKind.FrameleafCloud ? cloudModelFor(request.workload, modelId) : null,
    record: (usage: MlUsage) => {
      void mlDestinationRepository
        .recordAccounting({
          destinationId: destination.id,
          destinationKind: destination.kind,
          workload: request.workload,
          jobId: request.jobId ?? null,
          jobName: request.jobName ?? null,
          bytesSent: usage.bytesSent,
          bytesReceived: usage.bytesReceived,
          durationMs: usage.durationMs,
          outcome: usage.outcome,
          // Local and LAN work costs nothing measurable here; Frameleaf Cloud work is settled
          // later from its usage report (FL-159). Recording null keeps the row honest until then.
          costUsd: null,
          startedAt,
          finishedAt: new Date(startedAt.getTime() + usage.durationMs),
        })
        .catch(() => {
          // Accounting must never fail the inference that already happened.
        });
    },
  };
};

/**
 * The destination the administrator routed a library workload to. Missing route: refusal.
 * This is how face, CLIP, OCR and enrichment jobs name their destination; the route is
 * explicit configuration, not a search.
 */
export const routedMlDestinationId = async (
  mlDestinationRepository: MlDestinationRepository,
  workload: MlWorkload,
): Promise<string> => {
  const route = await mlDestinationRepository.getRoute(workload);
  if (!route) {
    throw new MlDestinationRefusedError(
      MlAdmissionRefusal.WorkloadNotRouted,
      workload,
      null,
      `no destination is routed for ${workload}; choose one under Processing destinations`,
    );
  }
  return route.destinationId;
};
