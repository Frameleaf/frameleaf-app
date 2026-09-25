/**
 * Presentation rules for the Workers & endpoints inventory (FL-72).
 *
 * The server owns every fact: each worker's last check, what it may run, where library work is
 * routed and what admission would answer. This module groups those facts the way the
 * September 22 prototype's "Workers & endpoints" section shows them, turns states into labels,
 * and edits the machine-learning URL list with the prototype's rules (`worker-settings.mjs`).
 * It never contacts a worker and never picks a destination.
 */
import {
  MlDestinationKind,
  MlWorkerAcceleration,
  MlWorkerReadiness,
  MlWorkerRole,
  WorkerCredentialState,
  WorkerInventorySource,
  type WorkerInventoryEntryDto,
  type WorkerInventoryResponseDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';

/** The prototype supports up to 32 endpoints in the list. */
export const ML_ENDPOINT_LIMIT = 32;

/** How often the page reloads the inventory while it is open. */
export const WORKER_INVENTORY_REFRESH_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* Machine-learning URL list                                                   */
/* -------------------------------------------------------------------------- */

/**
 * An HTTP(S) base URL without credentials, query or fragment, with no trailing slash; null when
 * the value is not one. Same rule as the prototype's `normalizeWorkerUrl`.
 */
export const normalizeWorkerUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) {
    return null;
  }
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
};

export type WorkerUrlChange =
  | { kind: 'add'; url: string }
  | { kind: 'edit'; original: string; url: string }
  | { kind: 'remove'; original: string }
  | { kind: 'move'; original: string; direction: -1 | 1 };

export type WorkerUrlProblem = 'changed-elsewhere' | 'keep-one' | 'cannot-move' | 'invalid-url' | 'duplicate' | 'limit';

export class WorkerUrlChangeError extends Error {
  constructor(readonly problem: WorkerUrlProblem) {
    super(problem);
    this.name = 'WorkerUrlChangeError';
  }
}

/** The translated message for a refused change. */
export const workerUrlProblemKey = (problem: WorkerUrlProblem): Translations => {
  switch (problem) {
    case 'changed-elsewhere': {
      return 'admin.frameleaf_workers_problem_changed_elsewhere';
    }
    case 'keep-one': {
      return 'admin.frameleaf_workers_problem_keep_one';
    }
    case 'cannot-move': {
      return 'admin.frameleaf_workers_problem_cannot_move';
    }
    case 'invalid-url': {
      return 'admin.frameleaf_workers_problem_invalid_url';
    }
    case 'duplicate': {
      return 'admin.frameleaf_workers_problem_duplicate';
    }
    case 'limit': {
      return 'admin.frameleaf_workers_problem_limit';
    }
  }
};

/**
 * Apply one change to the current URL list and return the new list, or throw a
 * `WorkerUrlChangeError`. `original` must still be in the list, so a change made against a list
 * someone else has since edited is refused instead of landing on the wrong entry.
 */
export const applyWorkerUrlChange = (current: readonly string[], change: WorkerUrlChange): string[] => {
  const urls = [...current];
  const index = change.kind === 'add' ? -1 : urls.indexOf(change.original);
  if (change.kind !== 'add' && index < 0) {
    throw new WorkerUrlChangeError('changed-elsewhere');
  }

  switch (change.kind) {
    case 'remove': {
      if (urls.length <= 1) {
        throw new WorkerUrlChangeError('keep-one');
      }
      urls.splice(index, 1);
      return urls;
    }
    case 'move': {
      const next = index + change.direction;
      if (next < 0 || next >= urls.length) {
        throw new WorkerUrlChangeError('cannot-move');
      }
      const moved = urls[index];
      urls[index] = urls[next];
      urls[next] = moved;
      return urls;
    }
    case 'add':
    case 'edit': {
      const normalized = normalizeWorkerUrl(change.url);
      if (!normalized) {
        throw new WorkerUrlChangeError('invalid-url');
      }
      if (urls.some((url, i) => i !== index && normalizeWorkerUrl(url) === normalized)) {
        throw new WorkerUrlChangeError('duplicate');
      }
      if (change.kind === 'add') {
        if (urls.length >= ML_ENDPOINT_LIMIT) {
          throw new WorkerUrlChangeError('limit');
        }
        urls.push(normalized);
      } else {
        urls[index] = normalized;
      }
      return urls;
    }
  }
};

