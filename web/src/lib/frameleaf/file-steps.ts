import { MediaHealthCategory, type FileProblemRowDto, type FileStepDto } from '@frameleaf/sdk';
import { t, type MessageFormatter, type Translations } from 'svelte-i18n';
import { get } from 'svelte/store';

/** The Pill tones (`settings/kit/Pill.svelte`). */
type KitTone = 'good' | 'warn' | 'bad' | 'off';

/**
 * The plain words of a damaged or missing file's history (FL-1338, design §1). The server stores what
 * happened as `step + outcome + facts` and never a sentence; this turns each one into the mock's
 * history row (`settings-v2/care/files.jsx`): what happened, a line of detail and how it ended.
 *
 * The i18n keys are `frameleaf_file_step_<step>_<outcome>_what|_detail|_result`, with the step and
 * outcome in snake case and a suffix where the facts choose between sentences (`_detail_cut_short`).
 * A step or outcome this version has no words for is left out of the history rather than guessed at.
 */

export type StepWords = { what: string; detail?: string; result?: { tone: KitTone; text: string } };

/** What earlier steps of the same history knew, and how to say a date. */
export type StepContext = {
  category?: MediaHealthCategory | string;
  /** Where the library came from, from its `imported` step ("the folders Immich used"). */
  source?: string;
  /** Why the file would not open, from an earlier `wont-open` or `checked` step. */
  cause?: string;
  /** Whether phones were asked and waited for before this step. */
  waited?: boolean;
  /** The step before this one was a phone sending the photo back. */
  fromPhone?: boolean;
  /**
   * When the problem's history began (its first step). Cloud Backup is said to have begun "after this file was
   * already lost" only when it began after that; without it, the sentence has no date.
   */
  began?: string;
  locale?: string;
  now?: Date;
};

type Facts = Record<string, unknown>;

/** The outcomes each step is told for (server `utils/file-steps.ts`). */
const KNOWN: Readonly<Record<string, readonly string[]>> = {
  added: ['ok'],
  imported: ['ok', 'failed'],
  moved: ['ok'],
  'not-on-drive': ['failed'],
  'wont-open': ['failed'],
  checked: ['ok', 'failed'],
  'looked-where-moving': ['ok', 'not-found'],
  'searched-copy': ['ok', 'not-found'],
  'checked-backups': ['ok', 'not-found'],
  restored: ['ok'],
  'asked-phones': ['waiting', 'not-found', 'ok'],
  'checked-on-phone': ['not-found'],
  repaired: ['ok'],
  'kept-damaged': ['info'],
  'put-back': ['ok'],
  unsupported: ['info'],
  undone: ['info'],
  'kept-as-is': ['info'],
  removed: ['info'],
};

/** How each step's result reads; a step without one ends with no pill. */
const TONES: Readonly<Record<string, KitTone>> = {
  imported_failed: 'warn',
  moved_ok: 'good',
  not_on_drive_failed: 'warn',
  wont_open_failed: 'warn',
  checked_ok: 'good',
  checked_failed: 'warn',
  looked_where_moving_not_found: 'off',
  looked_where_moving_ok: 'good',
  searched_copy_ok: 'good',
  searched_copy_not_found: 'off',
  checked_backups_ok: 'good',
  checked_backups_not_found: 'off',
  restored_ok: 'good',
  asked_phones_waiting: 'warn',
  asked_phones_not_found: 'off',
  asked_phones_ok: 'good',
  checked_on_phone_not_found: 'off',
  repaired_ok: 'good',
  put_back_ok: 'good',
  unsupported_info: 'off',
};

