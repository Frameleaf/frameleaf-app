import {
  MediaOperationDestination,
  MediaOperationKind,
  RenderWorkerAuditEvent,
  RenderWorkerRefusalReason,
  RenderWorkerStatus,
  type RenderWorkerDto,
} from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKER_FORM,
  RENDER_WORKER_KINDS,
  RENDER_WORKER_QUERY_MAX_LENGTH,
  RENDER_WORKER_UNREACHABLE_MS,
  auditDetailEntries,
  auditEventIsRefusal,
  auditEventKey,
  bytesToGiB,
  destinationKey,
  filterWorkers,
  gibToBytes,
  isRenderWorkerKind,
  limitFormFrom,
  minutesToMs,
  msToMinutes,
  normalizeWorkerQuery,
  operationKindKey,
  parseLimitForm,
  parseWorkerForm,
  refusalReasonKey,
  sortWorkers,
  workerFormFrom,
  workerHealth,
  workerHealthKey,
  type RenderWorkerRow,
} from '$lib/frameleaf/render-workers';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const worker = (overrides: Partial<RenderWorkerRow> & Pick<RenderWorkerRow, 'id' | 'name'>): RenderWorkerRow => ({
  destination: MediaOperationDestination.Lan,
  status: RenderWorkerStatus.Active,
  kinds: [MediaOperationKind.StudioExport],
  activeOperations: 0,
  maxConcurrentOperations: 2,
  lastSeenAt: minutesAgo(1),
  lastAdmittedAt: minutesAgo(60),
  engineDigest: 'engine-1',
  ...overrides,
});

describe('workerHealth', () => {
  it('reads revoked before anything else', () => {
    expect(
      workerHealth(worker({ id: 'a', name: 'A', status: RenderWorkerStatus.Revoked, activeOperations: 3 }), NOW),
    ).toBe('revoked');
  });

  it('distinguishes a worker that was never admitted from one that went quiet', () => {
    expect(workerHealth(worker({ id: 'a', name: 'A', lastAdmittedAt: null, lastSeenAt: null }), NOW)).toBe(
      'never_admitted',
    );
    const quietFor = RENDER_WORKER_UNREACHABLE_MS / 60_000 + 1;
    expect(workerHealth(worker({ id: 'a', name: 'A', lastSeenAt: minutesAgo(quietFor) }), NOW)).toBe('unreachable');
    expect(workerHealth(worker({ id: 'a', name: 'A', lastSeenAt: 'not a date' }), NOW)).toBe('unreachable');
  });

  it('reads busy only when the worker holds an operation', () => {
    expect(workerHealth(worker({ id: 'a', name: 'A', activeOperations: 1 }), NOW)).toBe('busy');
    expect(workerHealth(worker({ id: 'a', name: 'A' }), NOW)).toBe('ready');
  });
});

describe('filterWorkers and sortWorkers', () => {
  const basement = worker({ id: 'w-1', name: 'Basement GPU' });
  const attic = worker({ id: 'w-2', name: 'attic gpu', destination: MediaOperationDestination.Runpod });
  const retired = worker({ id: 'w-3', name: 'Old box', status: RenderWorkerStatus.Revoked });

  it('hides revoked workers by default and can show only them', () => {
    expect(filterWorkers([basement, attic, retired], { filter: 'active' }).map((w) => w.id)).toEqual(['w-1', 'w-2']);
    expect(filterWorkers([basement, attic, retired], { filter: 'revoked' }).map((w) => w.id)).toEqual(['w-3']);
    expect(filterWorkers([basement, attic, retired], { filter: 'all' })).toHaveLength(3);
  });

  it('matches the name, the id and the engine digest, case-insensitively, and bounds the query', () => {
    expect(filterWorkers([basement, attic], { filter: 'all', query: '  ATTIC ' }).map((w) => w.id)).toEqual(['w-2']);
    expect(filterWorkers([basement, attic], { filter: 'all', query: 'w-1' }).map((w) => w.id)).toEqual(['w-1']);
    expect(filterWorkers([basement, attic], { filter: 'all', query: 'engine' })).toHaveLength(2);
    expect(normalizeWorkerQuery('x'.repeat(RENDER_WORKER_QUERY_MAX_LENGTH + 50))).toHaveLength(
      RENDER_WORKER_QUERY_MAX_LENGTH,
    );
  });

  it('narrows to one destination', () => {
    const runpod = filterWorkers([basement, attic], { filter: 'all', destination: MediaOperationDestination.Runpod });
    expect(runpod.map((w) => w.id)).toEqual(['w-2']);
  });

  it('sorts active workers first, then by name ignoring case', () => {
    expect(sortWorkers([retired, basement, attic]).map((w) => w.id)).toEqual(['w-2', 'w-1', 'w-3']);
  });
});

