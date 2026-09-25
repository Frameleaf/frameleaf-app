import {
  MlDestinationKind,
  MlWorkerAcceleration,
  MlWorkerReadiness,
  MlWorkerRole,
  WorkerCredentialState,
  WorkerInventorySource,
  type WorkerInventoryEntryDto,
} from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  accelerationLabelKey,
  applyWorkerUrlChange,
  credentialLabelKey,
  formatGpuMemory,
  inventorySections,
  isStaleSnapshot,
  ML_ENDPOINT_LIMIT,
  normalizeWorkerUrl,
  readinessLabelKey,
  readinessTone,
  roleLabelKey,
  routedEntry,
  WORKER_INVENTORY_REFRESH_MS,
  WorkerUrlChangeError,
  workerTypeLabelKey,
  workerUrlProblemKey,
  type WorkerUrlProblem,
} from '$lib/frameleaf/worker-inventory';

const entry = (overrides: Partial<WorkerInventoryEntryDto> = {}): WorkerInventoryEntryDto => ({
  id: 'local',
  source: WorkerInventorySource.MlDestination,
  name: 'This server',
  kind: MlDestinationKind.Local,
  role: MlWorkerRole.LibraryAnalysis,
  url: 'http://immich-machine-learning:3003',
  configured: true,
  enabled: true,
  readiness: MlWorkerReadiness.ModelReady,
  acceleration: MlWorkerAcceleration.Unknown,
  gpus: [],
  gpuMemoryBytes: null,
  credential: WorkerCredentialState.None,
  leavesNetwork: false,
  consentGranted: true,
  allowedWorkloads: [],
  servedWorkloads: null,
  routedWorkloads: [],
  admission: [],
  renderKinds: [],
  sharesLibraryHardware: false,
  waitingForLibraryAnalysis: false,
  activeOperations: 0,
  queuedOperations: 0,
  maxConcurrentOperations: null,
  checkedAt: null,
  latencyMs: null,
  summary: null,
  ...overrides,
});

const problemOf = (run: () => unknown): WorkerUrlProblem | null => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof WorkerUrlChangeError ? error.problem : null;
  }
};

describe('the machine-learning URL list (prototype worker-settings rules)', () => {
  const urls = ['https://a.lan:3003', 'https://b.lan:3003'];

  it('accepts only HTTP(S) base URLs without credentials, query or fragment', () => {
    expect(normalizeWorkerUrl('http://machine-learning:3003/')).toBe('http://machine-learning:3003');
    expect(normalizeWorkerUrl('  https://gpu.example  ')).toBe('https://gpu.example');
    expect(normalizeWorkerUrl('ftp://gpu.lan')).toBeNull();
    expect(normalizeWorkerUrl('https://user:pass@gpu.lan')).toBeNull();
    expect(normalizeWorkerUrl('https://gpu.lan/?token=1')).toBeNull();
    expect(normalizeWorkerUrl('https://gpu.lan/#x')).toBeNull();
    expect(normalizeWorkerUrl('')).toBeNull();
    expect(normalizeWorkerUrl(42)).toBeNull();
  });

  it('adds, edits, moves and removes against the current list', () => {
    expect(applyWorkerUrlChange(urls, { kind: 'add', url: 'https://c.lan:3003/' })).toEqual([
      ...urls,
      'https://c.lan:3003',
    ]);
    expect(applyWorkerUrlChange(urls, { kind: 'edit', original: urls[1], url: 'https://d.lan:3003' })).toEqual([
      urls[0],
      'https://d.lan:3003',
    ]);
    expect(applyWorkerUrlChange(urls, { kind: 'move', original: urls[1], direction: -1 })).toEqual([urls[1], urls[0]]);
    expect(applyWorkerUrlChange(urls, { kind: 'remove', original: urls[0] })).toEqual([urls[1]]);
    // The input is never modified.
    expect(urls).toEqual(['https://a.lan:3003', 'https://b.lan:3003']);
  });

  it('refuses a change to an endpoint that changed elsewhere', () => {
    expect(problemOf(() => applyWorkerUrlChange(urls, { kind: 'remove', original: 'https://gone.lan:3003' }))).toBe(
      'changed-elsewhere',
    );
  });

  it('keeps at least one endpoint, refuses duplicates and moves past the ends', () => {
    expect(problemOf(() => applyWorkerUrlChange([urls[0]], { kind: 'remove', original: urls[0] }))).toBe('keep-one');
    expect(problemOf(() => applyWorkerUrlChange(urls, { kind: 'add', url: 'https://a.lan:3003/' }))).toBe('duplicate');
    expect(problemOf(() => applyWorkerUrlChange(urls, { kind: 'move', original: urls[0], direction: -1 }))).toBe(
      'cannot-move',
    );
    expect(problemOf(() => applyWorkerUrlChange(urls, { kind: 'add', url: 'not a url' }))).toBe('invalid-url');
    // Editing an entry to its own address is not a duplicate.
    expect(applyWorkerUrlChange(urls, { kind: 'edit', original: urls[0], url: `${urls[0]}/` })).toEqual(urls);
  });

  it('supports up to the prototype limit', () => {
    const full = Array.from({ length: ML_ENDPOINT_LIMIT }, (_, i) => `http://w${i}.lan:3003`);
    expect(problemOf(() => applyWorkerUrlChange(full, { kind: 'add', url: 'https://extra.lan:3003' }))).toBe('limit');
  });

  it('has a message for every refusal', () => {
    for (const problem of [
      'changed-elsewhere',
      'keep-one',
      'cannot-move',
      'invalid-url',
      'duplicate',
      'limit',
    ] as const) {
      expect(workerUrlProblemKey(problem)).toMatch(/^admin\.frameleaf_workers_problem_/);
    }
  });
});

