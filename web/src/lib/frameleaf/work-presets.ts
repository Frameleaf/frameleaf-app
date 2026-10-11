/**
 * "How hard this server works" (FL-364): Light, Balanced and Fast are three sets of the 21
 * "how many at once" numbers the server already keeps (`job.<kind>.concurrency`). Choosing one
 * writes those numbers and nothing else; a server whose numbers match none of them is on its own
 * numbers ("Custom"), which are left alone until a choice replaces them.
 *
 * Balanced is the server's own defaults (`server/src/dtos/config.dto.ts`, `job`). Light and Fast are
 * not half and double: each kind of work is moved by what it actually competes for.
 *
 * - Thumbnails, video conversion and saving edits use the processor hard, and one video conversion
 *   already uses every core. Light keeps two thumbnails (people wait to see an upload appear) and
 *   never drops edits, which someone is waiting for. Fast doubles thumbnails but only adds one video.
 * - Reading photo details, detail files, library scans and moving files mostly wait on the disk, so
 *   they scale furthest: 2 on Light, 8 on Fast.
 * - AI work is limited by the one AI service behind it. Light runs one of each, so browsing and
 *   search stay quick. Fast runs four of the quick kinds (faces, search, private-photo checks) but
 *   only three captions and two of the kinds that hold a large model or a whole video in memory.
 * - Checks that read every original (health checks, damaged-file checks) are held to what one disk
 *   can serve without slowing playback: 1 on Light, 3 and 2 on Fast.
 * - Housekeeping, search updates, notifications and workflows are tiny, and people notice when they
 *   lag (an email, a search result, Trash emptying). They stay at 5 on every choice.
 */
import { QueueName } from '@frameleaf/sdk';

export type WorkPreset = 'light' | 'balanced' | 'fast';
export const WORK_PRESETS: readonly WorkPreset[] = ['light', 'balanced', 'fast'];

/** The kinds of work whose number can be set; the server runs the others one at a time, in order. */
export type TunableWork =
  | QueueName.ThumbnailGeneration
  | QueueName.MetadataExtraction
  | QueueName.VideoConversion
  | QueueName.FaceDetection
  | QueueName.SmartSearch
  | QueueName.VideoDuplicateDetection
  | QueueName.BackgroundTask
  | QueueName.Migration
  | QueueName.Search
  | QueueName.Sidecar
  | QueueName.Library
  | QueueName.Notifications
  | QueueName.Ocr
  | QueueName.ImageEnrichment
  | QueueName.ImageDescription
  | QueueName.NsfwDetection
  | QueueName.MediaHealth
  | QueueName.Workflow
  | QueueName.Editor
  | QueueName.IntegrityCheck
  | QueueName.PetRecognition;

/** [Light, Balanced, Fast] for each kind. The one place these numbers live. */
const AT_ONCE: Record<TunableWork, readonly [number, number, number]> = {
  [QueueName.ThumbnailGeneration]: [2, 3, 6],
  [QueueName.VideoConversion]: [1, 1, 2],
  [QueueName.Editor]: [2, 2, 3],
  [QueueName.MetadataExtraction]: [2, 5, 8],
  [QueueName.Sidecar]: [2, 5, 8],
  [QueueName.Library]: [2, 5, 8],
  [QueueName.Migration]: [2, 5, 8],
  [QueueName.FaceDetection]: [1, 2, 4],
  [QueueName.SmartSearch]: [1, 2, 4],
  [QueueName.NsfwDetection]: [1, 2, 4],
  [QueueName.ImageEnrichment]: [1, 2, 4],
  [QueueName.ImageDescription]: [1, 2, 3],
  [QueueName.Ocr]: [1, 1, 2],
  [QueueName.PetRecognition]: [1, 1, 2],
  [QueueName.VideoDuplicateDetection]: [1, 1, 2],
  [QueueName.MediaHealth]: [1, 2, 3],
  [QueueName.IntegrityCheck]: [1, 1, 2],
  [QueueName.BackgroundTask]: [5, 5, 5],
  [QueueName.Search]: [5, 5, 5],
  [QueueName.Notifications]: [5, 5, 5],
  [QueueName.Workflow]: [5, 5, 5],
};

export const TUNABLE_WORK = Object.keys(AT_ONCE) as TunableWork[];

/** The most the page offers for one kind. A number already saved above it is shown and kept. */
export const AT_ONCE_MOST = 16;

export type WorkNumbers = Record<string, { concurrency: number } | undefined>;

/** How many of each kind run at once on a preset. */
export const presetNumbers = (preset: WorkPreset): Record<TunableWork, number> => {
  const index = WORK_PRESETS.indexOf(preset);
  return Object.fromEntries(TUNABLE_WORK.map((name) => [name, AT_ONCE[name][index]])) as Record<TunableWork, number>;
};

/**
 * The preset the saved numbers are, or undefined for the server's own numbers. Only the kinds the
 * server lets be set are compared, so a server that does not have one of them yet still matches.
 */
export const presetOf = (numbers: WorkNumbers | undefined): WorkPreset | undefined => {
  if (!numbers) {
    return undefined;
  }
  const set = TUNABLE_WORK.filter((name) => numbers[name] !== undefined);
  if (set.length === 0) {
    return undefined;
  }
  return WORK_PRESETS.find((preset) => {
    const wanted = presetNumbers(preset);
    return set.every((name) => numbers[name]?.concurrency === wanted[name]);
  });
};

/** Writes a preset into the settings draft's numbers, leaving kinds the server does not offer alone. */
export const applyPreset = (numbers: WorkNumbers, preset: WorkPreset) => {
  const wanted = presetNumbers(preset);
  for (const name of TUNABLE_WORK) {
    const entry = numbers[name];
    if (entry) {
      entry.concurrency = wanted[name];
    }
  }
};