/** The causes a file check names (server `utils/file-problem.ts`), each with its own sentence. */
const WONT_OPEN_CAUSES = new Set(['cut-short', 'junk-in-front', 'broken-details', 'changed']);
const CHECKED_CAUSES = new Set([
  'blank',
  'cut-short',
  'junk-in-front',
  'broken-details',
  'unreadable',
  'changed',
  'busy',
]);
const REPAIRABLE_CAUSES = new Set(['cut-short', 'junk-in-front', 'broken-details']);
/** The formats Frameleaf never decodes, named as people know them; any other is its extension. */
const KINDS: Readonly<Record<string, Translations>> = {
  '.psd': 'frameleaf_file_kind_psd',
  '.ai': 'frameleaf_file_kind_ai',
  '.indd': 'frameleaf_file_kind_indd',
};
const JPEG_NAME = /\.(jpe?g|jpe|jfif)$/i;

const snake = (value: string) => value.replaceAll('-', '_');
const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value : undefined);
const numberOf = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * A place inside the owner's own folders, as the history says it: "Library › 2019 › 03", with the file
 * name when the facts have one. The server stores it relative to the library root (`folderFacts`).
 */
export const folderPath = (facts: Facts, translate: MessageFormatter = get(t)): string | undefined => {
  const folder = typeof facts.folder === 'string' ? facts.folder : undefined;
  const name = text(facts.name);
  if (folder === undefined && name === undefined) {
    return;
  }
  const parts = [translate('frameleaf_file_path_library'), ...(folder ?? '').split('/').filter(Boolean)];
  return [...parts, ...(name ? [name] : [])].join(' › ');
};

/** "6 Nov", with the year when it is not this year. */
const shortDay = (value: string, { locale, now = new Date() }: StepContext) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return;
  }
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  }).format(date);
};

/** The kind of file Frameleaf can't show, by its extension: "Photoshop", or "TGA". */
const kindOf = (facts: Facts, translate: MessageFormatter) => {
  const extension = text(facts.extension)?.toLowerCase();
  if (!extension) {
    return;
  }
  const named = KINDS[extension] as Translations | undefined;
  return named ? translate(named) : extension.replace(/^\./, '').toUpperCase();
};

/**
 * One step in plain words: what happened, a line of detail and how it ended. `context` carries what the
 * history's earlier steps knew (see `storyWords`). Undefined for a step this version has no words for.
 */