/* -------------------------------------------------------------------------- */
/* Grouping                                                                    */
/* -------------------------------------------------------------------------- */

const sameUrl = (a: string | null, b: string | null) =>
  a !== null && b !== null && normalizeWorkerUrl(a) !== null && normalizeWorkerUrl(a) === normalizeWorkerUrl(b);

export type ConfiguredEndpoint = {
  /** Position in the machine-learning URL list, from 0. */
  index: number;
  url: string;
  /** This server's destination for the URL, or null when it has not been created yet. */
  entry: WorkerInventoryEntryDto | null;
};

export type InventorySections = {
  /** The machine-learning URL list, in order, each with its destination. */
  endpoints: ConfiguredEndpoint[];
  /** Other library-analysis workers: LAN `/predict` containers, Frameleaf Cloud, Studio AI workers. */
  libraryWorkers: WorkerInventoryEntryDto[];
  /** Restoration workers: local or LAN restoration containers. */
  restorationWorkers: WorkerInventoryEntryDto[];
  /** Rows saved before the separation that allow both kinds of work. */
  mixedWorkers: WorkerInventoryEntryDto[];
  renderWorkers: WorkerInventoryEntryDto[];
};

/** Split the inventory the way the prototype lays it out. Nothing is dropped. */
export const inventorySections = (
  inventory: Pick<WorkerInventoryResponseDto, 'entries' | 'configuredUrls'>,
): InventorySections => {
  const used = new Set<string>();
  const endpoints = inventory.configuredUrls.map((url, index) => {
    const entry =
      inventory.entries.find(
        (candidate) =>
          candidate.source === WorkerInventorySource.MlDestination &&
          candidate.kind === MlDestinationKind.Local &&
          !used.has(candidate.id) &&
          sameUrl(candidate.url, url),
      ) ?? null;
    if (entry) {
      used.add(entry.id);
    }
    return { index, url, entry };
  });

  const sections: InventorySections = {
    endpoints,
    libraryWorkers: [],
    restorationWorkers: [],
    mixedWorkers: [],
    renderWorkers: [],
  };
  for (const entry of inventory.entries) {
    if (used.has(entry.id)) {
      continue;
    }
    if (entry.source === WorkerInventorySource.RenderWorker) {
      sections.renderWorkers.push(entry);
    } else if (entry.role === MlWorkerRole.Restoration) {
      sections.restorationWorkers.push(entry);
    } else if (entry.role === MlWorkerRole.Mixed && entry.kind !== MlDestinationKind.FrameleafCloud) {
      // Frameleaf Cloud may run both (each job gets its own capacity); it is listed with library workers.
      sections.mixedWorkers.push(entry);
    } else {
      sections.libraryWorkers.push(entry);
    }
  }
  return sections;
};

/** The inventory entry a library route names, for the routing summary. */
export const routedEntry = (
  inventory: Pick<WorkerInventoryResponseDto, 'entries'>,
  destinationId: string | null,
): WorkerInventoryEntryDto | null =>
  destinationId === null ? null : (inventory.entries.find((entry) => entry.id === destinationId) ?? null);

/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