describe('vocabulary', () => {
  it('has a message for every server enum value', () => {
    for (const reason of Object.values(RenderWorkerRefusalReason)) {
      expect(refusalReasonKey[reason]).toMatch(/^frameleaf_render_workers_refusal_/);
    }
    for (const event of Object.values(RenderWorkerAuditEvent)) {
      expect(auditEventKey[event]).toMatch(/^frameleaf_render_workers_event_/);
    }
    for (const kind of Object.values(MediaOperationKind)) {
      expect(operationKindKey[kind]).toMatch(/^frameleaf_render_workers_kind_/);
    }
    for (const destination of Object.values(MediaOperationDestination)) {
      expect(destinationKey[destination]).toMatch(/^frameleaf_render_workers_destination_/);
    }
    expect(Object.keys(workerHealthKey).sort()).toEqual(['busy', 'never_admitted', 'ready', 'revoked', 'unreachable']);
  });

  it('offers a render worker only the render kinds, never server-side jobs (FL-73)', () => {
    expect([...RENDER_WORKER_KINDS].sort()).toEqual(
      [
        MediaOperationKind.QuickEdit,
        MediaOperationKind.Restoration,
        MediaOperationKind.RestorationPreview,
        MediaOperationKind.StudioExport,
        MediaOperationKind.StudioPreview,
      ].sort(),
    );
    for (const kind of [
      MediaOperationKind.Bulk,
      MediaOperationKind.StudioBundleExport,
      MediaOperationKind.StudioBundleImport,
      MediaOperationKind.EnrichmentPlan,
      MediaOperationKind.MediaHealth,
      MediaOperationKind.IcloudSync,
      MediaOperationKind.TakeoutImport,
      MediaOperationKind.PhysicalDeduplication,
    ]) {
      expect(isRenderWorkerKind(kind)).toBe(false);
    }
    expect(DEFAULT_WORKER_FORM.kinds.every((kind) => isRenderWorkerKind(kind))).toBe(true);
  });

  it('marks refusals and stops, not enrolment or admission', () => {
    expect(auditEventIsRefusal(RenderWorkerAuditEvent.Refused)).toBe(true);
    expect(auditEventIsRefusal(RenderWorkerAuditEvent.ClaimRefused)).toBe(true);
    expect(auditEventIsRefusal(RenderWorkerAuditEvent.LimitExceeded)).toBe(true);
    expect(auditEventIsRefusal(RenderWorkerAuditEvent.DeviceLost)).toBe(true);
    expect(auditEventIsRefusal(RenderWorkerAuditEvent.Admitted)).toBe(false);
    expect(auditEventIsRefusal(RenderWorkerAuditEvent.Enrolled)).toBe(false);
  });

  it('flattens audit detail without dropping nested refusal lists', () => {
    expect(
      auditDetailEntries({
        engineDigest: 'engine-1',
        gpuMemoryBytes: null,
        codecs: ['hevc', 'av1'],
        refused: [{ key: 'library-asset:clip-1', reason: 'no-access' }],
      }),
    ).toEqual([
      ['engineDigest', 'engine-1'],
      ['codecs', 'hevc, av1'],
      ['refused', '{"key":"library-asset:clip-1","reason":"no-access"}'],
    ]);
    expect(auditDetailEntries(null)).toEqual([]);
  });
});

describe('units', () => {
  it('converts ceilings between the wire and the form and back', () => {
    expect(msToMinutes('90000')).toBe(1.5);
    expect(minutesToMs(1.5)).toBe('90000');
    expect(bytesToGiB(String(2 * 1024 ** 3))).toBe(2);
    expect(gibToBytes(0.5)).toBe(String(512 * 1024 ** 2));
    expect(msToMinutes(null)).toBeNull();
    expect(bytesToGiB('')).toBeNull();
  });
});

