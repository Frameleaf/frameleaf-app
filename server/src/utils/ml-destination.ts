import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { MlProbeHardware } from 'src/schema/tables/ml-destination.table.js';
import {
  CLOUD_ML_DESTINATION_KINDS,
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
  ML_PROBE_FRESHNESS_MS,
  MachineLearningRepository,
  MlEndpoint,
  MlEndpointProbe,
  MlSelection,
  MlUsage,
  sameEndpoint,
} from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository, MlDestinationRow } from 'src/repositories/ml-destination.repository.js';

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
 * Resolve where a destination row actually points. Local, LAN and RunPod video rows carry
 * their URL; RunPod rows resolve to whatever the RunPod state machine has published, and
 * resolve to nothing while no pod or serverless worker is ready. A RunPod video row never
 * resolves to the library-analysis pod (FL-72).
 */
export const resolveEndpoint = (
  destination: Pick<MlDestinationRow, 'kind' | 'url' | 'authToken'>,
  runPodEndpoint: MlEndpoint | null,
): MlEndpoint | null => {
  if (destination.kind === MlDestinationKind.RunPod) {
    return runPodEndpoint;
  }
  if (!destination.url) {
    return null;
  }
  return destination.authToken ? { url: destination.url, authToken: destination.authToken } : { url: destination.url };
};

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
 * - Library analysis and restoration never share a worker, so a long restoration cannot hold
 *   the hardware library analysis needs.
 * - The managed RunPod pod runs the ordinary `/predict` image: it is a library-analysis worker
 *   and is never offered for restoration.
 * - A RunPod video worker exists only for restoration.
 */
