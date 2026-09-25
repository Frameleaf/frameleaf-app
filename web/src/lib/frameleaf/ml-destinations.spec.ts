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
  isConsentOutdated,
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
  consent: { required: false, acknowledgedAt: null, acknowledgedBy: null, requiredVersion: null, version: null },
  cloud: null,
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

/** Frameleaf Cloud (FL-159): no URL or token, versioned consent, and it may mix roles. */
const cloud = (acknowledgedAt: string | null, version = '2026-10-01', requiredVersion = '2026-10-01') =>
  destination({
    id: 'cloud',
    kind: MlDestinationKind.FrameleafCloud,
    name: 'Frameleaf Cloud',
    url: null,
    workloads: [MlWorkload.Enrichment, MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative],
    role: MlWorkerRole.Mixed,
    consent: {
      required: true,
      acknowledgedAt,
      acknowledgedBy: acknowledgedAt ? 'admin' : null,
      requiredVersion,
      version: acknowledgedAt ? version : null,
    },
  });

/** A restoration worker on this network (FL-72). */
const restorationWorker = () =>
  destination({
    id: 'restoration',
    kind: MlDestinationKind.Lan,
    name: 'Restoration worker',
    url: 'http://restoration:3004',
    workloads: [MlWorkload.RestorationFaithful, MlWorkload.RestorationCreative],
    role: MlWorkerRole.Restoration,
  });

const AT = '2026-09-22T00:00:00.000Z';

describe('ml-destinations presentation rules (FL-110)', () => {
  it('lists every workload once, library work first', () => {
    expect(ML_WORKLOAD_ORDER).toHaveLength(Object.values(MlWorkload).length);
    expect(new Set(ML_WORKLOAD_ORDER).size).toBe(ML_WORKLOAD_ORDER.length);
    expect(ML_WORKLOAD_ORDER[0]).toBe(MlWorkload.Face);
    expect(ML_WORKLOAD_ORDER.at(-1)).toBe(MlWorkload.StudioRender);
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
    expect(isConsentBlocking(cloud(null))).toBe(true);
    expect(isConsentBlocking(cloud(AT))).toBe(false);
    expect(isConsentBlocking(destination())).toBe(false);
  });

  it('blocks Frameleaf Cloud when consent was given for an older version (FL-159)', () => {
    const outdated = cloud(AT, '2026-09-25', '2026-10-01');
    expect(isConsentOutdated(outdated)).toBe(true);
    expect(isConsentBlocking(outdated)).toBe(true);
    expect(canRouteTo(outdated, MlWorkload.Enrichment)).toBe(false);
    expect(isConsentOutdated(cloud(AT))).toBe(false);
    expect(isConsentOutdated(cloud(null))).toBe(false);
  });

  it('offers a route only where the server would accept it', () => {
    const local = destination();
    expect(canRouteTo(local, MlWorkload.Face)).toBe(true);
    expect(canRouteTo(local, MlWorkload.Ocr)).toBe(false);
    expect(canRouteTo(destination({ enabled: false }), MlWorkload.Face)).toBe(false);
    expect(canRouteTo(cloud(null), MlWorkload.Enrichment)).toBe(false);
    expect(canRouteTo(cloud(AT), MlWorkload.Enrichment)).toBe(true);
    expect(canRouteTo(cloud(AT), MlWorkload.Face)).toBe(false);
  });

  it('never lists a cloud destination without consent as routable, even when it is the only one', () => {
    expect(routableDestinations([cloud(null)], MlWorkload.RestorationFaithful)).toEqual([]);
    const consented = cloud(AT);
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

  it('labels every destination kind, Frameleaf Cloud included', () => {
    for (const kind of Object.values(MlDestinationKind)) {
      expect(mlDestinationKindLabelKey(kind)).toMatch(/^admin\.frameleaf_ml_destination_kind_/);
    }
  });
});

describe('separate library-analysis and restoration workers (FL-72)', () => {
  it('never offers restoration on a worker of this network that also runs library analysis', () => {
    const mixed = destination({
      workloads: [MlWorkload.Face, MlWorkload.RestorationFaithful],
      role: MlWorkerRole.Mixed,
    });
    expect(canRouteTo(mixed, MlWorkload.RestorationFaithful)).toBe(false);
    expect(canRouteTo(mixed, MlWorkload.Face)).toBe(true);

    expect(canRouteTo(restorationWorker(), MlWorkload.RestorationCreative)).toBe(true);
    // Frameleaf Cloud gives each job its own capacity, so it may run both (FL-159).
    expect(canRouteTo(cloud(AT), MlWorkload.RestorationCreative)).toBe(true);
  });

  it('offers each kind only the work it may run', () => {
    expect(workloadsForKind(MlDestinationKind.FrameleafCloud)).toEqual([
      MlWorkload.Enrichment,
      MlWorkload.RestorationFaithful,
      MlWorkload.RestorationCreative,
      MlWorkload.StudioAi,
      MlWorkload.Upscale,
      MlWorkload.Interpolation,
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
    // Frameleaf Cloud never offers faces, search or text recognition, and may mix roles.
    const cloudKind = MlDestinationKind.FrameleafCloud;
    expect(workloadBlockedInDraft(cloudKind, [], MlWorkload.Face)).toBe(true);
    expect(workloadBlockedInDraft(cloudKind, [MlWorkload.Enrichment], MlWorkload.RestorationCreative)).toBe(false);
  });
});
