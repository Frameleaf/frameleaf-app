/**
 * Importing a project from another video editor into Studio (FL-1544, FL-1545; approved mock
 * 2026-11-13). Pure helpers for the Import dialog and the notes in the editor: which files the person
 * chose, how the notes group, the media plan and its totals.
 *
 * The server says what happened by code; every sentence the person reads is phrased here, in their
 * language, from that code and its subject. Clip and file names are the person's own data.
 */

/** Project files the import reads, CDL and LUT files that go with them, and Frameleaf bundles. */
export const EDITOR_IMPORT_PROJECT_EXTENSIONS = ['prproj', 'fcpxml', 'xml', 'otio', 'otioz', 'aaf', 'edl'] as const;
export const EDITOR_IMPORT_SIDECAR_EXTENSIONS = ['cdl', 'cc', 'ccc', 'cube'] as const;
export const EDITOR_IMPORT_ACCEPT = [...EDITOR_IMPORT_PROJECT_EXTENSIONS, ...EDITOR_IMPORT_SIDECAR_EXTENSIONS, 'zip']
  .map((extension) => `.${extension}`)
  .join(',');

export type EditorImportSource = 'premiere' | 'resolve' | 'finalcut' | 'imovie' | 'otio' | 'fcp7' | 'edl' | 'aaf';

const extensionOf = (name: string) => name.split('.').at(-1)?.toLowerCase() ?? '';
const nameOf = (file: File) => (file.webkitRelativePath || file.name).split('/').at(-1) ?? file.name;

/** Inside a folder, the document that is the project: a bundle's own first, then any project file. */
const PRIORITY = [
  /^info\.fcpxml$/i,
  /^content\.otio$/i,
  /\.prproj$/i,
  /\.fcpxml$/i,
  /\.otioz?$/i,
  /\.aaf$/i,
  /\.xml$/i,
  /\.edl$/i,
];

export type EditorImportChoice =
  { kind: 'project'; project: File; sidecars: File[] } | { kind: 'bundle'; bundle: File } | { kind: 'none' };

/**
 * What the person chose: one project file (or the project inside a chosen folder) with any CDL and
 * LUT files beside it, or a Frameleaf bundle, which goes to the bundle import.
 */
export const chooseEditorImportFiles = (files: readonly File[]): EditorImportChoice => {
  const candidates = files.filter((file) =>
    (EDITOR_IMPORT_PROJECT_EXTENSIONS as readonly string[]).includes(extensionOf(nameOf(file))),
  );
  const ranked = [...candidates].sort((a, b) => {
    const rank = (file: File) => {
      const index = PRIORITY.findIndex((pattern) => pattern.test(nameOf(file)));
      return index === -1 ? PRIORITY.length : index;
    };
    return (
      rank(a) - rank(b) ||
      (a.webkitRelativePath || a.name).split('/').length - (b.webkitRelativePath || b.name).split('/').length
    );
  });
  const project = ranked[0];
  if (project) {
    const sidecars = files.filter((file) =>
      (EDITOR_IMPORT_SIDECAR_EXTENSIONS as readonly string[]).includes(extensionOf(nameOf(file))),
    );
    return { kind: 'project', project, sidecars: sidecars.slice(0, 6) };
  }
  const bundle = files.find((file) => extensionOf(nameOf(file)) === 'zip');
  return bundle ? { kind: 'bundle', bundle } : { kind: 'none' };
};

/** Notes Studio cannot carry at all; everything else came over differently. */
const CANT_CODES = new Set(['media-missing', 'effect-dropped', 'generator-dropped', 'transition-dropped']);
const NOTE_CODES = new Set([
  'frame-rate',
  'media-missing',
  'media-shorter',
  'transition-unmatched',
  'transition-shortened',
  'transition-dropped',
  'transition-recentred',
  'audio-crossfade',
  'speed-out-of-range',
  'speed-ramp',
  'font-missing',
  'effect-dropped',
  'generator-dropped',
  'marker-range',
  'grade-approximated',
]);
const NOTICE_CODES = new Set([
  'version-untested',
  'clips-disabled',
  'items-unknown',
  'edl-limits',
  'edl-frame-rate',
  'lut-resampled',
  'sidecar-unused',
  'sidecar-unreadable',
]);

const underscored = (code: string) => code.replaceAll('-', '_');

/** The message for a note's kind; a kind this release does not know reads as "brought over differently". */
export const editorImportNoteKey = (code: string) =>
  NOTE_CODES.has(code)
    ? `frameleaf_studio_editor_import_note_${underscored(code)}`
    : 'frameleaf_studio_editor_import_note_other';
export const editorImportNoticeKey = (code: string) =>
  NOTICE_CODES.has(code)
    ? `frameleaf_studio_editor_import_notice_${underscored(code)}`
    : 'frameleaf_studio_editor_import_notice_other';

export type EditorImportNote = { code: string; clip: string; atSeconds: number };
export type EditorImportNoteGroup = { code: string; names: string[] };