describe('inventory sections (FL-72)', () => {
  const inventory = {
    configuredUrls: ['http://immich-machine-learning:3003', 'http://second:3003'],
    entries: [
      entry(),
      entry({ id: 'old', url: 'http://removed:3003', configured: false }),
      entry({ id: 'lan', kind: MlDestinationKind.Lan, url: 'https://study.lan:3003' }),
      // Frameleaf Cloud may run library and restoration work together; it is listed with library workers.
      entry({
        id: 'pod',
        kind: MlDestinationKind.FrameleafCloud,
        role: MlWorkerRole.Mixed,
        url: null,
        leavesNetwork: true,
      }),
      entry({
        id: 'restore',
        kind: MlDestinationKind.Lan,
        role: MlWorkerRole.Restoration,
        url: 'https://gpu.lan:3004',
      }),
      entry({
        id: 'video',
        kind: MlDestinationKind.Lan,
        role: MlWorkerRole.Restoration,
        url: 'https://video.lan:3004',
      }),
      entry({ id: 'both', kind: MlDestinationKind.Lan, role: MlWorkerRole.Mixed }),
      entry({ id: 'render', source: WorkerInventorySource.RenderWorker, kind: 'lan', role: null, url: null }),
    ],
  };

  it('pairs each configured URL with its destination, in list order, and drops nothing', () => {
    const sections = inventorySections(inventory);

    expect(sections.endpoints.map(({ index, url, entry }) => [index, url, entry?.id ?? null])).toEqual([
      [0, 'http://immich-machine-learning:3003', 'local'],
      [1, 'http://second:3003', null],
    ]);
    expect(sections.libraryWorkers.map(({ id }) => id)).toEqual(['old', 'lan', 'pod']);
    expect(sections.restorationWorkers.map(({ id }) => id)).toEqual(['restore', 'video']);
    expect(sections.mixedWorkers.map(({ id }) => id)).toEqual(['both']);
    expect(sections.renderWorkers.map(({ id }) => id)).toEqual(['render']);
  });

  it('finds the destination a library route names, or none', () => {
    expect(routedEntry(inventory, 'pod')?.leavesNetwork).toBe(true);
    expect(routedEntry(inventory, null)).toBeNull();
    expect(routedEntry(inventory, 'missing')).toBeNull();
  });
});

describe('labels (FL-72)', () => {
  it('names every state, and render workers by check-in', () => {
    for (const readiness of Object.values(MlWorkerReadiness)) {
      expect(readinessLabelKey({ readiness, source: WorkerInventorySource.MlDestination })).toMatch(
        /^admin\.frameleaf_workers_state_/,
      );
      expect(readinessTone(readiness)).toBeTruthy();
    }
    expect(
      readinessLabelKey({ readiness: MlWorkerReadiness.ModelReady, source: WorkerInventorySource.RenderWorker }),
    ).toBe('admin.frameleaf_workers_state_checked_in');
    expect(readinessLabelKey({ readiness: MlWorkerReadiness.Cpu, source: WorkerInventorySource.MlDestination })).toBe(
      'admin.frameleaf_workers_state_cpu',
    );
  });

  it('never shows an unknown state as ready', () => {
    expect(readinessTone(MlWorkerReadiness.Unknown)).toBe('neutral');
    expect(readinessTone(MlWorkerReadiness.Unreachable)).toBe('danger');
    expect(readinessTone(MlWorkerReadiness.ModelReady)).toBe('teal');
  });

  it('labels acceleration, credentials, roles and worker types', () => {
    for (const acceleration of Object.values(MlWorkerAcceleration)) {
      expect(accelerationLabelKey(acceleration)).toMatch(/^admin\.frameleaf_workers_acceleration_/);
    }
    for (const credential of Object.values(WorkerCredentialState)) {
      expect(credentialLabelKey(credential)).toMatch(/^admin\.frameleaf_workers_credential_/);
    }
    for (const role of Object.values(MlWorkerRole)) {
      expect(roleLabelKey(role)).toMatch(/^admin\.frameleaf_ml_role_/);
    }
    expect(workerTypeLabelKey(entry())).toBe('admin.frameleaf_workers_type_ml');
    expect(workerTypeLabelKey(entry({ role: MlWorkerRole.Restoration }))).toBe(
      'admin.frameleaf_workers_type_restoration',
    );
    expect(workerTypeLabelKey(entry({ source: WorkerInventorySource.RenderWorker, role: null }))).toBe(
      'admin.frameleaf_workers_type_render',
    );
  });

  it('formats GPU memory and says nothing when it is unknown', () => {
    expect(formatGpuMemory(17_179_869_184, 'en')).toBe('16 GiB');
    expect(formatGpuMemory(null, 'en')).toBeNull();
    expect(formatGpuMemory(0, 'en')).toBeNull();
  });

  it('calls a snapshot stale after two missed refreshes', () => {
    const checkedAt = '2026-09-23T10:00:00.000Z';
    const at = new Date(checkedAt).getTime();
    expect(isStaleSnapshot(checkedAt, at + WORKER_INVENTORY_REFRESH_MS)).toBe(false);
    expect(isStaleSnapshot(checkedAt, at + WORKER_INVENTORY_REFRESH_MS * 2 + 1)).toBe(true);
  });
});