describe('parseLimitForm', () => {
  const form = (overrides: Partial<{ concurrency: string; wallClockMinutes: string; outputGiB: string }>) => ({
    concurrency: '2',
    wallClockMinutes: '',
    outputGiB: '',
    ...overrides,
  });

  it('turns a filled form into wire values and blanks into no ceiling', () => {
    expect(parseLimitForm(form({ wallClockMinutes: '30' }), { minConcurrency: 0 })).toEqual({
      ok: true,
      value: { maxConcurrentOperations: 2, maxWallClockMs: '1800000', maxOutputBytes: null },
    });
  });

  it('lets an account be paused with zero but never a worker', () => {
    expect(parseLimitForm(form({ concurrency: '0' }), { minConcurrency: 0 }).ok).toBe(true);
    expect(parseLimitForm(form({ concurrency: '0' }), { minConcurrency: 1 })).toEqual({
      ok: false,
      field: 'concurrency',
    });
  });

  it('refuses the server-invalid values by field', () => {
    expect(parseLimitForm(form({ concurrency: '65' }), { minConcurrency: 0 })).toEqual({
      ok: false,
      field: 'concurrency',
    });
    expect(parseLimitForm(form({ concurrency: '1.5' }), { minConcurrency: 0 })).toEqual({
      ok: false,
      field: 'concurrency',
    });
    expect(parseLimitForm(form({ wallClockMinutes: '-5' }), { minConcurrency: 0 })).toEqual({
      ok: false,
      field: 'wallClockMinutes',
    });
    expect(parseLimitForm(form({ outputGiB: 'lots' }), { minConcurrency: 0 })).toEqual({
      ok: false,
      field: 'outputGiB',
    });
  });

  it('round-trips a stored limit into the form', () => {
    expect(limitFormFrom({ maxConcurrentOperations: 3, maxWallClockMs: '120000', maxOutputBytes: null })).toEqual({
      concurrency: '3',
      wallClockMinutes: '2',
      outputGiB: '',
    });
    expect(limitFormFrom(null)).toEqual({ concurrency: '', wallClockMinutes: '', outputGiB: '' });
  });
});

describe('parseWorkerForm', () => {
  const filled = {
    ...DEFAULT_WORKER_FORM,
    name: '  Basement GPU ',
    engineDigest: ' sha256:abc ',
    gpuMemoryGiB: '24',
    concurrency: '2',
  };

  it('drops kinds a render worker cannot take and refuses a scope with none left (FL-73)', () => {
    const parsed = parseWorkerForm({
      ...filled,
      kinds: [MediaOperationKind.Bulk, MediaOperationKind.QuickEdit, MediaOperationKind.MediaHealth],
    });
    expect(parsed.ok && parsed.value.kinds).toEqual([MediaOperationKind.QuickEdit]);
    expect(parseWorkerForm({ ...filled, kinds: [MediaOperationKind.EnrichmentPlan] })).toEqual({
      ok: false,
      field: 'kinds',
    });
  });

  it('produces the enrolment values the server expects', () => {
    expect(parseWorkerForm(filled)).toEqual({
      ok: true,
      value: {
        name: 'Basement GPU',
        destination: MediaOperationDestination.Lan,
        kinds: DEFAULT_WORKER_FORM.kinds,
        engineDigest: 'sha256:abc',
        conformanceMaxAgeMs: 24 * 60 * 60_000,
        gpuMemoryBytes: String(24 * 1024 ** 3),
        maxConcurrentOperations: 2,
        maxWallClockMs: null,
        maxOutputBytes: null,
      },
    });
  });

  it('treats a blank engine digest as "any engine" and a blank GPU figure as unknown', () => {
    const parsed = parseWorkerForm({ ...filled, engineDigest: '', gpuMemoryGiB: '' });
    expect(parsed.ok && parsed.value.engineDigest).toBeNull();
    expect(parsed.ok && parsed.value.gpuMemoryBytes).toBeNull();
  });

  it('refuses by field: empty name, no scopes, sub-minute evidence window, worker concurrency of zero', () => {
    expect(parseWorkerForm({ ...filled, name: ' '.repeat(3) })).toEqual({ ok: false, field: 'name' });
    expect(parseWorkerForm({ ...filled, kinds: [] })).toEqual({ ok: false, field: 'kinds' });
    expect(parseWorkerForm({ ...filled, conformanceMaxAgeHours: '0.01' })).toEqual({
      ok: false,
      field: 'conformanceMaxAgeHours',
    });
    expect(parseWorkerForm({ ...filled, concurrency: '0' })).toEqual({ ok: false, field: 'concurrency' });
  });

  it('loads an existing worker into the form with converted units', () => {
    const existing = {
      id: 'w-1',
      name: 'Attic',
      destination: MediaOperationDestination.Runpod,
      status: RenderWorkerStatus.Active,
      kinds: [MediaOperationKind.Restoration],
      engineDigest: null,
      conformanceMaxAgeMs: 2 * 60 * 60_000,
      maxConcurrentOperations: 1,
      maxWallClockMs: '600000',
      maxOutputBytes: String(10 * 1024 ** 3),
      gpuMemoryBytes: String(16 * 1024 ** 3),
      activeOperations: 0,
      lastAdmittedAt: null,
      lastSeenAt: null,
      revokedAt: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    } satisfies RenderWorkerDto;

    expect(workerFormFrom(existing)).toEqual({
      name: 'Attic',
      destination: MediaOperationDestination.Runpod,
      kinds: [MediaOperationKind.Restoration],
      engineDigest: '',
      conformanceMaxAgeHours: '2',
      gpuMemoryGiB: '16',
      concurrency: '1',
      wallClockMinutes: '10',
      outputGiB: '10',
    });
  });
});
