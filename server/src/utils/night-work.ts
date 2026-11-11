import { AsyncLocalStorage } from 'node:async_hooks';
import { queueExecution } from 'src/queue/context.js';

/**
 * FL-1430: the night that started a piece of work: the overnight run's `startedAt`, and whether a person started that
 * run with Run now (`manual`). Recent work folds a scheduled night's runs into one card; a Run now night stays apart.
 */
export type NightMark = { startedAt: string; manual: boolean };

/** Set by the overnight schedule while it starts a step's work. */
export const nightWork = new AsyncLocalStorage<NightMark>();

/** A job the night queued outside any run carries its night in its data, for the run it opens later. */
export const NIGHT_DATA_KEY = '_night';

const isMark = (value: unknown): value is NightMark =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as NightMark).startedAt === 'string' &&
  typeof (value as NightMark).manual === 'boolean';

/** The night of the work being done now: the overnight schedule's own, or the one the running job was queued with. */
export const currentNight = (): NightMark | undefined => {
  const own = nightWork.getStore();
  if (own) return own;
  const carried = queueExecution.getStore()?.claim.data?.[NIGHT_DATA_KEY];
  return isMark(carried) ? { startedAt: carried.startedAt, manual: carried.manual } : undefined;
};

/** A new run's selection, with the night that opens it (`job_run.selection.night`). */
export const withNight = <T extends Record<string, unknown>>(selection: T): T & { night?: NightMark } => {
  const night = currentNight();
  return night ? { ...selection, night } : selection;
};
