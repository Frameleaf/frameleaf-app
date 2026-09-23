import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  CLOUD_ML_DESTINATION_KINDS,
  MlAdmissionRefusal,
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkload,
} from 'src/enum.js';
import {
  MachineLearningRepository,
  ML_PROBE_FRESHNESS_MS,
  MlEndpoint,
  MlEndpointProbe,
  MlSelection,
  MlUsage,
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
 * Resolve where a destination row actually points. Local and LAN rows carry their URL;
 * RunPod rows resolve to whatever the RunPod state machine has published, and resolve to
 * nothing while no pod or serverless worker is ready.
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

export type MlAdmissionInput = {
  destination: MlDestinationRow | undefined;
  workload: MlWorkload;
  endpoint: MlEndpoint | null;
  probe: MlEndpointProbe | null;
  /** Spend attributed to the destination inside the budget window, in USD. */
  spentUsd: number;
};

export type MlAdmissionVerdict =
  | { admitted: true }
  | { admitted: false; refusal: MlAdmissionRefusal; detail: string };

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
    return { admitted: false, refusal: MlAdmissionRefusal.DestinationMissing, detail: 'the destination does not exist' };
  }
  if (!destination.enabled) {
    return { admitted: false, refusal: MlAdmissionRefusal.DestinationDisabled, detail: `${destination.name} is disabled` };
  }
  if (!destination.workloads.includes(workload)) {
    return {
      admitted: false,
      refusal: MlAdmissionRefusal.WorkloadNotAllowed,
      detail: `${destination.name} is not allowed to run ${workload}`,
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

  const probe = await machineLearningRepository.probe(endpoint as MlEndpoint, { maxAgeMs: ML_PROBE_FRESHNESS_MS });
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
