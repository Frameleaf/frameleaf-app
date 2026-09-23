import {
  MlAdmissionRefusal,
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkerRole,
  MlWorkload,
  type MlDestinationResponseDto,
} from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  canRouteTo,
  formatThroughput,
  isConsentBlocking,
  isOverBudget,
  ML_WORKLOAD_ORDER,
  mlDestinationKindLabelKey,
  mlHealthTone,
  mlRefusalLabelKey,
  mlWorkloadLabelKey,
  parseOptionalNumber,
  routableDestinations,
  workloadBlockedInDraft,
  workloadsForKind,
} from '$lib/frameleaf/ml-destinations';

const destination = (overrides: Partial<MlDestinationResponseDto> = {}): MlDestinationResponseDto => ({
  id: 'local',
  kind: MlDestinationKind.Local,
  name: 'This server',
  url: 'http://immich-machine-learning:3003',
  authTokenConfigured: false,
  enabled: true,
  workloads: [MlWorkload.Face, MlWorkload.Clip],
  role: MlWorkerRole.LibraryAnalysis,
  sharesLibraryHardware: false,
  consent: { required: false, acknowledgedAt: null, acknowledgedBy: null },
  costControls: {
    budgetLimitUsd: null,
    maxRuntimeMinutes: null,
    maxUploadBytes: null,
    spentUsd: 0,
    budgetWindowDays: 30,
  },
  health: { status: MlDestinationHealth.Healthy, probedAt: null, summary: null, servedWorkloads: null },
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
  ...overrides,
});

const runPod = (acknowledgedAt: string | null) =>
  destination({
    id: 'runpod',
    kind: MlDestinationKind.RunPod,
    name: 'RunPod',
    url: null,
    workloads: [MlWorkload.Face, MlWorkload.Enrichment],
    consent: { required: true, acknowledgedAt, acknowledgedBy: acknowledgedAt ? 'admin' : null },
  });

/** The persistent RunPod restoration worker (FL-72). */
const runPodVideo = (acknowledgedAt: string | null) =>
  destination({
    id: 'runpod-video',
    kind: MlDestinationKind.RunPodVideo,
    name: 'RunPod video worker',
    url: 'https://video-worker.proxy.runpod.net',
    workloads: [MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative],
    role: MlWorkerRole.Restoration,
    consent: { required: true, acknowledgedAt, acknowledgedBy: acknowledgedAt ? 'admin' : null },
  });

describe('ml-destinations presentation rules (FL-110)', () => {
  it('lists every workload once, library work first', () => {
    expect(ML_WORKLOAD_ORDER).toHaveLength(Object.values(MlWorkload).length);
    expect(new Set(ML_WORKLOAD_ORDER).size).toBe(ML_WORKLOAD_ORDER.length);
    expect(ML_WORKLOAD_ORDER[0]).toBe(MlWorkload.Face);
    expect(ML_WORKLOAD_ORDER.at(-1)).toBe(MlWorkload.StudioAi);
  });

  it('has a label key for every workload and refusal', () => {
    for (const workload of Object.values(MlWorkload)) {
      expect(mlWorkloadLabelKey(workload)).toMatch(/^admin\.frameleaf_ml_workload_/);
    }
    for (const refusal of Object.values(MlAdmissionRefusal)) {
      expect(mlRefusalLabelKey(refusal)).toMatch(/^admin\.frameleaf_ml_refusal_/);
    }
  });

  it('treats an unconsented cloud destination as blocked and a local one as never needing consent', () => {
    expect(isConsentBlocking(runPod(null))).toBe(true);
    expect(isConsentBlocking(runPod('2026-09-22T00:00:00.000Z'))).toBe(false);
    expect(isConsentBlocking(destination())).toBe(false);
  });

  it('offers a route only where the server would accept it', () => {
    const local = destination();
    expect(canRouteTo(local, MlWorkload.Face)).toBe(true);
    expect(canRouteTo(local, MlWorkload.Ocr)).toBe(false);
    expect(canRouteTo(destination({ enabled: false }), MlWorkload.Face)).toBe(false);
    expect(canRouteTo(runPod(null), MlWorkload.Face)).toBe(false);
    expect(canRouteTo(runPod('2026-09-22T00:00:00.000Z'), MlWorkload.Face)).toBe(true);
  });

  it('never lists a cloud destination without consent as routable, even when it is the only one', () => {
    expect(routableDestinations([runPodVideo(null)], MlWorkload.RestorationFaithful)).toEqual([]);
    const consented = runPodVideo('2026-09-22T00:00:00.000Z');
    expect(routableDestinations([destination(), consented], MlWorkload.RestorationFaithful)).toEqual([consented]);
  });

  it('marks a destination over budget only at or past its limit', () => {
    const limited = (spentUsd: number, budgetLimitUsd: number | null) =>
      destination({
        costControls: { budgetLimitUsd, maxRuntimeMinutes: null, maxUploadBytes: null, spentUsd, budgetWindowDays: 30 },
      });
    expect(isOverBudget(limited(24.99, 25))).toBe(false);
    expect(isOverBudget(limited(25, 25))).toBe(true);
    expect(isOverBudget(limited(999, null))).toBe(false);
  });

  it('maps health to a status tone', () => {
    expect(mlHealthTone(MlDestinationHealth.Healthy)).toBe('teal');
    expect(mlHealthTone(MlDestinationHealth.Unhealthy)).toBe('danger');
    expect(mlHealthTone(MlDestinationHealth.Unknown)).toBe('neutral');
  });

  it('shows a measured throughput and nothing when there is no measurement', () => {
    expect(formatThroughput(null, 'en')).toBeNull();
    expect(formatThroughput(0, 'en')).toBeNull();
    expect(formatThroughput(1536, 'en')).toBe('1.5 KB/s');
    expect(formatThroughput(12_500_000, 'en')).toBe('12.5 MB/s');
    expect(formatThroughput(250_000_000, 'en')).toBe('250 MB/s');
  });

  it('parses optional limits: empty is no limit, garbage is rejected', () => {
    expect(parseOptionalNumber('')).toBeNull();
    expect(parseOptionalNumber('  ')).toBeNull();
    expect(parseOptionalNumber('25')).toBe(25);
    expect(parseOptionalNumber('-1')).toBeUndefined();
    expect(parseOptionalNumber('abc')).toBeUndefined();
  });

  it('labels every destination kind, the RunPod video worker included', () => {
    for (const kind of Object.values(MlDestinationKind)) {
      expect(mlDestinationKindLabelKey(kind)).toMatch(/^admin\.frameleaf_ml_destination_kind_/);
    }
  });
});

