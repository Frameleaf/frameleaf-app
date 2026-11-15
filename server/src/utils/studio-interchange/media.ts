/**
 * Finding each file an imported project uses in the library (FL-1543). Pure: the job gives it the
 * project's media references and the owner's candidate assets, and it says for each file whether it
 * was found, is a likely match (and how sure), or is not in the library.
 *
 * Tiers: exact bytes when the file came inside the archive (the job checks those by checksum before
 * calling this); then the file name with its length, size and picture dimensions; then the same name
 * with another extension (a re-encoded copy). Only "found" is used without asking.
 */
import type { InterchangeProject, MediaReference, Stack, Track } from 'src/utils/studio-interchange/model.js';
import { seconds } from 'src/utils/studio-interchange/model.js';

type External = Extract<MediaReference, { kind: 'external' }>;

export type InterchangeMediaFile = {
  key: string;
  name: string;
  kind?: 'video' | 'audio' | 'image';
  durationSeconds?: number;
  width?: number;
  height?: number;
  /** How many clips use it. */
  clips: number;
};

export type InterchangeCandidate = {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'image' | 'other';
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
};

export type InterchangeMatchStatus = 'found' | 'very-likely' | 'likely' | 'possible' | 'missing';
export type InterchangeMatch = {
  status: InterchangeMatchStatus;
  assetId: string | null;
  /** The library item's own file name, so the person can see what is offered. */
  assetName: string | null;
  confidence: number;
};

/** Every file the project's clips use, once each, in the order they first appear. */
export const interchangeMediaFiles = (project: InterchangeProject): InterchangeMediaFile[] => {
  const files = new Map<string, InterchangeMediaFile>();
  const visit = (tracks: readonly Track[]) => {
    for (const track of tracks) {
      for (const item of track.children) {
        if (item.type === 'stack') {
          visit((item as Stack).tracks);
          continue;
        }
        if (item.type !== 'clip' || item.mediaReference.kind !== 'external') {
          continue;
        }
        const reference: External = item.mediaReference;
        const known = files.get(reference.key);
        if (known) {
          known.clips++;
          continue;
        }
        const duration = reference.availableRange ? seconds(reference.availableRange.duration) : undefined;
        files.set(reference.key, {
          key: reference.key,
          name: reference.name,
          kind: reference.facts?.kind ?? (track.kind === 'audio' ? 'audio' : undefined),
          ...(duration && duration > 0 && { durationSeconds: duration }),
          ...(reference.facts?.width && { width: reference.facts.width }),
          ...(reference.facts?.height && { height: reference.facts.height }),
          clips: 1,
        });
      }
    }
  };
  for (const timeline of project.timelines) {
    visit(timeline.tracks);
  }
  return files.values().toArray();
};

const SOURCES = new Set<InterchangeProject['source']>([
  'premiere',
  'resolve',
  'finalcut',
  'imovie',
  'otio',
  'fcp7',
  'edl',
  'aaf',
]);

/** A project imported from another editor records `editor:<source>:<sha256>` as its lineage. */
export const studioEditorImportDigest = (source: InterchangeProject['source'], sha256: string) =>
  `editor:${source}:${sha256}`;
export const studioEditorImportSourceOf = (digest: string | null | undefined): InterchangeProject['source'] | null => {
  const source = digest?.startsWith('editor:') ? digest.split(':', 2)[1] : undefined;
  return source && SOURCES.has(source as InterchangeProject['source'])
    ? (source as InterchangeProject['source'])
    : null;
};

/** The app a person knows, for the album of added files; interchange formats say only "imported". */
export const STUDIO_EDITOR_APP_NAMES: Partial<Record<InterchangeProject['source'], string>> = {
  premiere: 'Premiere Pro',
  resolve: 'DaVinci Resolve',
  finalcut: 'Final Cut Pro',
  imovie: 'iMovie',
};

export const fileStem = (name: string) => name.replace(/\.[^./\\]+$/, '').toLowerCase();

/** How sure a candidate is the file, from 0 to 1. */
export const scoreCandidate = (file: InterchangeMediaFile, candidate: InterchangeCandidate) => {
  let score: number;
  if (candidate.name.toLowerCase() === file.name.toLowerCase()) {
    score = 0.6;
  } else if (fileStem(candidate.name) === fileStem(file.name)) {
    // Same name, another extension: a re-encoded or converted copy.
    score = 0.35;
  } else {
    return 0;
  }
  if (
    file.kind &&
    candidate.kind !== 'other' &&
    file.kind !== candidate.kind &&
    !(file.kind === 'audio' && candidate.kind === 'video')
  ) {
    score -= 0.5;
  }
  if (file.durationSeconds && candidate.durationSeconds) {
    const off = Math.abs(file.durationSeconds - candidate.durationSeconds);
    score += off <= 0.05 ? 0.25 : off <= 1 ? 0.1 : -0.3;
  }
  if (file.width && file.height && candidate.width && candidate.height) {
    const same =
      (file.width === candidate.width && file.height === candidate.height) ||
      (file.width === candidate.height && file.height === candidate.width);
    score += same ? 0.15 : -0.1;
  }
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
};

const statusFor = (score: number): InterchangeMatchStatus =>
  score >= 0.95
    ? 'found'
    : score >= 0.8
      ? 'very-likely'
      : score >= 0.6
        ? 'likely'
        : score >= 0.3
          ? 'possible'
          : 'missing';

/**
 * The best candidate for a file. Two candidates nearly as good as each other are never used without
 * asking: the match is offered as "likely" at most.
 */
export const matchInterchangeFile = (
  file: InterchangeMediaFile,
  candidates: readonly InterchangeCandidate[],
): InterchangeMatch => {
  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(file, candidate) }))
    .filter((item) => item.score > 0)
    .toSorted((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
  const best = ranked[0];
  if (!best) {
    return { status: 'missing', assetId: null, assetName: null, confidence: 0 };
  }
  let status = statusFor(best.score);
  if (ranked[1] && best.score - ranked[1].score < 0.05 && (status === 'found' || status === 'very-likely')) {
    status = 'likely';
  }
  return status === 'missing'
    ? { status, assetId: null, assetName: null, confidence: best.score }
    : { status, assetId: best.candidate.id, assetName: best.candidate.name, confidence: best.score };
};
