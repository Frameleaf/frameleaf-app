/**
 * The Universal RAW page (FL-420, RawLibraryCare.jsx): copy for each state, the camera families the
 * prototype's compatibility table lists, and the repair progress the page follows.
 *
 * The server says how each RAW original is doing (`GET /media-health/raw`); repair is the ordinary
 * regenerate-thumbnail job, so progress is read back from each file's preview time.
 */
import {
  RawSupportStatus,
  type RawSupportFormatDto,
  type RawSupportItemDto,
  type RawSupportResponseDto,
} from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';

export type RawStatus = RawSupportStatus;

export const RAW_STATUS_COPY: Readonly<
  Record<RawStatus, { label: Translations; detail: Translations; action: Translations | null }>
> = {
  ready: {
    label: 'frameleaf_raw_support_status_ready',
    detail: 'frameleaf_raw_support_detail_ready',
    action: null,
  },
  preview: {
    label: 'frameleaf_raw_support_status_preview',
    detail: 'frameleaf_raw_support_detail_preview',
    action: null,
  },
  pending: {
    label: 'frameleaf_raw_support_status_pending',
    detail: 'frameleaf_raw_support_detail_pending',
    action: 'frameleaf_raw_support_action_generate',
  },
  timeout: {
    label: 'frameleaf_raw_support_status_timeout',
    detail: 'frameleaf_raw_support_detail_timeout',
    action: 'frameleaf_raw_support_action_retry',
  },
  unsupported: {
    label: 'frameleaf_raw_support_status_unsupported',
    detail: 'frameleaf_raw_support_detail_unsupported',
    action: 'frameleaf_raw_support_action_capability',
  },
  damaged: {
    label: 'frameleaf_raw_support_status_damaged',
    detail: 'frameleaf_raw_support_detail_damaged',
    action: 'frameleaf_raw_support_action_details',
  },
  dependency: {
    label: 'frameleaf_raw_support_status_dependency',
    detail: 'frameleaf_raw_support_detail_dependency',
    action: 'frameleaf_raw_support_action_details',
  },
};

/** States a preview job can fix: nothing was made yet, or the last try ran out of time. */
export const REPAIRABLE: ReadonlySet<RawStatus> = new Set([RawSupportStatus.Pending, RawSupportStatus.Timeout]);
export const repairableIds = (items: readonly RawSupportItemDto[]) =>
  items.filter((item) => REPAIRABLE.has(item.status)).map((item) => item.assetId);

/** Warning-toned states, as the prototype's `.raw-status-{timeout,damaged,dependency}`. */
export const WARNING: ReadonlySet<RawStatus> = new Set([
  RawSupportStatus.Timeout,
  RawSupportStatus.Damaged,
  RawSupportStatus.Dependency,
]);

/** The prototype's compatibility rows, in its order; other extensions in the library follow them. */
export const RAW_FAMILIES: readonly { label: string; maker: string; extensions: readonly string[] }[] = [
  { label: 'CR2 / CR3', maker: 'Canon', extensions: ['cr2', 'cr3', 'crw'] },
  { label: 'NEF', maker: 'Nikon', extensions: ['nef', 'nrw'] },
  { label: 'ARW', maker: 'Sony', extensions: ['arw', 'sr2', 'srf'] },
  { label: 'RAF', maker: 'Fujifilm', extensions: ['raf'] },
  { label: 'DNG / ProRAW', maker: 'Adobe / Apple', extensions: ['dng'] },
  { label: 'ORF', maker: 'OM System', extensions: ['orf', 'ori'] },
  { label: 'RW2', maker: 'Panasonic', extensions: ['rw2', 'raw'] },
];

const OTHER_MAKERS: Readonly<Record<string, string>> = {
  '3fr': 'Hasselblad',
  fff: 'Hasselblad',
  ari: 'ARRI',
  cap: 'Phase One',
  iiq: 'Phase One',
  cin: 'Phantom',
  dcr: 'Kodak',
  k25: 'Kodak',
  kdc: 'Kodak',
  erf: 'Epson',
  mrw: 'Minolta',
  pef: 'Pentax',
  rwl: 'Leica',
  srw: 'Samsung',
  x3f: 'Sigma',
};

export type FormatRow = {
  label: string;
  maker: string;
  count: number;
  ready: number;
  attention: number;
  tested: string[];
};