export const readinessLabelKey = (entry: Pick<WorkerInventoryEntryDto, 'readiness' | 'source'>): Translations => {
  const render = entry.source === WorkerInventorySource.RenderWorker;
  switch (entry.readiness) {
    case MlWorkerReadiness.Unknown: {
      return render ? 'admin.frameleaf_workers_state_never_seen' : 'admin.frameleaf_workers_state_unknown';
    }
    case MlWorkerReadiness.Disabled: {
      return render ? 'admin.frameleaf_workers_state_revoked' : 'admin.frameleaf_workers_state_disabled';
    }
    case MlWorkerReadiness.Unreachable: {
      return render ? 'admin.frameleaf_workers_state_not_seen' : 'admin.frameleaf_workers_state_unreachable';
    }
    case MlWorkerReadiness.NotServing: {
      return 'admin.frameleaf_workers_state_not_serving';
    }
    case MlWorkerReadiness.Cpu: {
      return 'admin.frameleaf_workers_state_cpu';
    }
    case MlWorkerReadiness.ModelReady: {
      return render ? 'admin.frameleaf_workers_state_checked_in' : 'admin.frameleaf_workers_state_model_ready';
    }
  }
};

export const readinessTone = (readiness: MlWorkerReadiness): 'teal' | 'blue' | 'warning' | 'danger' | 'neutral' => {
  switch (readiness) {
    case MlWorkerReadiness.ModelReady: {
      return 'teal';
    }
    case MlWorkerReadiness.Cpu: {
      return 'blue';
    }
    case MlWorkerReadiness.NotServing: {
      return 'warning';
    }
    case MlWorkerReadiness.Unreachable: {
      return 'danger';
    }
    case MlWorkerReadiness.Unknown:
    case MlWorkerReadiness.Disabled: {
      return 'neutral';
    }
  }
};

export const accelerationLabelKey = (acceleration: MlWorkerAcceleration): Translations => {
  switch (acceleration) {
    case MlWorkerAcceleration.Gpu: {
      return 'admin.frameleaf_workers_acceleration_gpu';
    }
    case MlWorkerAcceleration.Cpu: {
      return 'admin.frameleaf_workers_acceleration_cpu';
    }
    case MlWorkerAcceleration.Unknown: {
      return 'admin.frameleaf_workers_acceleration_unknown';
    }
  }
};

export const credentialLabelKey = (credential: WorkerCredentialState): Translations => {
  switch (credential) {
    case WorkerCredentialState.None: {
      return 'admin.frameleaf_workers_credential_none';
    }
    case WorkerCredentialState.Stored: {
      return 'admin.frameleaf_workers_credential_stored';
    }
    case WorkerCredentialState.Managed: {
      return 'admin.frameleaf_workers_credential_managed';
    }
    case WorkerCredentialState.Enrolled: {
      return 'admin.frameleaf_workers_credential_enrolled';
    }
  }
};

export const roleLabelKey = (role: MlWorkerRole): Translations => {
  switch (role) {
    case MlWorkerRole.LibraryAnalysis: {
      return 'admin.frameleaf_ml_role_library_analysis';
    }
    case MlWorkerRole.Restoration: {
      return 'admin.frameleaf_ml_role_restoration';
    }
    case MlWorkerRole.Studio: {
      return 'admin.frameleaf_ml_role_studio';
    }
    case MlWorkerRole.Mixed: {
      return 'admin.frameleaf_ml_role_mixed';
    }
    case MlWorkerRole.Unassigned: {
      return 'admin.frameleaf_ml_role_unassigned';
    }
  }
};

/** The "Type" row: what kind of work this worker does, as the prototype names it. */
export const workerTypeLabelKey = (entry: Pick<WorkerInventoryEntryDto, 'source' | 'role' | 'kind'>): Translations => {
  if (entry.source === WorkerInventorySource.RenderWorker) {
    return 'admin.frameleaf_workers_type_render';
  }
  if (entry.role === MlWorkerRole.Restoration) {
    return 'admin.frameleaf_workers_type_restoration';
  }
  return 'admin.frameleaf_workers_type_ml';
};

/** GPU memory in GiB with one decimal, or null when it is not known. */
export const formatGpuMemory = (bytes: number | null, locale: string | undefined): string | null => {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) {
    return null;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 ** 3)} GiB`;
};

/** Whether a snapshot is older than two refresh intervals, i.e. refreshing has stopped working. */
export const isStaleSnapshot = (checkedAt: string, now: number, refreshMs = WORKER_INVENTORY_REFRESH_MS): boolean =>
  now - new Date(checkedAt).getTime() > refreshMs * 2;
