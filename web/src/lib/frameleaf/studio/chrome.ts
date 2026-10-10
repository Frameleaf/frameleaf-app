/**
 * Small view-model rules for the Studio chrome Frameleaf owns around the editor: the timecode a
 * review comment is pinned at, how the version list is grouped by day, the "Edited 3 days ago"
 * line on a project card, the poster a project opens from, and what the header's export pill says.
 * Pure, so they are tested without a DOM.
 */
import { MediaOperationStatus, type MediaOperationDto } from '@frameleaf/sdk';
import { toApproximateNumber, type Rational } from './rational-time';

const pad = (value: number) => String(value).padStart(2, '0');

/** `00:12`, or `1:02:03` past the hour. Whole seconds, rounded down, as a clock a person reads. */
export const studioTimecode = (time: Rational | null | undefined): string => {
  const seconds = time ? Math.max(0, Math.floor(toApproximateNumber(time))) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = pad(seconds % 60);
  return hours > 0 ? `${hours}:${pad(minutes)}:${rest}` : `${pad(minutes)}:${rest}`;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Whole calendar days between `date` and `now` in local time: 0 today, 1 yesterday. */
export const studioDaysAgo = (date: Date, now = new Date()): number =>
  Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);

export type StudioDayGroup<T> = { day: string; daysAgo: number; date: Date; items: T[] };

/**
 * Splits a newest-first list into runs that share a calendar day, keeping the order it came in.
 * `day` is a stable key (`2026-10-03`); the caller words the heading from `daysAgo` and `date`.
 */
export const groupStudioByDay = <T>(
  items: readonly T[],
  dateOf: (item: T) => string | Date,
  now = new Date(),
): StudioDayGroup<T>[] => {
  const groups: StudioDayGroup<T>[] = [];
  for (const item of items) {
    const date = new Date(dateOf(item));
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const last = groups.at(-1);
    if (last?.day === day) {
      last.items.push(item);
    } else {
      groups.push({ day, daysAgo: studioDaysAgo(date, now), date, items: [item] });
    }
  }
  return groups;
};

const RELATIVE_STEPS: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: 'year', ms: 365 * DAY_MS },
  { unit: 'month', ms: 30 * DAY_MS },
  { unit: 'week', ms: 7 * DAY_MS },
  { unit: 'day', ms: DAY_MS },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
];

/** "3 days ago", "yesterday", "just now" in the person's language. */
export const studioRelativeTime = (date: string | Date, locale?: string, now = new Date()): string => {
  const elapsed = now.getTime() - new Date(date).getTime();
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const { unit, ms } of RELATIVE_STEPS) {
    if (Math.abs(elapsed) >= ms) {
      return format.format(-Math.round(elapsed / ms), unit);
    }
  }
  return format.format(0, 'second');
};

/* ------------------------------------------------------------------ */
/* Opening a project from its card                                      */
/* ------------------------------------------------------------------ */

export type StudioOpening = { projectId: string; name: string; posterUrl: string | null };

/**
 * The key shared by a project card's poster and the opening screen's poster (`data-fl-shared`), so
 * the root layout's card-to-page Hero carries one into the other (`$lib/frameleaf/motion`).
 */
export const studioProjectSharedKey = (projectId: string): string => `studio-project:${projectId}`;

let opening: StudioOpening | null = null;

/** The library remembers the card a person opened, so the editor's opening screen can show it. */
export const rememberStudioOpening = (next: StudioOpening): void => {
  opening = next;
};

/** What the library remembered for this project, once. Nothing after a reload or a deep link. */
export const takeStudioOpening = (projectId: string | null | undefined): StudioOpening | null => {
  const found = opening && opening.projectId === projectId ? opening : null;
  opening = null;
  return found;
};

/* ------------------------------------------------------------------ */
/* The export pill                                                      */
/* ------------------------------------------------------------------ */

export type StudioExportJob = Pick<MediaOperationDto, 'id' | 'status' | 'progress' | 'resultAssetId'>;
export type StudioExportJobPhase = 'queued' | 'working' | 'ready' | 'failed';

export const studioExportJobPhase = (job: Pick<MediaOperationDto, 'status'>): StudioExportJobPhase => {
  switch (job.status) {
    case MediaOperationStatus.Completed: {
      return 'ready';
    }
    case MediaOperationStatus.Failed:
    case MediaOperationStatus.Cancelled:
    case MediaOperationStatus.Cancelling: {
      return 'failed';
    }
    case MediaOperationStatus.Queued:
    case MediaOperationStatus.Paused: {
      return 'queued';
    }
    default: {
      return 'working';
    }
  }
};

export const isStudioExportJobSettled = (job: Pick<MediaOperationDto, 'status'>): boolean =>
  ['ready', 'failed'].includes(studioExportJobPhase(job));

/** A whole percentage between 0 and 100, whatever the server sent. */
export const studioExportPercent = (job: Pick<MediaOperationDto, 'progress'>): number =>
  Math.min(100, Math.max(0, Math.round(Number(job.progress) || 0)));

/* ------------------------------------------------------------------ */
/* Keeping the transfer dock off Studio's chrome                        */
/* ------------------------------------------------------------------ */

/** The space the server preview keeps from the editor's lower edge, which the dock keeps too. */
const DOCK_GAP_PX = 16;

/**
 * How far the upload and download dock has to move so it covers none of Studio's chrome. `right` is
 * the width of an open drawer, which the dock steps beside; `clearance` is the height above the
 * window's lower edge that the dock rises over: the server preview, and on a narrow window, where
 * the dock spans the full width and cannot step aside, the comment field at the foot of the drawer.
 * All in CSS pixels.
 */
export const studioDockClearance = (measured: {
  viewportHeight: number;
  /** The dock spans the window's width, so it cannot be moved beside a drawer. */
  stretched: boolean;
  /** The lower edge of the Studio frame in the viewport. */
  hostBottom: number;
  /** An open drawer's width, 0 without one. */
  drawerWidth: number;
  /** From the server preview's upper edge to the editor's lower edge, 0 when it is closed. */
  panelReach: number;
  /** The upper edge of the drawer's pinned foot in the viewport, when it has one. */
  footTop: number | null;
}): { right: number; clearance: number } => {
  const below = Math.max(0, measured.viewportHeight - measured.hostBottom);
  const overPanel = measured.panelReach > 0 ? below + measured.panelReach + DOCK_GAP_PX : 0;
  const overFoot =
    measured.stretched && measured.drawerWidth > 0 && measured.footTop !== null
      ? measured.viewportHeight - measured.footTop + DOCK_GAP_PX
      : 0;
  return {
    right: measured.stretched ? 0 : Math.max(0, Math.round(measured.drawerWidth)),
    clearance: Math.max(0, Math.round(Math.max(overPanel, overFoot))),
  };
};