/** The table rows: the prototype's families, with the library's counts merged in by extension. */
export function formatRows(formats: readonly RawSupportFormatDto[]): FormatRow[] {
  const byExtension = new Map(formats.map((format) => [format.extension, format]));
  const sum = (extensions: readonly string[]) => {
    const found = extensions.map((extension) => byExtension.get(extension)).filter((format) => !!format);
    return {
      count: found.reduce((total, format) => total + format.count, 0),
      ready: found.reduce((total, format) => total + format.ready, 0),
      attention: found.reduce((total, format) => total + format.attention, 0),
      tested: [...new Set(found.flatMap((format) => format.tested))],
    };
  };
  const listed = new Set(RAW_FAMILIES.flatMap((family) => family.extensions));
  return [
    ...RAW_FAMILIES.map((family) => ({ label: family.label, maker: family.maker, ...sum(family.extensions) })),
    ...formats
      .filter((format) => !listed.has(format.extension))
      .map((format) => ({
        label: format.extension.toUpperCase(),
        maker: OTHER_MAKERS[format.extension] ?? '',
        ...sum([format.extension]),
      })),
  ];
}

/** "Canon EOS R5", without "Canon Canon EOS R5" when the model repeats the maker. */
export const cameraName = (item: Pick<RawSupportItemDto, 'make' | 'model'>) => {
  const make = item.make?.trim() ?? '';
  const model = item.model?.trim() ?? '';
  if (!model) {
    return make;
  }
  return make && !model.toLowerCase().startsWith(make.toLowerCase()) ? `${make} ${model}` : model;
};

export type RawRepair = {
  ids: string[];
  startedAt: string;
  /** Files whose preview was written after the repair started. */
  done: string[];
  status: 'running' | 'complete' | 'stalled';
  /** When a file last finished; a repair that makes no progress for `REPAIR_STALL_MS` stops waiting. */
  progressAt: string;
  hidden?: boolean;
};

export const REPAIR_POLL_MS = 4000;
export const REPAIR_STALL_MS = 10 * 60 * 1000;

export const startRepair = (ids: string[], now = new Date()): RawRepair => ({
  ids: [...new Set(ids)],
  startedAt: now.toISOString(),
  done: [],
  status: 'running',
  progressAt: now.toISOString(),
});

/**
 * Reads a fresh summary into the repair. A listed file is done once its preview is newer than the
 * repair. A file no longer listed has left the attention-first list (the list was full and it now has
 * a preview) or the library, so it is done too.
 */
export function advanceRepair(repair: RawRepair, summary: RawSupportResponseDto, now = new Date()): RawRepair {
  if (repair.status !== 'running') {
    return repair;
  }
  const byId = new Map(summary.items.map((item) => [item.assetId, item]));
  const started = Date.parse(repair.startedAt);
  const done = repair.ids.filter((id) => {
    const item = byId.get(id);
    return !item || (!!item.renderedAt && Date.parse(item.renderedAt) > started);
  });
  const progressed = done.length > repair.done.length;
  const progressAt = progressed ? now.toISOString() : repair.progressAt;
  const status =
    done.length >= repair.ids.length
      ? 'complete'
      : now.getTime() - Date.parse(progressAt) > REPAIR_STALL_MS
        ? 'stalled'
        : 'running';
  return { ...repair, done, progressAt, status };
}

const REPAIR_KEY = 'frameleaf:raw-support:repair:v1';

/** The repair this browser started, kept so a reload shows its progress (a per-viewer convenience). */
export function readRepair(): RawRepair | null {
  try {
    const value = JSON.parse(localStorage.getItem(REPAIR_KEY) ?? 'null') as RawRepair | null;
    return value &&
      Array.isArray(value.ids) &&
      Array.isArray(value.done) &&
      typeof value.startedAt === 'string' &&
      ['running', 'complete', 'stalled'].includes(value.status)
      ? value
      : null;
  } catch {
    return null;
  }
}

export function saveRepair(repair: RawRepair | null): boolean {
  try {
    if (repair) {
      localStorage.setItem(REPAIR_KEY, JSON.stringify(repair));
    } else {
      localStorage.removeItem(REPAIR_KEY);
    }
    return true;
  } catch {
    return false;
  }
}
