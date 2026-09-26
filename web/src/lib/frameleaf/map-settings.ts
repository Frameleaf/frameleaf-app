import { DateTime } from 'luxon';
import type { MapSettings } from '$lib/stores/preferences.store';

/** The Map screen's date presets, in the order the prototype's settings sheet lists them. */
export const MAP_DATE_PRESETS = ['all', '30d', 'year', 'custom'] as const;
export type MapDatePreset = (typeof MAP_DATE_PRESETS)[number];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The capture-date window a settings sheet asks for, as the map-marker endpoint's
 * `fileCreatedAfter` / `fileCreatedBefore` (prototype `filterMapAssets`). A custom range is
 * inclusive of both days; a half-typed custom date is ignored rather than guessed at.
 */
export const mapDateWindow = (
  settings: Pick<MapSettings, 'datePreset' | 'dateAfter' | 'dateBefore'>,
  now: DateTime = DateTime.now(),
): { fileCreatedAfter?: string; fileCreatedBefore?: string } => {
  switch (settings.datePreset) {
    case '30d': {
      return { fileCreatedAfter: now.minus({ days: 30 }).startOf('day').toUTC().toISO() ?? undefined };
    }
    case 'year': {
      return { fileCreatedAfter: now.startOf('year').toUTC().toISO() ?? undefined };
    }
    case 'custom': {
      const from = settings.dateAfter && ISO_DAY.test(settings.dateAfter) ? settings.dateAfter : undefined;
      const to = settings.dateBefore && ISO_DAY.test(settings.dateBefore) ? settings.dateBefore : undefined;
      return {
        fileCreatedAfter: from ? (DateTime.fromISO(from).startOf('day').toUTC().toISO() ?? undefined) : undefined,
        fileCreatedBefore: to ? (DateTime.fromISO(to).endOf('day').toUTC().toISO() ?? undefined) : undefined,
      };
    }
    default: {
      return {};
    }
  }
};

export type MapArea = { west: number; south: number; east: number; north: number };

const round = (value: number, direction: 'down' | 'up') =>
  Number(((direction === 'down' ? Math.floor : Math.ceil)(value * 1e5) / 1e5).toFixed(5));

/**
 * `west,south,east,north`, the order the timeline's `bbox` option takes, rounded outwards so an
 * item on the edge of the visible map stays inside the area.
 */
export const formatMapArea = ({ west, south, east, north }: MapArea) =>
  [round(west, 'down'), round(south, 'down'), round(east, 'up'), round(north, 'up')].join(',');

/** Reads a `?area=` value back; anything that is not four finite, ordered coordinates is refused. */
export const parseMapArea = (value: string | null | undefined): MapArea | null => {
  if (!value) {
    return null;
  }
  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  const [west, south, east, north] = parts;
  if (south > north || south < -90 || north > 90 || west < -180 || east > 180) {
    return null;
  }
  return { west, south, east, north };
};