export const stepWords = (
  step: Pick<FileStepDto, 'step' | 'outcome' | 'facts'>,
  context: StepContext = {},
  translate: MessageFormatter = get(t),
): StepWords | undefined => {
  // the design calls the first two `info`; the server writes `ok`
  const outcome = (step.step === 'added' || step.step === 'imported') && step.outcome === 'info' ? 'ok' : step.outcome;
  if (!KNOWN[step.step]?.includes(outcome)) {
    return;
  }
  const facts: Facts = step.facts ?? {};
  const base = `frameleaf_file_step_${snake(step.step)}_${snake(outcome)}`;
  const say = (part: string, values?: Record<string, string | number>) =>
    translate(`${base}_${part}` as Translations, values ? { values } : undefined);
  const path = folderPath(facts, translate);

  // set below where the facts choose the words; otherwise the step's own
  let what: string | undefined;
  let detail: string | undefined;
  let tone = TONES[`${snake(step.step)}_${snake(outcome)}`] as KitTone | undefined;
  let resultPart: string | undefined = tone ? 'result' : undefined;

  switch (step.step) {
    case 'imported': {
      const source = text(facts.source);
      if (outcome === 'ok') {
        detail = source ? say('detail', { source }) : undefined;
      } else {
        detail = source ? say('detail', { source }) : say('detail_unnamed');
      }
      break;
    }
    case 'moved': {
      detail = path ? say('detail', { path }) : undefined;
      break;
    }
    case 'not-on-drive': {
      detail = path ? say('detail', { path }) : say('detail_unnamed');
      break;
    }
    case 'wont-open': {
      const cause = text(facts.cause);
      if (cause) {
        detail = say(`detail_${snake(WONT_OPEN_CAUSES.has(cause) ? cause : 'unreadable')}`);
        resultPart = cause === 'changed' ? 'result_changed' : 'result';
      } else {
        // a file check found it, and says where
        detail = path ? say('detail_check', { path }) : say('detail_check_unnamed');
      }
      break;
    }
    case 'checked': {
      if (outcome === 'ok') {
        detail = say('detail');
        break;
      }
      const cause = text(facts.cause);
      const known = cause && CHECKED_CAUSES.has(cause) ? cause : 'unreadable';
      detail = say(`detail_${snake(known)}`);
      if (['blank', 'changed', 'busy'].includes(known)) {
        resultPart = `result_${known}`;
      }
      tone = known === 'blank' ? 'bad' : known === 'busy' ? 'off' : 'warn';
      break;
    }
    case 'looked-where-moving': {
      const source = context.source ?? text(facts.source);
      what = source ? say('what', { source }) : say('what_unnamed');
      detail = path ? (source ? say('detail', { source, path }) : say('detail_unnamed', { path })) : undefined;
      break;
    }
    case 'searched-copy': {
      const copies = numberOf(facts.copies) ?? 1;
      const chosen = Array.isArray(facts.places) ? undefined : text(facts.folder);
      if (chosen) {
        // Look in a folder: the folder the person chose, by its name
        detail = say('detail_folder', { folder: chosen, count: copies });
      } else if (outcome === 'ok' && copies === 1 && path) {
        detail = say('detail_one', { path });
      } else {
        detail = outcome === 'ok' ? say('detail', { count: copies }) : say('detail');
      }
      break;
    }
    case 'checked-backups': {
      if (outcome === 'ok') {
        detail = say('detail');
        break;
      }
      const since = text(facts.since);
      // a photo that arrived after the backups began wasn't "already lost" when they did
      const after = !!since && !!context.began && new Date(since).getTime() > new Date(context.began).getTime();
      const date = after ? shortDay(since, context) : undefined;
      detail = date ? say('detail', { date }) : say('detail_undated');
      break;
    }
    case 'restored': {
      detail = context.category === MediaHealthCategory.Missing ? say('detail_missing') : say('detail');
      break;
    }
    case 'asked-phones': {
      if (outcome === 'ok') {
        const device = text(facts.device);
        detail = device ? say('detail', { device }) : say('detail_unnamed');
      } else if (outcome === 'not-found') {
        // without a phone to ask there was nothing to wait for
        detail = context.waited === false ? say('detail_none') : say('detail');
      } else {
        detail = say('detail');
      }
      break;
    }
    case 'checked-on-phone': {
      const device = text(facts.device);
      what = device ? say('what', { device }) : say('what_unnamed');
      detail = device ? say('detail', { device }) : say('detail_unnamed');
      break;
    }
    case 'repaired': {
      const by = text(facts.by);
      what = by ? say('what_by', { person: by }) : say('what');
      detail = repairedDetail(facts, context, say);
      break;
    }
    case 'kept-damaged':
    case 'kept-as-is': {
      detail = say('detail');
      break;
    }
    case 'put-back': {
      if (facts.copied === true) {
        // a lost original found in the folders an import used was copied in; the old file stays where it was
        const by = text(facts.by);
        what = say('what_copied');
        detail = by ? say('detail_copied_by', { person: by }) : say('detail_copied');
        break;
      }
      detail =
        context.category === MediaHealthCategory.Corrupt
          ? say('detail_changed')
          : context.fromPhone
            ? say('detail_phone')
            : say('detail');
      break;
    }
    case 'unsupported': {
      const kind = kindOf(facts, translate);
      detail = kind ? say('detail', { kind }) : undefined;
      break;
    }
    case 'undone': {
      const by = text(facts.by);
      what = by ? say('what', { person: by }) : say('what_unnamed');
      break;
    }
    // added and removed are only what happened
  }

  return {
    what: what ?? say('what'),
    ...(detail && { detail }),
    ...(resultPart && tone && { result: { tone, text: say(resultPart) } }),
  };
};

