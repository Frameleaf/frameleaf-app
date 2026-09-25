import type { MlEndpointProbe, MlSelection } from 'src/repositories/machine-learning.repository.js';
import type { MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { MlDestinationHealth, MlDestinationKind, MlWorkload } from 'src/enum.js';

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
  lastProbeHardware: null,
  lastProbeLatencyMs: 12,
  sharesLibraryHardware: false,
  region: null,
  consentVersion: null,
  lastProbeCloud: null,
  createdAt: at,
  updatedAt: at,
  ...overrides,
});

export const mlDestinationStub = {
  local: row({}),
  /** The restoration worker on the home network (FL-114); since FL-72 it runs restoration only. */
  lan: row({
    id: 'ml-destination-lan',
    kind: MlDestinationKind.Lan,
    name: 'Workshop GPU',
    url: 'https://workshop.lan:3004',
    authToken: 'lan-token',
    workloads: [MlWorkload.RestorationFaithful],
    lastProbeWorkloads: [MlWorkload.RestorationFaithful],
  }),
  /** A `/predict` container on another machine: a library-analysis worker (FL-72). */
  libraryLan: row({
    id: 'ml-destination-library-lan',
    kind: MlDestinationKind.Lan,
    name: 'Study PC',
    url: 'https://study.lan:3003',
    authToken: null,
    workloads: [MlWorkload.Face, MlWorkload.Clip],
    lastProbeWorkloads: [MlWorkload.Face, MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Enrichment],
  }),
  /** Frameleaf Cloud (FL-159): no URL or token; created by an administrator, consent not yet given. */
  frameleafCloud: row({
    id: 'ml-destination-frameleaf-cloud',
    kind: MlDestinationKind.FrameleafCloud,
    name: 'Frameleaf Cloud',
    url: null,
    workloads: [MlWorkload.Enrichment, MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative],
    budgetLimitUsd: 25,
    region: 'eu',
    lastProbeHealth: MlDestinationHealth.Unknown,
    lastProbeAt: null,
    lastProbeSummary: null,
    lastProbeWorkloads: null,
  }),
  /** Frameleaf Cloud with consent to version 2026-09-25 and a healthy check (FL-159). */
  frameleafCloudConsented: row({
    id: 'ml-destination-frameleaf-cloud',
    kind: MlDestinationKind.FrameleafCloud,
    name: 'Frameleaf Cloud',
    url: null,
    workloads: [MlWorkload.Enrichment, MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative],
    budgetLimitUsd: 25,
    region: 'eu',
    consentAcknowledgedAt: at,
    consentAcknowledgedBy: 'admin-id',
    consentVersion: '2026-09-25',
    lastProbeWorkloads: [MlWorkload.Enrichment, MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative],
    lastProbeHardware: {
      preferredAcceleration: 'cuda',
      providers: ['CUDAExecutionProvider'],
      cudaDeviceCount: 1,
      gpus: [],
    },
    lastProbeCloud: {
      region: 'eu',
      consentRequiredVersion: '2026-09-25',
      consentRecordedVersion: '2026-09-25',
      features: { identityNames: false, medicalSignals: false, ocrAddon: false },
      entitled: true,
      balanceUsd: 40,
      heldUsd: 5,
      dailyCapUsd: null,
      spentTodayUsd: 0,
      limits: {},
      catalogEtag: 'catalog-1',
      modelIds: ['describe-large', 'restore-faithful'],
      refusal: null,
    },
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
  /** A healthy Frameleaf Cloud check (FL-159): entitled, consent 2026-09-25, 35 USD available. */
  frameleafCloud: {
    reachable: true,
    workloads: [MlWorkload.Enrichment, MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative],
    hardware: null,
    latencyMs: 80,
    probedAt: at,
    error: null,
    cloud: mlDestinationStub.frameleafCloudConsented.lastProbeCloud,
  } satisfies MlEndpointProbe,
};

export const mlSelectionStub = (workload: MlWorkload, destination = mlDestinationStub.local): MlSelection => ({
  destinationId: destination.id,
  kind: destination.kind,
  workload,
  endpoint: { url: destination.url ?? 'http://immich-machine-learning:3003' },
  record: () => {},
});
