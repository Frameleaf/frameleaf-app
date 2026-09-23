import { MlDestinationHealth, MlDestinationKind, MlWorkload } from 'src/enum.js';
import type { MlEndpointProbe, MlSelection } from 'src/repositories/machine-learning.repository.js';
import type { MlDestinationRow } from 'src/repositories/ml-destination.repository.js';

const at = new Date('2026-09-22T12:00:00.000Z');

const row = (overrides: Partial<MlDestinationRow>): MlDestinationRow => ({
  id: 'ml-destination-local',
  kind: MlDestinationKind.Local,
  name: 'This server',
  url: 'http://immich-machine-learning:3003',
  authToken: null,
  enabled: true,
  workloads: [MlWorkload.Face, MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Enrichment],
  consentAcknowledgedAt: null,
  consentAcknowledgedBy: null,
  budgetLimitUsd: null,
  maxRuntimeMinutes: null,
  maxUploadBytes: null,
  lastProbeAt: at,
  lastProbeHealth: MlDestinationHealth.Healthy,
  lastProbeSummary: 'Serves face, clip, ocr, enrichment; auto; 12 ms',
  lastProbeWorkloads: [MlWorkload.Face, MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Enrichment],
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

export const mlDestinationStub = {
  local: row({}),
  lan: row({
    id: 'ml-destination-lan',
    kind: MlDestinationKind.Lan,
    name: 'Workshop GPU',
    url: 'http://workshop.lan:3003',
    authToken: 'lan-token',
    workloads: [MlWorkload.Face, MlWorkload.Clip, MlWorkload.RestorationFaithful],
    lastProbeWorkloads: [MlWorkload.Face, MlWorkload.Clip, MlWorkload.RestorationFaithful],
  }),
  runPod: row({
    id: 'ml-destination-runpod',
    kind: MlDestinationKind.RunPod,
    name: 'RunPod',
    url: null,
    workloads: [MlWorkload.Enrichment, MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative],
    budgetLimitUsd: 25,
    lastProbeHealth: MlDestinationHealth.Unknown,
    lastProbeAt: null,
    lastProbeSummary: null,
    lastProbeWorkloads: null,
  }),
  runPodConsented: row({
    id: 'ml-destination-runpod',
    kind: MlDestinationKind.RunPod,
    name: 'RunPod',
    url: null,
    workloads: [MlWorkload.Enrichment, MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative],
    budgetLimitUsd: 25,
    consentAcknowledgedAt: at,
    consentAcknowledgedBy: 'admin-id',
  }),
};

export const mlProbeStub = {
  healthy: {
    reachable: true,
    workloads: [MlWorkload.Face, MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Enrichment],
    hardware: null,
    latencyMs: 12,
    probedAt: at,
    error: null,
  } satisfies MlEndpointProbe,
  unreachable: {
    reachable: false,
    workloads: [],
    hardware: null,
    latencyMs: 2000,
    probedAt: at,
    error: 'fetch failed',
  } satisfies MlEndpointProbe,
  restoration: {
    reachable: true,
    workloads: [MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative],
    hardware: null,
    latencyMs: 40,
    probedAt: at,
    error: null,
  } satisfies MlEndpointProbe,
};

export const mlSelectionStub = (workload: MlWorkload, destination = mlDestinationStub.local): MlSelection => ({
  destinationId: destination.id,
  kind: destination.kind,
  workload,
  endpoint: { url: destination.url ?? 'http://immich-machine-learning:3003' },
  record: () => {},
});
