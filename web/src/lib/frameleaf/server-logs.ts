/**
 * Server logs (FL-893, after the approved prototype `settings-v2/server/operator.jsx` and
 * `operator-pack.mjs`, FL-798): the words the viewer uses for the server's sources and levels, the
 * "Show" choices, and how lines from a page and from the live tail are kept in one ordered list.
 *
 * The API (FL-870) filters by one exact level; the viewer's "Show" is "this level and anything more
 * serious", so the level is applied here and the source and search are left to the server.
 */
import { Level, Worker, type PrivateLogPageDto } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';

export type ServerLogLine = PrivateLogPageDto['entries'][number];
export type LogTone = 'off' | 'good' | 'warn' | 'bad';
export type LogShow = 'problems' | 'warnings' | 'normal' | 'detailed';

/** The most lines the viewer keeps; older ones fall off the top. */
export const MAX_LINES = 10_000;

/** The server's sources (`worker`) and what people call them. */
export const LOG_SOURCES: readonly [Worker, Translations][] = [
  [Worker.Api, 'frameleaf_logs_source_api'],
  [Worker.Microservices, 'frameleaf_logs_source_microservices'],
  [Worker.MachineLearning, 'frameleaf_logs_source_machine_learning'],
  [Worker.Maintenance, 'frameleaf_logs_source_maintenance'],
];

/** The levels, most detailed first, with the word the viewer shows and its tone. */
const LEVELS: readonly [Level, Translations, LogTone][] = [
  [Level.Verbose, 'frameleaf_logs_level_detail', 'off'],
  [Level.Debug, 'frameleaf_logs_level_detail', 'off'],
  [Level.Log, 'frameleaf_logs_level_info', 'good'],
  [Level.Warn, 'frameleaf_logs_level_warning', 'warn'],
  [Level.Error, 'frameleaf_logs_level_problem', 'bad'],
  [Level.Fatal, 'frameleaf_logs_level_problem', 'bad'],
];

/** The "Show" choices: the least serious level each one includes. Everything normal is the default. */
export const LOG_SHOW: readonly [LogShow, Translations, Level][] = [
  ['problems', 'frameleaf_logs_show_problems', Level.Error],
  ['warnings', 'frameleaf_logs_show_warnings', Level.Warn],
  ['normal', 'frameleaf_logs_show_normal', Level.Log],
  ['detailed', 'frameleaf_logs_show_detailed', Level.Verbose],
];

/** How far back a download goes. The server takes 1 to 168 hours. */
export const DOWNLOAD_SPANS: readonly [number, Translations][] = [
  [24, 'frameleaf_logs_download_day'],
  [72, 'frameleaf_logs_download_3_days'],
  [168, 'frameleaf_logs_download_7_days'],
];

const rank = (level: Level) => LEVELS.findIndex(([id]) => id === level);

export const levelWord = (level: Level): { word: Translations; tone: LogTone } => {
  const [, word, tone] = LEVELS.find(([id]) => id === level) ?? LEVELS[2];
  return { word, tone };
};

export const sourceWord = (worker: Worker): Translations =>
  LOG_SOURCES.find(([id]) => id === worker)?.[1] ?? 'frameleaf_logs_source_api';

/** True when the line is at least as serious as the "Show" choice asks for. */
export const shows = (line: ServerLogLine, show: LogShow) =>
  rank(line.level) >= rank(LOG_SHOW.find(([id]) => id === show)?.[2] ?? Level.Log);

const order = (line: ServerLogLine) => `${line.at}|${line.id}`;
const byOrder = (left: ServerLogLine, right: ServerLogLine) => order(left).localeCompare(order(right));

/**
 * Adds lines to the ones already shown: each line once, oldest first, keeping the newest `max`.
 * A page arrives newest first, and the live tail can repeat a line a page already had.
 */
export const mergeLines = (current: ServerLogLine[], incoming: ServerLogLine[], max = MAX_LINES) => {
  const seen = new Set(current.map((line) => line.id));
  const added: ServerLogLine[] = [];
  for (const line of incoming) {
    if (!seen.has(line.id)) {
      seen.add(line.id);
      added.push(line);
    }
  }
  if (added.length === 0) {
    return current;
  }
  added.sort(byOrder);
  const last = current.at(-1);
  // Lines from the live tail are normally newer than everything shown: append without sorting again.
  const merged = !last || order(added[0]) > order(last) ? [...current, ...added] : [...current, ...added].sort(byOrder);
  return merged.length > max ? merged.slice(merged.length - max) : merged;
};

/** The file a download saves as, named for the day and how far back it goes. */
export const downloadName = (hours: number, now = new Date()) =>
  `frameleaf-logs-${now.toISOString().slice(0, 10)}-last-${hours}h.zip`;

/** The live tail's address, with the same source and search as the list. */
export const streamPath = ({ worker, q }: { worker?: Worker; q?: string }) => {
  const search = new URLSearchParams();
  if (worker) {
    search.set('worker', worker);
  }
  if (q) {
    search.set('q', q);
  }
  const query = search.toString();
  return `/admin/logs/stream${query ? `?${query}` : ''}`;
};

/** How long to wait before the next try to follow the server again: 2 s, doubling, at most 30 s. */
export const retryDelay = (attempt: number) => Math.min(30_000, 2000 * 2 ** Math.max(0, attempt));