/** Notes grouped by kind, each naming the clips it is about once, in timeline order. */
export const groupEditorImportNotes = (notes: readonly EditorImportNote[]) => {
  const groups = new Map<string, Set<string>>();
  for (const note of [...notes].sort((a, b) => a.atSeconds - b.atSeconds)) {
    const names = groups.get(note.code) ?? new Set<string>();
    names.add(note.clip);
    groups.set(note.code, names);
  }
  const all = [...groups].map(([code, names]) => ({ code, names: [...names] }));
  return {
    differently: all.filter((group) => !CANT_CODES.has(group.code)),
    cant: all.filter((group) => CANT_CODES.has(group.code)),
  };
};

export type EditorImportMediaItem = {
  key: string;
  name: string;
  match: 'found' | 'very-likely' | 'likely' | 'possible' | 'missing';
  assetId: string | null;
  carried: boolean;
};

/**
 * The files of a chosen folder that the import needs: those not in the library, and likely matches
 * the person did not use. Matched by file name, without regard to case; other files are left alone.
 */
export const filesForMissingMedia = (
  media: readonly EditorImportMediaItem[],
  uses: ReadonlySet<string>,
  folder: readonly File[],
) => {
  const byName = new Map<string, File>();
  for (const file of folder) {
    const name = nameOf(file).toLowerCase();
    if (!byName.has(name)) {
      byName.set(name, file);
    }
  }
  const needed = new Map<string, File>();
  for (const item of media) {
    const unresolved = item.match === 'missing' || (item.match !== 'found' && !uses.has(item.key));
    const file = unresolved && !item.carried ? byName.get(item.name.toLowerCase()) : undefined;
    if (file) {
      needed.set(item.key, file);
    }
  }
  return needed;
};

/** Every file ends found, matched, added or as a placeholder; the four always add up. */
export const editorImportMediaPlan = (
  media: readonly EditorImportMediaItem[],
  uses: ReadonlySet<string>,
  sending: ReadonlyMap<string, File>,
) => {
  const plan = { files: media.length, found: 0, matched: 0, upload: 0, carried: 0, placeholders: 0, uploadBytes: 0 };
  for (const item of media) {
    const file = sending.get(item.key);
    if (item.match === 'found') {
      plan.found++;
    } else if (item.match !== 'missing' && uses.has(item.key)) {
      plan.matched++;
    } else if (file) {
      plan.upload++;
      plan.uploadBytes += file.size;
    } else if (item.carried) {
      plan.carried++;
    } else {
      plan.placeholders++;
    }
  }
  return plan;
};

/** What to send when starting the import: each file's choice. */
export const editorImportMediaChoices = (
  media: readonly EditorImportMediaItem[],
  uses: ReadonlySet<string>,
  sent: ReadonlyMap<string, string>,
) =>
  media.map((item) => {
    const added = sent.get(item.key);
    if (added) {
      return { key: item.key, assetId: added, added: true };
    }
    if (item.match === 'found') {
      return { key: item.key, assetId: item.assetId };
    }
    return { key: item.key, assetId: item.match !== 'missing' && uses.has(item.key) ? item.assetId : null };
  });

/** Likely matches start ticked, except a "possible" one, which the person ticks themselves. */
export const defaultEditorImportUses = (media: readonly EditorImportMediaItem[]) =>
  new Set(media.filter((item) => item.match === 'very-likely' || item.match === 'likely').map((item) => item.key));

/** The app's name for a source, which stays in English like every product name; interchange formats have none. */
export const EDITOR_IMPORT_APPS: Partial<Record<EditorImportSource, string>> = {
  premiere: 'Premiere Pro',
  resolve: 'DaVinci Resolve',
  finalcut: 'Final Cut Pro',
  imovie: 'iMovie',
};

type TimelineCounts = { clips: number; transitions: number; titles: number; sound: number; markers: number };

/** What the picked timelines hold, added up. */
export const sumEditorImportCounts = (timelines: readonly TimelineCounts[]) => {
  const sum: TimelineCounts = { clips: 0, transitions: 0, titles: 0, sound: 0, markers: 0 };
  for (const timeline of timelines) {
    sum.clips += timeline.clips;
    sum.transitions += timeline.transitions;
    sum.titles += timeline.titles;
    sum.sound += timeline.sound;
    sum.markers += timeline.markers;
  }
  return sum;
};

/** Where the built projects' media came from, added up. */
export const sumEditorImportMedia = (
  builds: readonly { media: { found: number; matched: number; added: number; placeholders: number } }[],
) => {
  const sum = { used: 0, added: 0, placeholders: 0 };
  for (const { media } of builds) {
    sum.used += media.found + media.matched;
    sum.added += media.added;
    sum.placeholders += media.placeholders;
  }
  return sum;
};

/** A timeline time as the editor shows it: m:ss, or h:mm:ss past an hour. */
export const editorImportClock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
};
