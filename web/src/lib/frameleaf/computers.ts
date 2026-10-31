/**
 * Computers & background work (FL-364): the one reading of "which computers help this server, and
 * are they answering" that the landing page, Computers, Where work runs and Graphics card check all
 * use, so the pages cannot disagree with each other. Everything is derived from what the server
 * already reports: the worker inventory (AI helpers and Studio helpers in one list), the render
 * compatibility answer (what Studio and restoration can run now) and the queues.
 */
import {
  MediaOperationKind,
  MlDestinationKind,
  MlWorkerReadiness,
  WorkerInventorySource,
  type QueueResponseDto,
  type RenderWorkerCompatibilityResponseDto,
  type WorkerInventoryEntryDto,
  type WorkerInventoryResponseDto,
} from '@frameleaf/sdk';
import { JOB_QUEUES, type JobQueueDefinition } from '$lib/frameleaf/job-queues';

/** Where a computer is: this server itself, another computer at home, or Frameleaf Cloud. */
export type ComputerPlace = 'server' | 'home' | 'cloud';
/**
 * Whether a computer can be given work. `unchecked` has not been asked yet (the server asks on a
 * timer and when work arrives), which is not the same as not answering.
 */
export type ComputerState = 'ready' | 'not-answering' | 'unchecked' | 'off';

export type Computer = {
  /** Stable for the list and for `?computer=`: `server`, `cloud`, or the helper's name in lower case. */
  key: string;
  /** Empty for this server and Frameleaf Cloud, which the page names itself. */
  name: string;
  place: ComputerPlace;
  state: ComputerState;
  /** The server's records behind this computer: an AI address, a Studio helper, or both. */
  entries: WorkerInventoryEntryDto[];
  /** The graphics card it reported, when it has one. */
  card?: string;
};

export const SERVER_KEY = 'server';
export const CLOUD_KEY = 'cloud';

const placeOf = (entry: WorkerInventoryEntryDto): ComputerPlace =>
  entry.kind === MlDestinationKind.FrameleafCloud
    ? 'cloud'
    : entry.kind === MlDestinationKind.Local && entry.source === WorkerInventorySource.MlDestination
      ? 'server'
      : 'home';

/**
 * What a computer's row says about where it is. A Studio worker bundled with this server stays its
 * own row (it answers on its own), but it runs here, not at home.
 */
export const whereOf = (computer: Computer): ComputerPlace =>
  computer.place === 'home' && computer.entries.every((entry) => entry.kind === MlDestinationKind.Local)
    ? 'server'
    : computer.place;

/** One record's state. A record that answers but offers nothing yet still answers. */
export const entryState = (entry: WorkerInventoryEntryDto): ComputerState => {
  if (!entry.enabled || entry.readiness === MlWorkerReadiness.Disabled) {
    return 'off';
  }
  if (entry.readiness === MlWorkerReadiness.Unreachable) {
    return 'not-answering';
  }
  return entry.readiness === MlWorkerReadiness.Unknown ? 'unchecked' : 'ready';
};

const WORST: readonly ComputerState[] = ['not-answering', 'unchecked', 'ready', 'off'];
/** A computer with several records is as healthy as its least healthy one that is switched on. */
const combinedState = (entries: readonly WorkerInventoryEntryDto[]): ComputerState => {
  const states = new Set(entries.map((entry) => entryState(entry)));
  return WORST.find((state) => states.has(state)) ?? 'off';
};

const helperKey = (name: string) => name.trim().toLowerCase();

/**
 * Every computer that does work for this server, this server first. A helper set up both for AI
 * features and for Studio is two records on the server; records with the same name are one
 * computer here. This server is always listed, whether or not AI features are switched on.
 */
export const computersFrom = (inventory: WorkerInventoryResponseDto | null | undefined): Computer[] => {
  const entries = inventory?.entries ?? [];
  const own = entries.filter((entry) => placeOf(entry) === 'server');
  const server: Computer = {
    key: SERVER_KEY,
    name: '',
    place: 'server',
    // This server is the one answering the page. Its AI features are read separately (`aiState`).
    state: 'ready',
    entries: own,
    card: own.flatMap((entry) => entry.gpus)[0]?.name,
  };
  const helpers = new Map<string, Computer>();
  let cloud: Computer | undefined;
  for (const entry of entries) {
    const place = placeOf(entry);
    if (place === 'server') {
      continue;
    }
    if (place === 'cloud') {
      cloud ??= { key: CLOUD_KEY, name: '', place, state: 'off', entries: [] };
      cloud.entries.push(entry);
      continue;
    }
    const key = helperKey(entry.name);
    const helper = helpers.get(key) ?? { key, name: entry.name.trim(), place, state: 'off', entries: [] };
    helper.entries.push(entry);
    helpers.set(key, helper);
  }
  const rest = [...helpers.values(), ...(cloud ? [cloud] : [])].map((computer) => ({
    ...computer,
    state: combinedState(computer.entries),
    card: computer.entries.flatMap((entry) => entry.gpus)[0]?.name,
  }));
  return [server, ...rest];
};