export const workloadPolicyProblem = (kind: MlDestinationKind, workloads: readonly MlWorkload[]): string | null => {
  const role = mlWorkerRoleOf(workloads);
  if (role === MlWorkerRole.Mixed) {
    return 'A worker runs library analysis or restoration, not both; add the restoration worker as its own destination';
  }
  if (kind === MlDestinationKind.RunPod && workloads.some((workload) => isRestorationWorkload(workload))) {
    return 'The managed RunPod pod runs library analysis only; add a RunPod video worker for restoration';
  }
  if (kind === MlDestinationKind.RunPodVideo && workloads.some((workload) => !isRestorationWorkload(workload))) {
    return 'A RunPod video worker runs restoration only';
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
  { mlDestinationRepository, machineLearningRepository }: MlSelectionDeps,
  destination: MlDestinationRow,
  workload: MlWorkload,
): Promise<string | null> => {
  if (!isRestorationWorkload(workload)) {
    return null;
  }
  if (destination.kind === MlDestinationKind.RunPod) {
    return `${destination.name} is the library-analysis pod; restoration runs on a RunPod video worker`;
  }
  if (mlWorkerRoleOf(destination.workloads) === MlWorkerRole.Mixed) {
    return `${destination.name} is also allowed library analysis; restoration runs only on a separate worker`;
  }
  const runPodEndpoint = machineLearningRepository.getRunPodEndpoint();
  const endpoint = resolveEndpoint(destination, runPodEndpoint);
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
    const routedEndpoint = routed ? resolveEndpoint(routed, runPodEndpoint) : null;
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
  row: Pick<MlDestinationRow, 'lastProbeAt' | 'lastProbeHealth' | 'lastProbeWorkloads' | 'lastProbeSummary'>,
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
};

export type MlAdmissionVerdict = { admitted: true } | { admitted: false; refusal: MlAdmissionRefusal; detail: string };

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
}: MlAdmissionInput): MlAdmissionVerdict => {
  if (!destination) {
    return {
      admitted: false,
      refusal: MlAdmissionRefusal.DestinationMissing,
      detail: 'the destination does not exist',
    };
  }
  if (!destination.enabled) {
    return {
      admitted: false,
      refusal: MlAdmissionRefusal.DestinationDisabled,
      detail: `${destination.name} is disabled`,
    };
  }
  if (!destination.workloads.includes(workload)) {
    return {
      admitted: false,
      refusal: MlAdmissionRefusal.WorkloadNotAllowed,
      detail: `${destination.name} is not allowed to run ${workload}`,
    };
  }
  if (isRestorationWorkload(workload) && destination.kind === MlDestinationKind.RunPod) {
    return {
      admitted: false,
      refusal: MlAdmissionRefusal.RoleConflict,
      detail: `${destination.name} is the library-analysis pod; restoration runs on a RunPod video worker`,
    };
  }
  if (isRestorationWorkload(workload) && mlWorkerRoleOf(destination.workloads) === MlWorkerRole.Mixed) {
    return {
      admitted: false,
      refusal: MlAdmissionRefusal.RoleConflict,
      detail: `${destination.name} is also allowed library analysis; restoration runs only on a separate worker`,
    };
  }
  if (!hasRequiredConsent(destination)) {
    return {
      admitted: false,
      refusal: MlAdmissionRefusal.ConsentMissing,
      detail: `${destination.name} sends media off this network and has no recorded consent`,
    };
  }
  if (destination.budgetLimitUsd !== null && spentUsd >= destination.budgetLimitUsd) {
    return {
      admitted: false,
      refusal: MlAdmissionRefusal.BudgetExceeded,
      detail: `${destination.name} has spent ${spentUsd.toFixed(2)} USD of its ${destination.budgetLimitUsd.toFixed(2)} USD limit`,
    };
  }
  if (!endpoint) {
    return {
      admitted: false,
      refusal: MlAdmissionRefusal.EndpointUnresolved,
      detail:
        destination.kind === MlDestinationKind.RunPod
          ? `${destination.name} has no running pod or ready serverless worker`
          : `${destination.name} has no URL`,
    };
  }
  if (!probe || !probe.reachable) {
    return {
      admitted: false,
      refusal: MlAdmissionRefusal.DestinationUnhealthy,
      detail: `${destination.name} did not answer${probe?.error ? `: ${probe.error}` : ''}`,
    };
  }
  if (!probe.workloads.includes(workload)) {
    return {
      admitted: false,
      refusal: MlAdmissionRefusal.WorkloadNotServed,
      detail: `${destination.name} reports it does not serve ${workload}${probe.error ? ` (${probe.error})` : ''}`,
    };
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

  const endpoint = resolveEndpoint(destination, machineLearningRepository.getRunPodEndpoint());
  const spentUsd =
    destination.budgetLimitUsd === null
      ? 0
      : await mlDestinationRepository.getSpend(destination.id, budgetWindowStart());

  // Consent, allow-list and budget are decided before the network is touched, so a cloud
  // destination without consent is never even pinged with this request in hand.
  const preflight = evaluateAdmission({ destination, workload: request.workload, endpoint, probe: null, spentUsd });
  if (!preflight.admitted && preflight.refusal !== MlAdmissionRefusal.DestinationUnhealthy) {
    throw new MlDestinationRefusedError(preflight.refusal, request.workload, destination.id, preflight.detail);
  }

  let probe = await machineLearningRepository.probe(endpoint as MlEndpoint, { maxAgeMs: ML_PROBE_FRESHNESS_MS });
  // The RunPod endpoint can be republished or withdrawn while the spend lookup and the probe
  // wait; admit only against the endpoint that is still current.
  if (!sameEndpoint(resolveEndpoint(destination, machineLearningRepository.getRunPodEndpoint()), endpoint)) {
    probe = { ...probe, reachable: false, workloads: [], hardware: null, error: 'Endpoint configuration changed' };
  }
  await mlDestinationRepository.recordProbe(destination.id, {
    health: healthFromProbe(probe),
    summary: summarizeProbe(probe),
    workloads: probe.reachable ? probe.workloads : null,
    probedAt: probe.probedAt,
  });

  const verdict = evaluateAdmission({ destination, workload: request.workload, endpoint, probe, spentUsd });
  if (!verdict.admitted) {
    throw new MlDestinationRefusedError(verdict.refusal, request.workload, destination.id, verdict.detail);
  }

  const startedAt = new Date();
  return {
    destinationId: destination.id,
    kind: destination.kind,
    workload: request.workload,
    endpoint: endpoint as MlEndpoint,
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
          // Per-request cost needs the destination's hourly rate, which only the RunPod
          // state knows; FL-115 attributes it. Recording null keeps the row honest.
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