describe('separate library-analysis and restoration workers (FL-72)', () => {
  it('never offers restoration on the managed RunPod pod or on a worker that also runs library analysis', () => {
    const legacyPod = destination({
      ...runPod('2026-09-22T00:00:00.000Z'),
      workloads: [MlWorkload.RestorationFaithful],
      role: MlWorkerRole.Restoration,
    });
    expect(canRouteTo(legacyPod, MlWorkload.RestorationFaithful)).toBe(false);

    const mixed = destination({
      workloads: [MlWorkload.Face, MlWorkload.RestorationFaithful],
      role: MlWorkerRole.Mixed,
    });
    expect(canRouteTo(mixed, MlWorkload.RestorationFaithful)).toBe(false);
    expect(canRouteTo(mixed, MlWorkload.Face)).toBe(true);

    expect(canRouteTo(runPodVideo('2026-09-22T00:00:00.000Z'), MlWorkload.RestorationCreative)).toBe(true);
  });

  it('offers each kind only the work it may run', () => {
    expect(workloadsForKind(MlDestinationKind.RunPod)).not.toContain(MlWorkload.RestorationFaithful);
    expect(workloadsForKind(MlDestinationKind.RunPod)).toContain(MlWorkload.Enrichment);
    expect(workloadsForKind(MlDestinationKind.RunPodVideo)).toEqual([
      MlWorkload.RestorationFaithful,
      MlWorkload.RestorationCreative,
    ]);
    expect(workloadsForKind(MlDestinationKind.Lan)).toEqual([...ML_WORKLOAD_ORDER]);
  });

  it('closes restoration once library work is ticked, and the reverse', () => {
    const lan = MlDestinationKind.Lan;
    expect(workloadBlockedInDraft(lan, [MlWorkload.Face], MlWorkload.RestorationFaithful)).toBe(true);
    expect(workloadBlockedInDraft(lan, [MlWorkload.Face], MlWorkload.Clip)).toBe(false);
    expect(workloadBlockedInDraft(lan, [MlWorkload.RestorationCreative], MlWorkload.Ocr)).toBe(true);
    expect(workloadBlockedInDraft(lan, [MlWorkload.RestorationCreative], MlWorkload.StudioAi)).toBe(false);
    // Unticking stays possible on a row saved before the rule.
    expect(
      workloadBlockedInDraft(lan, [MlWorkload.Face, MlWorkload.RestorationFaithful], MlWorkload.RestorationFaithful),
    ).toBe(false);
    expect(workloadBlockedInDraft(MlDestinationKind.RunPod, [], MlWorkload.RestorationCreative)).toBe(true);
  });
});
