/**
 * Make a movie (FL-561): the sheet's choices and the pure helpers its states use. The approved mock is
 * `StudioUpgrades.jsx` / `studio-upgrades.mjs` in the prototype; the server does the real work
 * (`POST /studio/movies`), so nothing here picks moments or cuts.
 */
import type { StudioMovieCreateDto, StudioMovieMood, StudioMovieMusicKind } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';

export type MakeMovieSource =
  | { kind: 'album'; albumId: string; name: string; itemCount: number; previewIds?: readonly string[] }
  | { kind: 'memory'; memoryId: string; name: string; itemCount: number; previewIds?: readonly string[] }
  | {
      kind: 'selection';
      assetIds: readonly string[];
      name: string;
      photoCount: number;
      videoCount: number;
      previewIds?: readonly string[];
    };

export const movieLengths = [
  { seconds: 30, label: 'frameleaf_movie_length_30' },
  { seconds: 60, label: 'frameleaf_movie_length_60' },
  { seconds: 180, label: 'frameleaf_movie_length_180' },
] as const satisfies ReadonlyArray<{ seconds: number; label: Translations }>;
export type MovieLength = (typeof movieLengths)[number]['seconds'];

export type MovieMood = 'calm' | 'warm' | 'upbeat' | 'big';

/** Each mood sets the music Frameleaf makes and how the movie is cut (approved mock). */
export const movieMoods = [
  { id: 'calm', label: 'frameleaf_movie_mood_calm', note: 'frameleaf_movie_mood_calm_note' },
  { id: 'warm', label: 'frameleaf_movie_mood_warm', note: 'frameleaf_movie_mood_warm_note' },
  { id: 'upbeat', label: 'frameleaf_movie_mood_upbeat', note: 'frameleaf_movie_mood_upbeat_note' },
  { id: 'big', label: 'frameleaf_movie_mood_big', note: 'frameleaf_movie_mood_big_note' },
] as const satisfies ReadonlyArray<{ id: MovieMood; label: Translations; note: Translations }>;

export const moodLabel = (mood: MovieMood | null | undefined): Translations =>
  (movieMoods.find((item) => item.id === mood) ?? movieMoods[0]).label;

/** The four progress steps; the music step reads as writing music or finding a song's beat. */
export type MovieStepId = 'moments' | 'music' | 'cuts' | 'title';
export const movieStepOrder: readonly MovieStepId[] = ['moments', 'music', 'cuts', 'title'];

export const movieStepLabels = (
  music: 'generated' | 'song',
): Record<MovieStepId, { now: Translations; done: Translations }> => ({
  moments: { now: 'frameleaf_movie_step_moments', done: 'frameleaf_movie_step_moments_done' },
  music:
    music === 'song'
      ? { now: 'frameleaf_movie_step_beat', done: 'frameleaf_movie_step_beat_done' }
      : { now: 'frameleaf_movie_step_music', done: 'frameleaf_movie_step_music_done' },
  cuts: { now: 'frameleaf_movie_step_cuts', done: 'frameleaf_movie_step_cuts_done' },
  title: { now: 'frameleaf_movie_step_title', done: 'frameleaf_movie_step_title_done' },
});

/** How far through the four steps the job is, for the progress bar (0..4). */
export const movieStepsDone = (step: string, done: boolean): number => {
  if (done || step === 'done') {
    return movieStepOrder.length;
  }
  const index = movieStepOrder.indexOf(step as MovieStepId);
  return Math.max(0, index);
};

/** "0:42" style time. */
export const shortTimecode = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
};

/** The shot playing at `time`, or the first. */
export const shotAt = <T extends { start: number; end: number }>(shots: readonly T[], time: number): T | undefined =>
  shots.find((shot) => time >= shot.start && time < shot.end) ?? shots[0];

/** Where something at `time` sits on a strip of a `length`-second movie, as a percentage. */
export const percentOf = (time: number, length: number) =>
  length > 0 ? Math.min(100, Math.max(0, (time / length) * 100)) : 0;

/** Is `beat` one that starts a bar? Bars are listed; a beat within 20 ms of one starts it. */
export const isBarBeat = (beat: number, bars: readonly number[]) => bars.some((bar) => Math.abs(bar - beat) < 0.02);

/** The body of `POST /studio/movies` for a source and the sheet's choices. */
export const movieRequest = (
  source: MakeMovieSource,
  choice: {
    lengthSeconds: MovieLength;
    music: 'generated' | 'song';
    mood: MovieMood;
    songAssetId: string | null;
    title: string;
    previousId?: string;
  },
): StudioMovieCreateDto => ({
  ...(source.kind === 'album' && { albumId: source.albumId }),
  ...(source.kind === 'memory' && { memoryId: source.memoryId }),
  ...(source.kind === 'selection' && { assetIds: [...source.assetIds] }),
  lengthSeconds: choice.lengthSeconds,
  // The SDK's enums carry exactly these values.
  music: choice.music as StudioMovieMusicKind,
  ...(choice.music === 'generated'
    ? { mood: choice.mood as StudioMovieMood }
    : { songAssetId: choice.songAssetId ?? undefined }),
  ...(choice.title.trim() && { title: choice.title.trim() }),
  sourceName: source.name,
  ...(choice.previousId && { previousId: choice.previousId }),
});