/** How a repair was made, in the mock's words for each FL-1273 method. */
const repairedDetail = (
  facts: Facts,
  context: StepContext,
  say: (part: string, values?: Record<string, string | number>) => string,
) => {
  const lost = facts.metadataLost === true;
  switch (facts.method) {
    case 'rebuilt': {
      const percent = numberOf(facts.percentSaved);
      if (percent === undefined || percent >= 100) {
        return say('detail_rebuilt_whole');
      }
      return say(lost ? 'detail_rebuilt_lost' : 'detail_rebuilt', { percent });
    }
    case 'lossless': {
      if (context.cause === 'junk-in-front') {
        return say('detail_junk_in_front');
      }
      if (context.cause === 'broken-details') {
        return say(lost ? 'detail_broken_details_lost' : 'detail_broken_details');
      }
      return say('detail_lossless');
    }
    case 'preview': {
      return say('detail_preview');
    }
    case 'converted': {
      return say('detail_converted');
    }
  }
};

/**
 * A problem's whole history in plain words, oldest first, each step told with what the steps before it
 * knew. Steps this version has no words for are left out.
 */
export const storyWords = (
  problem: { category: MediaHealthCategory | string; steps: FileStepDto[] },
  translate: MessageFormatter = get(t),
  { locale, now }: Pick<StepContext, 'locale' | 'now'> = {},
): Array<{ step: FileStepDto; words: StepWords }> => {
  const source = problem.steps
    .map(({ step, facts }) => (step === 'imported' ? text(facts?.source) : undefined))
    .find(Boolean);
  // when the history began: its earliest step
  let began: string | undefined;
  for (const { at } of problem.steps) {
    const time = new Date(at).getTime();
    if (!Number.isNaN(time) && (began === undefined || time < new Date(began).getTime())) {
      began = at;
    }
  }
  let cause: string | undefined;
  let waited = false;
  let previous: FileStepDto | undefined;
  const told: Array<{ step: FileStepDto; words: StepWords }> = [];
  for (const step of problem.steps) {
    const words = stepWords(
      step,
      {
        category: problem.category,
        source,
        cause,
        waited,
        fromPhone: previous?.step === 'asked-phones' && previous.outcome === 'ok',
        began,
        locale,
        now,
      },
      translate,
    );
    if (words) {
      told.push({ step, words });
    }
    if ((step.step === 'wont-open' || step.step === 'checked') && text(step.facts?.cause)) {
      cause = text(step.facts.cause);
    }
    if (step.step === 'asked-phones' && step.outcome === 'waiting') {
      waited = true;
    }
    previous = step;
  }
  return told;
};

/** A row's one-line story, told from the step the server picked for it (`line`). */
export const lineWords = (
  row: Pick<FileProblemRowDto, 'line' | 'category' | 'partSaved'>,
  translate: MessageFormatter = get(t),
): string | undefined => {
  const line = row.line;
  if (!line) {
    return;
  }
  const facts: Facts = line.facts ?? {};
  const percent = numberOf(facts.percentSaved);
  if (
    line.step === 'repaired' &&
    row.partSaved &&
    facts.method === 'rebuilt' &&
    percent !== undefined &&
    percent < 100
  ) {
    return translate('frameleaf_files_line_part_saved', { values: { percent } });
  }
  if (line.step === 'checked' && line.outcome === 'failed' && facts.cause === 'blank') {
    return translate('frameleaf_files_line_blank');
  }
  if (line.step === 'restored' && row.category !== MediaHealthCategory.Missing) {
    return translate('frameleaf_files_line_restored_changed');
  }
  if (line.step === 'unsupported') {
    const kind = kindOf(facts, translate);
    if (kind) {
      return translate('frameleaf_files_line_unsupported', { values: { kind } });
    }
  }
  const words = stepWords(line, { category: row.category }, translate);
  return words?.detail ?? words?.what;
};

