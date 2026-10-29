/**
 * Captions in other languages (FL-641): what crosses the editor frame, and what an export takes.
 *
 * The editor keeps each translated language as its own caption track: one subtitle segment whose
 * `source.translation` names the language and whether it goes with the export as a subtitle track.
 * The host never interprets the graph otherwise; it reads those tracks here to save their subtitle
 * files next to an export. This file is imported by the adapter build too, so it stays free of Svelte
 * and of runtime imports from the web app.
 */

/** English and the ten app languages (owner decision 2026-10-29), as BCP 47 primary tags. */
export const STUDIO_CAPTION_LANGUAGES = ['en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'pl', 'sv', 'da', 'nb'] as const;
export type StudioCaptionLanguageCode = (typeof STUDIO_CAPTION_LANGUAGES)[number];

/** The editor sends at most this many lines in one call; the server takes up to 2000. */
export const STUDIO_CAPTION_TRANSLATION_MAX_LINES = 500;
export const STUDIO_CAPTION_TRANSLATION_MAX_LINE_CHARS = 1000;

export interface StudioCaptionTranslationRequest {
  source: StudioCaptionLanguageCode;
  target: StudioCaptionLanguageCode;
  lines: string[];
}

export interface StudioCaptionTranslationResult {
  lines: string[];
}

export const isStudioCaptionLanguage = (value: unknown): value is StudioCaptionLanguageCode =>
  typeof value === 'string' && (STUDIO_CAPTION_LANGUAGES as readonly string[]).includes(value);

/** Check what the editor asked for before it reaches the server: two languages and the lines, nothing else. */
export const isStudioCaptionTranslationRequest = (value: unknown): value is StudioCaptionTranslationRequest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const request = value as Record<string, unknown>;
  return (
    Object.keys(request).every((key) => ['source', 'target', 'lines'].includes(key)) &&
    isStudioCaptionLanguage(request.source) &&
    isStudioCaptionLanguage(request.target) &&
    request.source !== request.target &&
    Array.isArray(request.lines) &&
    request.lines.length > 0 &&
    request.lines.length <= STUDIO_CAPTION_TRANSLATION_MAX_LINES &&
    request.lines.every((line) => typeof line === 'string' && line.length <= STUDIO_CAPTION_TRANSLATION_MAX_LINE_CHARS)
  );
};

/* ------------------------------------------------------------------ */
/* Export: the subtitle files of the ticked languages                    */
/* ------------------------------------------------------------------ */

export interface StudioCaptionLanguageTrack {
  language: StudioCaptionLanguageCode;
  /** Shown, so burned into the picture. */
  inPicture: boolean;
  /** Ticked "Subtitle track in the export". */
  subtitle: boolean;
  /** Cues on the sequence clock, in seconds, sorted. */
  cues: Array<{ startSeconds: number; endSeconds: number; text: string }>;
}

type GraphItem = {
  type?: unknown;
  trackId?: unknown;
  from?: unknown;
  durationInFrames?: unknown;
  source?: { type?: unknown; translation?: { language?: unknown; subtitle?: unknown } };
  cues?: Array<{ startSeconds?: unknown; endSeconds?: unknown; text?: unknown }>;
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The translated caption tracks of a stored graph (`timeline.items`, `timeline.tracks`). */
export function studioCaptionLanguageTracks(graph: unknown): StudioCaptionLanguageTrack[] {
  const root = graph as { timeline?: { items?: unknown; tracks?: unknown }; metadata?: { fps?: unknown } } | null;
  const items = Array.isArray(root?.timeline?.items) ? (root.timeline.items as GraphItem[]) : [];
  const tracks = Array.isArray(root?.timeline?.tracks)
    ? (root.timeline.tracks as Array<{ id?: unknown; visible?: unknown }>)
    : [];
  const fps = finite(root?.metadata?.fps) && root.metadata.fps > 0 ? root.metadata.fps : 30;
  const out: StudioCaptionLanguageTrack[] = [];
  for (const item of items) {
    const translation = item?.source?.translation;
    if (item?.type !== 'subtitle' || item.source?.type !== 'subtitle-import' || !translation) {
      continue;
    }
    if (!isStudioCaptionLanguage(translation.language) || !finite(item.from) || !finite(item.durationInFrames)) {
      continue;
    }
    const start = item.from / fps;
    const end = (item.from + item.durationInFrames) / fps;
    const cues = (Array.isArray(item.cues) ? item.cues : [])
      .filter((cue) => finite(cue?.startSeconds) && finite(cue?.endSeconds) && typeof cue?.text === 'string')
      .map((cue) => ({
        startSeconds: Math.max(start, start + (cue.startSeconds as number)),
        endSeconds: Math.min(end, start + (cue.endSeconds as number)),
        text: (cue.text as string).trim(),
      }))
      .filter((cue) => cue.text.length > 0 && cue.endSeconds > cue.startSeconds)
      .sort((a, b) => a.startSeconds - b.startSeconds);
    const track = tracks.find((candidate) => candidate?.id === item.trackId);
    out.push({
      language: translation.language,
      inPicture: track?.visible !== false,
      subtitle: translation.subtitle !== false,
      cues,
    });
  }
  return out;
}

/**
 * The subtitle files an export carries: every ticked language. With a range, cues are trimmed to it and
 * start from its beginning, as the exported video does.
 */
export function studioCaptionExportSidecars(
  graph: unknown,
  range?: { inPoint: number; outPoint: number } | null,
): Array<{ language: StudioCaptionLanguageCode; srt: string }> {
  const root = graph as { metadata?: { fps?: unknown } } | null;
  const fps = finite(root?.metadata?.fps) && (root?.metadata?.fps as number) > 0 ? (root!.metadata!.fps as number) : 30;
  const from = range ? range.inPoint / fps : 0;
  const to = range ? range.outPoint / fps : Infinity;
  return studioCaptionLanguageTracks(graph)
    .filter((track) => track.subtitle)
    .map((track) => ({
      language: track.language,
      cues: track.cues
        .map((cue) => ({
          startSeconds: Math.max(cue.startSeconds, from) - from,
          endSeconds: Math.min(cue.endSeconds, to) - from,
          text: cue.text,
        }))
        .filter((cue) => cue.endSeconds > cue.startSeconds),
    }))
    .filter((track) => track.cues.length > 0)
    .map((track) => ({ language: track.language, srt: serializeStudioSrt(track.cues) }));
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0');
const srtTime = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds * 1000));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60_000) % 60;
  const h = Math.floor(total / 3_600_000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
};

/** SRT, in the same shape as the server's caption sidecar (`studio/runtime/subtitle-sidecar.mjs`). */
export function serializeStudioSrt(cues: ReadonlyArray<{ startSeconds: number; endSeconds: number; text: string }>) {
  return cues
    .map((cue, index) =>
      [String(index + 1), `${srtTime(cue.startSeconds)} --> ${srtTime(cue.endSeconds)}`, cue.text].join('\n'),
    )
    .join('\n\n');
}

/** The file name of one language's subtitles next to an export: `Lake day.fr.srt`. */
export const studioCaptionSidecarName = (exportName: string, language: StudioCaptionLanguageCode) =>
  `${exportName.replaceAll(/[\\/:*?"<>|]+/g, ' ').trim() || 'Studio'}.${language}.srt`;