/** Whether this server's own AI features are switched on and answering. */
export type AiState = ComputerState;
export const aiState = (inventory: WorkerInventoryResponseDto | null | undefined): AiState | undefined => {
  if (!inventory) {
    return undefined;
  }
  if (!inventory.machineLearningEnabled) {
    return 'off';
  }
  const own = inventory.entries.filter((entry) => placeOf(entry) === 'server');
  return own.length === 0 ? 'unchecked' : combinedState(own);
};

/** Helpers that are switched on and did not answer the last time they were asked. */
export const notAnswering = (computers: readonly Computer[]) =>
  computers.filter((computer) => computer.place !== 'server' && computer.state === 'not-answering');

/**
 * The one rule for Studio and restoration: each needs a computer with a graphics card that is
 * connected and has proved it can do the work. The server answers that question itself
 * (`render-workers/compatibility`); every page reads it here rather than guessing from other signs.
 */
export type StudioWork = 'export' | 'restoration';
const STUDIO_KINDS: Record<StudioWork, MediaOperationKind> = {
  export: MediaOperationKind.StudioExport,
  restoration: MediaOperationKind.Restoration,
};
export const canRunStudioWork = (
  compatibility: RenderWorkerCompatibilityResponseDto | null | undefined,
  work: StudioWork,
): boolean | undefined => (compatibility ? compatibility.qualified.includes(STUDIO_KINDS[work]) : undefined);

/** The Studio work nothing connected can do right now; empty when it is unknown. */
export const studioWorkUnavailable = (
  compatibility: RenderWorkerCompatibilityResponseDto | null | undefined,
): StudioWork[] =>
  (Object.keys(STUDIO_KINDS) as StudioWork[]).filter((work) => canRunStudioWork(compatibility, work) === false);

// ── Background work, summed up ─────────────────────────────────────────────────────────────────────

export type WorkRow = { definition: JobQueueDefinition; queue: QueueResponseDto };

/** The kinds of work the server reports, in the catalogue's order. */
export const workRows = (queues: readonly QueueResponseDto[]): WorkRow[] => {
  const byName = new Map(queues.map((queue) => [queue.name, queue]));
  return JOB_QUEUES.flatMap((definition) => {
    const queue = byName.get(definition.name);
    return queue ? [{ definition, queue }] : [];
  });
};

/**
 * Items a kind of work still has to do: running, waiting, or held by a pause. Work the server has
 * booked for later (the next scheduled backup, a retry in a few minutes) is not counted; it is not
 * something the server is behind on.
 */
export const workLeft = ({ queue }: WorkRow) =>
  queue.statistics.active + queue.statistics.waiting + queue.statistics.paused;

/** How one kind of work is doing, as "Now" says it. */
export type WorkState = 'running' | 'waiting' | 'paused' | 'failed' | 'up-to-date';
export const workState = (row: WorkRow): WorkState => {
  if (row.queue.isPaused && row.definition.canPause) {
    return 'paused';
  }
  if (row.queue.statistics.active > 0) {
    return 'running';
  }
  if (row.queue.statistics.failed > 0) {
    return 'failed';
  }
  return workLeft(row) > 0 ? 'waiting' : 'up-to-date';
};

/** Work that is running, waiting, paused or failed: the only rows "Now" lists. */
export const workNow = (rows: readonly WorkRow[]) => rows.filter((row) => workState(row) !== 'up-to-date');

export type WorkSummary = {
  /** Kinds of work with something running. */
  running: WorkRow[];
  /** Kinds with something waiting and nothing running or paused. */
  waiting: WorkRow[];
  paused: WorkRow[];
  /** Kinds holding failed items, whatever else they are doing. */
  failed: WorkRow[];
  /** Items still to do across every kind (running and waiting). */
  left: number;
  failedCount: number;
};

export const summariseWork = (rows: readonly WorkRow[]): WorkSummary => {
  const summary: WorkSummary = { running: [], waiting: [], paused: [], failed: [], left: 0, failedCount: 0 };
  for (const row of rows) {
    const { active, failed } = row.queue.statistics;
    const left = workLeft(row);
    summary.left += left;
    summary.failedCount += failed;
    if (failed > 0) {
      summary.failed.push(row);
    }
    if (row.queue.isPaused) {
      if (row.definition.canPause) {
        summary.paused.push(row);
      }
    } else if (active > 0) {
      summary.running.push(row);
    } else if (left > 0) {
      summary.waiting.push(row);
    }
  }
  return summary;
};

/** What the area's first line says, most urgent first. */
export type AreaStatus = 'attention' | 'paused' | 'working' | 'up-to-date';
export const areaStatus = (work: WorkSummary, silent: readonly Computer[], ai: AiState | undefined): AreaStatus => {
  if (work.failedCount > 0 || silent.length > 0 || ai === 'not-answering') {
    return 'attention';
  }
  if (work.running.length > 0 || work.waiting.length > 0) {
    return 'working';
  }
  return work.paused.length > 0 ? 'paused' : 'up-to-date';
};