/** What the page shows for a problem: its picture, its pill and what can be done. */
export type ProblemKind = 'repaired' | 'found' | 'missing' | 'unrepairable' | 'unchecked' | 'kept';

/** The kind of a problem by how the fixes left it; one no fix has looked at yet needs the person. */
export const problemKind = (row: Pick<FileProblemRowDto, 'fixState' | 'category'>): ProblemKind => {
  switch (row.fixState) {
    case 'repaired':
    case 'part-saved': {
      return 'repaired';
    }
    case 'found-again':
    case 'restored': {
      return 'found';
    }
    case 'missing':
    case 'waiting-phone': {
      return 'missing';
    }
    case 'cant-repair': {
      return 'unrepairable';
    }
    case 'couldnt-check': {
      return 'unchecked';
    }
    case 'left-as-is': {
      return 'kept';
    }
    default: {
      return row.category === MediaHealthCategory.Missing ? 'missing' : 'unrepairable';
    }
  }
};

/**
 * Whether the owner is offered Repair… (FL-1273's reviewed repair, design §3 step 4 and §5): a damaged
 * JPEG in Needs you whose damage is the repairable kind, because automatic repair is off or declined,
 * or whose automatic repair was undone.
 */
export const offersRepair = (
  problem: Pick<FileProblemRowDto, 'fixState' | 'category' | 'originalFileName'> & { steps: FileStepDto[] },
): boolean => {
  if (
    problemKind(problem) !== 'unrepairable' ||
    problem.category !== MediaHealthCategory.Corrupt ||
    !JPEG_NAME.test(problem.originalFileName)
  ) {
    return false;
  }
  const undone = problem.steps.findLastIndex(({ step }) => step === 'undone');
  const repaired = problem.steps.findLastIndex(({ step }) => step === 'repaired');
  if (undone !== -1 && repaired !== -1 && repaired < undone) {
    return true;
  }
  const cause = latestCause(problem.steps);
  return cause !== undefined && REPAIRABLE_CAUSES.has(cause);
};

/** Why the file would not open, as the history last said it (a `wont-open` or `checked` step). */
const latestCause = (steps: FileStepDto[]) =>
  text(
    steps.findLast(({ step, facts }) => (step === 'wont-open' || step === 'checked') && text(facts?.cause))?.facts
      .cause,
  );

/**
 * Whether the owner is offered Look in a folder (design §7): for a missing file, and for a damaged one
 * only when it changed after Frameleaf stored it. A file that arrived damaged has the same damage in
 * every exact copy, so the server refuses to look for one.
 */
export const offersLookIn = (
  problem: Pick<FileProblemRowDto, 'fixState' | 'category'> & { steps: FileStepDto[] },
): boolean => {
  const kind = problemKind(problem);
  if (kind === 'missing') {
    return true;
  }
  return kind === 'unrepairable' && latestCause(problem.steps) === 'changed';
};

/**
 * The name the server gives a repair's kept damaged file when it can't be read from the download's
 * `Content-Disposition`: "<name> (damaged).<extension>", the extension by Node's `path.extname` (none for
 * a dotfile or a name with no dot; the server then borrows the kept file's, which the browser can't see).
 */
export const damagedFileName = (originalFileName: string) => {
  const dot = originalFileName.lastIndexOf('.');
  const extension = dot <= 0 || originalFileName === '..' ? '' : originalFileName.slice(dot);
  return `${originalFileName.slice(0, originalFileName.length - extension.length)} (damaged)${extension}`;
};

/** The file name a `Content-Disposition` header carries: `filename*` (UTF-8) first, then `filename`. */
export const dispositionFileName = (header: string | null | undefined) => {
  if (!header) {
    return;
  }
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch {
      // fall through to the plain name
    }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  const value = plain?.[1]?.replaceAll(/\\(.)/g, '$1') ?? plain?.[2]?.trim();
  return value || undefined;
};
