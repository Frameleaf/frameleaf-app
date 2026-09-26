/**
 * The Job manager's "Queue action history" (FL-71), the template's `state.history` in
 * `JobsManager.jsx`: the server-wide queue commands sent from this device, newest first. It
 * records commands, not their outcome or completed processing, so it lives in this browser's
 * storage (never shared, never sent anywhere). As the template (`JOBS_LIMITS.history`), it keeps 120
 * entries and the list shows the newest 40 of the chosen queue.
 */
import type { QueueName } from '@immich/sdk';

export const JOB_HISTORY_STORAGE_KEY = 'frameleaf:job-manager-history:v1';
export const JOB_HISTORY_LIMIT = 120;
/** How many entries the history list shows, as the template's `scopedHistory.slice(0, 40)`. */
export const JOB_HISTORY_SHOWN = 40;

export type JobHistoryEntry = {
  id: string;
  /** ISO time the command was sent. */
  at: string;
  /** The command's review title, as the administrator confirmed it. */
  title: string;
  /** The queue it addressed; absent for a command across queues. */
  queue?: QueueName;
  /** The review's "Affected now" count when it was sent. */
  affected: number;
};

type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>;

const isEntry = (value: unknown): value is JobHistoryEntry => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.at === 'string' &&
    !Number.isNaN(Date.parse(entry.at)) &&
    typeof entry.title === 'string' &&
    entry.title.length <= 200 &&
    (entry.queue === undefined || typeof entry.queue === 'string') &&
    typeof entry.affected === 'number'
  );
};

const defaultStorage = (): HistoryStorage | undefined => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

/** The stored history; anything unreadable or malformed reads as empty. */
export const readJobHistory = (storage: HistoryStorage | undefined = defaultStorage()): JobHistoryEntry[] => {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(JOB_HISTORY_STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((entry) => isEntry(entry)).slice(0, JOB_HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
};

/** Adds a command to the front of the history and keeps the newest 120; storage failures are ignored. */
export const recordJobHistory = (
  entry: JobHistoryEntry,
  storage: HistoryStorage | undefined = defaultStorage(),
): JobHistoryEntry[] => {
  const next = [entry, ...readJobHistory(storage).filter(({ id }) => id !== entry.id)].slice(0, JOB_HISTORY_LIMIT);
  try {
    storage?.setItem(JOB_HISTORY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The history is a convenience of this device; a full or blocked storage only loses it.
  }
  return next;
};

/** The history of one queue, or of every queue. */
export const historyFor = (entries: readonly JobHistoryEntry[], queue?: QueueName) =>
  queue ? entries.filter((entry) => entry.queue === queue) : [...entries];
