/**
 * Make a movie (FL-561): the pure parts. Picking the best moments, finding the beat of the music,
 * cutting the moments on its bars and writing the result as a Studio project graph in normal form
 * (docs/docs/developer/studio-graph-protocol-v1.md, schema studio/graph-schema-v1.json).
 *
 * The graph is the one the web editor itself would write for the same edit: shots on one video track
 * with their camera sound linked on an audio track, Ken Burns moves on the photos (13.7.2), cross
 * dissolves or dips at the cuts (13.2.3), one music clip under the whole movie with its fade (13.9)
 * and a title at the start (14.3). Bars of the music are marked on the ruler.
 *
 * Pure: no database, no Nest, no randomness beyond the seed the caller passes.
 */
import { createHash } from 'node:crypto';

/** The lengths the sheet offers, in seconds. */
export const STUDIO_MOVIE_LENGTHS = [30, 60, 180] as const;
export type StudioMovieLength = (typeof STUDIO_MOVIE_LENGTHS)[number];

export const STUDIO_MOVIE_MOODS = ['calm', 'warm', 'upbeat', 'big'] as const;
export type StudioMovieMood = (typeof STUDIO_MOVIE_MOODS)[number];

type MoodStyle = {
  /** What the music model is asked for. The model's name never reaches the person. */
  prompt: string;
  /** The tempo the prompt asks for; the cuts follow the beat found in the music, not this. */
  bpm: number;
  /** Studio's transition at each cut, or none for hard cuts. */
  transition: 'Cross dissolve' | 'Dip to black' | null;
  /** Upbeat makes every third shot one bar shorter, to give it some energy. */
  quickerEveryThird: boolean;
};

/** Each mood sets both the music Frameleaf writes and how the movie is cut (approved mock, FL-561). */
export const STUDIO_MOVIE_MOOD_STYLES: Readonly<Record<StudioMovieMood, MoodStyle>> = {
  calm: {
    prompt: 'calm soft solo piano, gentle and warm, slow tempo, 72 bpm, peaceful home movie soundtrack',
    bpm: 72,
    transition: 'Cross dissolve',
    quickerEveryThird: false,
  },
  warm: {
    prompt: 'warm acoustic guitar, heartfelt and hopeful folk, light percussion, 92 bpm, family memories',
    bpm: 92,
    transition: 'Cross dissolve',
    quickerEveryThird: false,
  },
  upbeat: {
    prompt: 'bright upbeat pop, happy, claps, acoustic guitar and drums, energetic, 118 bpm',
    bpm: 118,
    transition: null,
    quickerEveryThird: true,
  },
  big: {
    prompt: 'uplifting cinematic orchestral music, strings and drums that build to a big finish, 84 bpm',
    bpm: 84,
    transition: 'Dip to black',
    quickerEveryThird: false,
  },
};

/** The project canvas: 1080p at 30 frames a second. Export chooses the output size. */
export const STUDIO_MOVIE_CANVAS = { width: 1920, height: 1080 } as const;
export const STUDIO_MOVIE_FPS = 30;
/** Longer songs fade out over this many seconds at the end of the movie (owner decision 2026-10-26). */
export const STUDIO_MOVIE_FADE_SECONDS = 2;
/** Camera sound plays at 25 % under the music: −12 dB. */
export const STUDIO_MOVIE_CAMERA_DB = -12;
/** The music clip's gain. */
export const STUDIO_MOVIE_MUSIC_DB = -2;
/** No video gives more than this many moments, so a long clip cannot fill the movie. */
export const STUDIO_MOVIE_MOMENTS_PER_VIDEO = 2;
/** A video shorter than this has no moment worth a shot. */
const MIN_VIDEO_SECONDS = 2;
/** Length of a transition at a cut, in frames (half a second). */
const TRANSITION_FRAMES = 15;
/** At most this many candidates are kept after ranking: far more than the longest movie uses. */
const RANKED_LIMIT = 400;
/** At most this many bar markers go on the ruler. */
const MAX_MARKERS = 120;

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/* ------------------------------------------------------------------ */
/* Seeded helpers                                                      */
/* ------------------------------------------------------------------ */

/** A 31-bit seed from any text. */
export const studioMovieSeed = (text: string): number =>
  createHash('sha256').update(text, 'utf8').digest().readUInt32BE(0) & 0x7f_ff_ff_ff;

/** Park-Miller generator: the same seed gives the same sequence, so a version is repeatable. */
export const seededRandom = (seed: number) => {
  let state = (Math.abs(Math.floor(seed)) % 2_147_483_646) + 1;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
};

/** An id in the UUID version 4 layout (protocol 4.1), drawn from `seed` and a counter. */
export const studioMovieIds = (seed: string) => {
  let counter = 0;
  return () => {
    const bytes = createHash('sha256').update(`${seed}:${counter++}`, 'utf8').digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
};

/* ------------------------------------------------------------------ */
/* Moments                                                             */
/* ------------------------------------------------------------------ */

/** What the server knows about one photo or video of the source. */
export type StudioMovieAsset = {
  id: string;
  type: 'IMAGE' | 'VIDEO';
  /** The original's file name, the clip's label in Studio. */
  fileName: string;
  /** When it was taken (ISO 8601), for telling the story in order. */
  takenAt: string;
  isFavorite: boolean;
  /** Star rating 0..5, or null. */
  rating: number | null;
  /** A video's length in seconds; null for a photo or when unknown. */
  durationSeconds: number | null;
  /** Best Photos score 0..1, when it has been computed. */
  bestScore: number | null;
  /** For a video: the best frame Best Photos found, in seconds. */
  bestFrameSeconds: number | null;
  /** Visible faces of people in it. */
  faceCount: number;
  /** Its smart search (CLIP) embedding, for keeping near-duplicates apart. */
  embedding: readonly number[] | null;
};

/** A photo, or one moment of a video around `anchorSeconds`. */
export type StudioMovieMoment = {
  asset: StudioMovieAsset;
  kind: 'photo' | 'video';
  /** Where in a video the moment is centred, in seconds; 0 for a photo. */
  anchorSeconds: number;
  score: number;
};

/** The score of an asset: Best Photos, favourites, rating and people, plus a seeded nudge. */
export const momentScore = (asset: StudioMovieAsset, random: () => number): number =>
  (asset.bestScore ?? 0.6) * 60 +
  (asset.isFavorite ? 12 : 0) +
  clamp(asset.rating ?? 0, 0, 5) * 3 +
  Math.min(asset.faceCount, 3) * 4 +
  random() * 18;

/** The moments of one asset: a photo is one; a video is one or two, the best frame first. */
const momentsOf = (asset: StudioMovieAsset, score: number): StudioMovieMoment[] => {
  if (asset.type === 'IMAGE') {
    return [{ asset, kind: 'photo', anchorSeconds: 0, score }];
  }
  const length = asset.durationSeconds ?? 0;
  if (length < MIN_VIDEO_SECONDS) {
    return [];
  }
  const count = Math.min(STUDIO_MOVIE_MOMENTS_PER_VIDEO, Math.max(1, Math.floor(length / 8)));
  const best = asset.bestFrameSeconds !== null ? clamp(asset.bestFrameSeconds, 0, length) : null;
  const anchors =
    count === 1
      ? [best ?? length / 2]
      : best === null
        ? [length / 3, (2 * length) / 3]
        : [best, best < length / 2 ? best + length / 2 : best - length / 2];
  return anchors.map((anchorSeconds, index) => ({
    asset,
    kind: 'video',
    anchorSeconds: round3(anchorSeconds),
    // A video's first moment is worth a little more than a photo; its second much less.
    score: score + 6 - index * 14,
  }));
};

const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [index, value] of a.entries()) {
    if (index >= b.length) {
      break;
    }
    dot += value * b[index];
    na += value * value;
    nb += b[index] * b[index];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
};

/**
 * Every moment of the source, best first. Scores come from Best Photos, favourites, ratings and the
 * people in each; a near-duplicate of a moment already ranked (smart search similarity above 0.9)
 * loses up to 30 points, so a burst of the same scene does not fill the movie. `seed` changes the
 * small nudge that makes "Try another version" pick differently.
 */
export const rankStudioMovieMoments = (assets: readonly StudioMovieAsset[], seed: number): StudioMovieMoment[] => {
  const random = seededRandom(seed);
  const pool = assets
    .flatMap((asset) => momentsOf(asset, momentScore(asset, random)))
    .toSorted((a, b) => b.score - a.score || a.asset.id.localeCompare(b.asset.id) || a.anchorSeconds - b.anchorSeconds)
    .slice(0, RANKED_LIMIT);
  const ranked: StudioMovieMoment[] = [];
  // Highest similarity of each remaining moment to anything already ranked.
  const similarity = pool.map(() => 0);
  const remaining = new Set(pool.map((_, index) => index));
  while (remaining.size > 0) {
    let pick = -1;
    let pickValue = -Infinity;
    for (const index of remaining) {
      const value = pool[index].score - 30 * clamp((similarity[index] - 0.9) / 0.1, 0, 1);
      if (value > pickValue) {
        pick = index;
        pickValue = value;
      }
    }
    remaining.delete(pick);
    const chosen = pool[pick];
    ranked.push(chosen);
    if (!chosen.asset.embedding) {
      continue;
    }
    for (const index of remaining) {
      const other = pool[index].asset;
      if (other.embedding && other.id !== chosen.asset.id) {
        similarity[index] = Math.max(similarity[index], cosine(chosen.asset.embedding, other.embedding));
      }
    }
  }
  return ranked;
};

/* ------------------------------------------------------------------ */
/* Beats                                                               */
/* ------------------------------------------------------------------ */

export type StudioMovieBeats = {
  /** Beats per minute found. */
  bpm: number;
  /** Every beat, in seconds from the start of the music. */
  beats: number[];
  /** Which beat (0..3) starts the first bar. */
  downbeat: number;
};

/** Samples per analysis hop at the sample rate the server decodes for beat finding. */
export const STUDIO_MOVIE_BEAT_SAMPLE_RATE = 11_025;
const HOP = 256;
const WINDOW = 1024;
const MIN_BPM = 60;
const MAX_BPM = 180;
/** The tempo prior's centre: family footage reads best around 100 bpm (log-Gaussian, one octave wide). */
const PRIOR_BPM = 100;

/**
 * The beat of the music in `samples` (mono, `sampleRate` Hz). Deterministic and simple: an onset
 * envelope from the rise in log energy, the tempo from its autocorrelation (60-180 bpm, weighted
 * towards 100), the phase that lines the most onsets up with the grid, and the bar start from the
 * strongest of the four beats. Music with no clear beat gets a steady grid at `fallbackBpm`.
 */
export const findStudioMovieBeats = (samples: Float32Array, sampleRate: number, fallbackBpm = 90): StudioMovieBeats => {
  const duration = samples.length / sampleRate;
  const hops = Math.floor((samples.length - WINDOW) / HOP);
  const hopSeconds = HOP / sampleRate;
  const steady = (bpm: number, phase = 0): StudioMovieBeats => {
    const period = 60 / bpm;
    const beats: number[] = [];
    for (let time = phase; time <= duration + 1e-9; time += period) {
      beats.push(round3(time));
    }
    return { bpm: round3(bpm), beats, downbeat: 0 };
  };
  if (hops < 32) {
    return steady(fallbackBpm);
  }

  const energy = new Float64Array(hops);
  for (let hop = 0; hop < hops; hop++) {
    let sum = 0;
    const start = hop * HOP;
    for (let index = start; index < start + WINDOW; index++) {
      sum += samples[index] * samples[index];
    }
    energy[hop] = Math.log(1e-9 + sum / WINDOW);
  }
  const raw = new Float64Array(hops);
  for (let hop = 1; hop < hops; hop++) {
    raw[hop] = Math.max(0, energy[hop] - energy[hop - 1]);
  }
  // Smooth over a few hops, so a beat that falls between two hops still lines up with its neighbours,
  // then remove the mean so loud passages do not count as beats.
  const kernel = [1, 2, 3, 2, 1];
  const smoothed = new Float64Array(hops);
  for (let hop = 0; hop < hops; hop++) {
    let sum = 0;
    for (const [index, weight] of kernel.entries()) {
      sum += (raw[hop + index - 2] ?? 0) * weight;
    }
    smoothed[hop] = sum / 9;
  }
  const mean = smoothed.reduce((sum, value) => sum + value, 0) / hops;
  const onset = smoothed.map((value) => Math.max(0, value - mean));
  const strength = onset.reduce((sum, value) => sum + value * value, 0);
  if (strength < 1e-6) {
    return steady(fallbackBpm);
  }

  const minLag = Math.max(1, Math.floor(60 / MAX_BPM / hopSeconds));
  const maxLag = Math.min(hops - 1, Math.ceil(60 / MIN_BPM / hopSeconds));
  const correlation = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let hop = lag; hop < hops; hop++) {
      sum += onset[hop] * onset[hop - lag];
    }
    correlation[lag] = sum / (hops - lag);
  }
  let bestLag = minLag;
  let bestValue = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopSeconds);
    const prior = Math.exp(-0.5 * Math.log2(bpm / PRIOR_BPM) ** 2);
    const value = correlation[lag] * prior;
    if (value > bestValue) {
      bestValue = value;
      bestLag = lag;
    }
  }
  // Parabolic refinement of the peak for a fractional period.
  const [left, centre, right] = [correlation[bestLag - 1], correlation[bestLag], correlation[bestLag + 1]];
  const curvature = left - 2 * centre + right;
  const offset = curvature < 0 ? clamp((0.5 * (left - right)) / curvature, -0.5, 0.5) : 0;
  const period = bestLag + offset;
  const bpm = 60 / (period * hopSeconds);
  if (bpm < MIN_BPM || bpm > MAX_BPM || !Number.isFinite(bpm)) {
    return steady(fallbackBpm);
  }

  // The phase that lines the most onset energy up with the grid.
  const sumAt = (phase: number, step: number) => {
    let sum = 0;
    for (let position = phase; position < hops; position += step) {
      sum += onset[Math.round(position)] ?? 0;
    }
    return sum;
  };
  let bestPhase = 0;
  let bestPhaseValue = -Infinity;
  const phases = Math.max(1, Math.round(period * 4));
  for (let step = 0; step < phases; step++) {
    const phase = (step / phases) * period;
    const value = sumAt(phase, period);
    if (value > bestPhaseValue + 1e-12) {
      bestPhaseValue = value;
      bestPhase = phase;
    }
  }
  const beats: number[] = [];
  // A hop's energy rises as a beat enters its window, a window's length before the window's end.
  const lead = WINDOW / sampleRate;
  // Start from the earliest grid position whose beat time is not negative.
  let first = bestPhase;
  while ((first - period) * hopSeconds >= -lead) {
    first -= period;
  }
  for (let position = first; position * hopSeconds + lead <= duration + 1e-9; position += period) {
    beats.push(round3(position * hopSeconds + lead));
  }
  // The bar starts on the strongest of the four beats.
  let downbeat = 0;
  let downbeatValue = -Infinity;
  for (let candidate = 0; candidate < 4; candidate++) {
    const value = sumAt(bestPhase + candidate * period, period * 4);
    if (value > downbeatValue + 1e-12) {
      downbeatValue = value;
      downbeat = candidate;
    }
  }
  // Count the downbeat from the first beat listed, which may come before the phase found.
  const shift = Math.round((bestPhase - first) / period);
  return { bpm: round3(bpm), beats, downbeat: (shift + downbeat) % 4 };
};

/**
 * The start of every bar from 0 to `length` seconds: the found bars, carried on at the found tempo
 * past the end of the analysed music, with the movie's start as the first.
 */
export const studioMovieBars = ({ bpm, beats, downbeat }: StudioMovieBeats, length: number): number[] => {
  const bar = (60 / bpm) * 4;
  const found = beats.filter((_, index) => index >= downbeat && (index - downbeat) % 4 === 0);
  let last = found.at(-1) ?? 0;
  while (last + bar <= length + 1e-9) {
    last = round3(last + bar);
    found.push(last);
  }
  // No shot shorter than half a bar at either end.
  const bars = found.filter((time) => time >= bar / 2 && time <= length - bar / 2);
  return [0, ...bars];
};

/* ------------------------------------------------------------------ */
/* Cuts                                                                */
/* ------------------------------------------------------------------ */

export type StudioMovieShot = {
  moment: StudioMovieMoment;
  /** Where the shot starts and ends on the movie, in seconds, on bars of the music. */
  start: number;
  end: number;
};

export type StudioMovieCutOptions = {
  /** Best first (`rankStudioMovieMoments`). */
  moments: readonly StudioMovieMoment[];
  /** Bar starts from `studioMovieBars`, beginning with 0. */
  bars: readonly number[];
  length: number;
  /** A mood when the music was made for the movie; null for a song. */
  mood: StudioMovieMood | null;
  bpm: number;
};

/** Bars a shot holds: two, or three on a slow song so family footage is not rushed. */
export const baseBarsPerShot = (mood: StudioMovieMood | null, bpm: number) => (mood !== null || bpm >= 110 ? 2 : 3);

/**
 * Cut the movie on the bars. The best moments are chosen, then put back in the order they were
 * taken so the movie tells the story in sequence. Every shot starts on a bar; the last runs to the
 * end. A short source makes the shots longer rather than repeat a moment.
 */
export const planStudioMovieCuts = ({ moments, bars, length, mood, bpm }: StudioMovieCutOptions): StudioMovieShot[] => {
  if (moments.length === 0 || bars.length === 0) {
    return [];
  }
  const barCount = bars.length;
  let barsPerShot = baseBarsPerShot(mood, bpm);
  while (Math.ceil(barCount / barsPerShot) > moments.length) {
    barsPerShot += 1;
  }
  const shotCount = Math.max(1, Math.ceil(barCount / barsPerShot));
  const chosen = moments
    .slice(0, shotCount)
    .toSorted(
      (a, b) =>
        a.asset.takenAt.localeCompare(b.asset.takenAt) ||
        a.asset.id.localeCompare(b.asset.id) ||
        a.anchorSeconds - b.anchorSeconds,
    );
  const quicker = mood !== null && STUDIO_MOVIE_MOOD_STYLES[mood].quickerEveryThird;
  const shots: StudioMovieShot[] = [];
  let barIndex = 0;
  for (const [index, moment] of chosen.entries()) {
    if (barIndex >= barCount) {
      break;
    }
    const held = quicker && index % 3 === 2 && barsPerShot > 1 ? barsPerShot - 1 : barsPerShot;
    const last = index === chosen.length - 1 || barIndex + held >= barCount;
    const end = last ? length : bars[barIndex + held];
    shots.push({ moment, start: bars[barIndex], end });
    barIndex += held;
    if (last) {
      break;
    }
  }
  return shots;
};

/* ------------------------------------------------------------------ */
/* The graph                                                           */
/* ------------------------------------------------------------------ */

/** What placing an asset needs (protocol 3.5), from `GET /studio/assets/{id}/media-facts`. */
export type StudioMovieMedia = {
  fileName: string;
  width: number;
  height: number;
  /** A video's exact frame rate as a float (`num / den`); 0 for a photo. */
  fps: number;
  durationSeconds: number;
  /** Source frames of a video, when the original was read; otherwise worked out from its length. */
  frameCount: number | null;
  hasAudio: boolean;
};

export type StudioMovieGraphShot = StudioMovieShot & { media: StudioMovieMedia };

export type StudioMovieGraphOptions = {
  name: string;
  title: string;
  shots: readonly StudioMovieGraphShot[];
  /** The music, kept with the project as an audio import. */
  music: { importId: string; fileName: string; durationSeconds: number };
  /** Seconds the movie runs. */
  length: number;
  /** Fade the music out over the last seconds, or 0. */
  fadeOutSeconds: number;
  transition: 'Cross dissolve' | 'Dip to black' | null;
  bars: readonly number[];
  /** Seeds the ids, so the same version gives the same graph. */
  seed: string;
  /** Milliseconds; the project's own timestamps. */
  now: number;
};

const FPS = STUDIO_MOVIE_FPS;
/** Seconds to the nearest frame (protocol 3.3: halves towards positive infinity). */
export const toFrames = (seconds: number) => Math.floor(seconds * FPS + 0.5);
/** Protocol 12.2.4: timeline frames to source frames. */
const toSource = (frames: number, sourceFps: number) => Math.floor((frames / FPS) * sourceFps + 0.5);
/** Protocol 12.2.4: source frames to timeline frames. */
const toTimeline = (frames: number, sourceFps: number) => Math.floor((frames / sourceFps) * FPS);

/** The fitted transform of a still or video on the canvas (protocol 12.6.3, scale 1). */
const fitted = (width: number, height: number) => {
  const fit = Math.min(STUDIO_MOVIE_CANVAS.width / width, STUDIO_MOVIE_CANVAS.height / height);
  return { x: 0, y: 0, width: width * fit, height: height * fit, rotation: 0 };
};

type Region = { x: number; y: number; w: number; h: number };
const FULL: Region = { x: 0, y: 0, w: 1, h: 1 };
/** Push in, pan left, pull out, pan right, in turn (approved mock). Regions are square (13.7.2). */
const KEN_BURNS: ReadonlyArray<{ from: Region; to: Region }> = [
  { from: FULL, to: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } },
  { from: { x: 0.2, y: 0.1, w: 0.8, h: 0.8 }, to: { x: 0, y: 0.1, w: 0.8, h: 0.8 } },
  { from: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, to: FULL },
  { from: { x: 0, y: 0.1, w: 0.8, h: 0.8 }, to: { x: 0.2, y: 0.1, w: 0.8, h: 0.8 } },
];

/** The four scalar values a Ken Burns region gives (13.7.2, effect step 4). */
const kenBurnsValues = (base: { x: number; y: number; width: number; height: number }, region: Region) => {
  const width = base.width / region.w;
  const height = base.height / region.h;
  return {
    x: base.x + (0.5 - (region.x + region.w / 2)) * width,
    y: base.y + (0.5 - (region.y + region.h / 2)) * height,
    width,
    height,
  };
};

/** The Serif title style at a 1080-pixel canvas (14.3.2, preset `quote`) with the Rise animation (14.3.3). */
const TITLE_STYLE = {
  color: '#f8fafc',
  fontSize: 76,
  fontFamily: 'Playfair Display',
  fontWeight: 'semibold',
  fontStyle: 'italic',
  underline: false,
  backgroundColor: '#1f2937',
  backgroundRadius: 28,
  textAlign: 'center',
  verticalAlign: 'middle',
  lineHeight: 1.08,
  letterSpacing: 0,
  textPadding: 30,
  textShadow: { offsetX: 0, offsetY: 8, blur: 24, color: '#020617' },
  textStylePresetId: 'quote',
  textStyleScale: 1,
  textMotion: {
    in: {
      durationFrames: 14,
      staggerFrames: 4,
      intensity: 1,
      order: 'forward',
      easing: 'ease-out',
      seed: 0,
      presetId: 'rise',
    },
    out: {
      durationFrames: 14,
      staggerFrames: 4,
      intensity: 1,
      order: 'forward',
      easing: 'ease-in',
      seed: 0,
      presetId: 'sink',
    },
  },
} as const;

const TRANSITION_PRESENTATION = { 'Cross dissolve': 'dissolve', 'Dip to black': 'dipToColorDissolve' } as const;

const track = (id: string, name: string, kind: 'video' | 'audio', order: number) => ({
  id,
  name,
  kind,
  height: 100,
  locked: false,
  visible: true,
  muted: false,
  solo: false,
  order,
  syncLock: true,
  volume: 0,
  items: [],
});

type Item = Record<string, unknown> & { id: string; from: number; durationInFrames: number; type: string };

/** The longest transition (in frames, up to half a second) the two shots' handles allow (12.2.6). */
const transitionFrames = (left: Item, right: Item): number => {
  const tail = (item: Item) =>
    item.type === 'image'
      ? Infinity
      : toTimeline((item.sourceDuration as number) - (item.sourceEnd as number), item.sourceFps as number);
  const head = (item: Item) =>
    item.type === 'image' ? Infinity : toTimeline(item.sourceStart as number, item.sourceFps as number);
  const limit = Math.min(left.durationInFrames, right.durationInFrames) - 1;
  for (let frames = Math.min(TRANSITION_FRAMES, limit); frames >= 2; frames--) {
    const before = Math.floor(frames * 0.5);
    if (frames - before <= tail(left) && before <= head(right)) {
      return frames;
    }
  }
  return 0;
};

/**
 * The movie as a Studio project graph in normal form (protocol 2.6). Tracks, top first: the title,
 * the shots, their camera sound, the music. Each video's sound is linked to it; photos move.
 */
export const buildStudioMovieGraph = (options: StudioMovieGraphOptions) => {
  const nextId = studioMovieIds(options.seed);
  const lengthFrames = Math.max(1, toFrames(options.length));
  const [titleTrack, shotTrack, cameraTrack, musicTrack] = ['v1', 'v2', 'a1', 'a2'];
  const items: Item[] = [];
  const shotItems: Item[] = [];
  const keyframes: unknown[] = [];

  for (const [index, shot] of options.shots.entries()) {
    const from = toFrames(shot.start);
    const end = Math.min(lengthFrames, toFrames(shot.end));
    const durationInFrames = end - from;
    if (durationInFrames < 1) {
      continue;
    }
    const { media, moment } = shot;
    const originId = nextId();
    const transform = fitted(media.width, media.height);
    if (moment.kind === 'photo') {
      const id = nextId();
      const move = KEN_BURNS[index % KEN_BURNS.length];
      const ids = Array.from({ length: 8 }, () => nextId());
      const [first, second] = [kenBurnsValues(transform, move.from), kenBurnsValues(transform, move.to)];
      const lastFrame = Math.max(1, durationInFrames - 1);
      keyframes.push({
        itemId: id,
        animationVersion: 2,
        properties: (['x', 'y', 'width', 'height'] as const).map((property, slot) => ({
          property,
          keyframes: [
            { id: ids[slot * 2], frame: 0, value: first[property], easing: 'linear' },
            { id: ids[slot * 2 + 1], frame: lastFrame, value: second[property], easing: 'linear' },
          ],
        })),
      });
      const item: Item = {
        id,
        trackId: shotTrack,
        from,
        durationInFrames,
        label: media.fileName,
        mediaId: moment.asset.id,
        originId,
        sourceStart: 0,
        sourceEnd: durationInFrames,
        sourceDuration: durationInFrames,
        sourceFps: FPS,
        trimStart: 0,
        trimEnd: 0,
        type: 'image',
        src: '',
        sourceWidth: media.width,
        sourceHeight: media.height,
        transform,
        frameleafKenBurns: { from: move.from, to: move.to, keyframeIds: ids },
      };
      items.push(item);
      shotItems.push(item);
      continue;
    }

    // A video moment: its window centred on the moment, kept inside the clip with half a second of
    // handle at each end where the clip allows it, so the cut can dissolve.
    const sourceFps = media.fps;
    const sourceDuration =
      media.frameCount && media.frameCount > 0 ? media.frameCount : Math.floor(media.durationSeconds * sourceFps);
    const span = toSource(durationInFrames, sourceFps);
    const handle = Math.min(toSource(TRANSITION_FRAMES, sourceFps), Math.floor((sourceDuration - span) / 2));
    const centred = Math.round(moment.anchorSeconds * sourceFps) - Math.floor(span / 2);
    const sourceStart = clamp(centred, Math.max(0, handle), Math.max(0, sourceDuration - span - Math.max(0, handle)));
    const sourceEnd = Math.min(sourceDuration, sourceStart + span);
    const linkedGroupId = media.hasAudio ? nextId() : undefined;
    const id = nextId();
    const common = {
      from,
      durationInFrames,
      label: media.fileName,
      mediaId: moment.asset.id,
      originId,
      ...(linkedGroupId && { linkedGroupId }),
      sourceStart,
      sourceEnd,
      sourceDuration,
      sourceFps,
      trimStart: 0,
      trimEnd: 0,
    };
    const video: Item = {
      id,
      trackId: shotTrack,
      ...common,
      type: 'video',
      src: '',
      sourceWidth: media.width,
      sourceHeight: media.height,
      transform,
    };
    items.push(video);
    shotItems.push(video);
    if (media.hasAudio) {
      items.push({
        id: nextId(),
        trackId: cameraTrack,
        ...common,
        type: 'audio',
        src: '',
        volume: STUDIO_MOVIE_CAMERA_DB,
      });
    }
  }

  const musicFrames = Math.max(1, Math.floor(options.music.durationSeconds * FPS));
  items.push({
    id: nextId(),
    trackId: musicTrack,
    from: 0,
    durationInFrames: Math.min(lengthFrames, musicFrames),
    label: options.music.fileName,
    mediaId: options.music.importId,
    originId: nextId(),
    sourceStart: 0,
    sourceEnd: Math.min(lengthFrames, musicFrames),
    sourceDuration: musicFrames,
    sourceFps: FPS,
    trimStart: 0,
    trimEnd: 0,
    type: 'audio',
    src: '',
    volume: STUDIO_MOVIE_MUSIC_DB,
    ...(options.fadeOutSeconds > 0 && { audioFadeOut: options.fadeOutSeconds }),
  });

  const titleText = options.title.trim() || options.name;
  const titleFrom = Math.min(toFrames(0.4), lengthFrames - 1);
  // Up to two bars, at most four and a half seconds and at least one and a half (approved mock).
  const twoBars = options.bars[2] ?? options.length;
  const titleFrames = clamp(toFrames(clamp(twoBars - 0.4, 1.5, 4.5)), 1, lengthFrames - titleFrom);
  items.unshift({
    id: nextId(),
    type: 'text',
    trackId: titleTrack,
    from: titleFrom,
    durationInFrames: titleFrames,
    label: titleText.slice(0, 64),
    text: titleText,
    ...TITLE_STYLE,
  });

  const transitions: unknown[] = [];
  if (options.transition) {
    for (let index = 1; index < shotItems.length; index++) {
      const [left, right] = [shotItems[index - 1], shotItems[index]];
      if (left.from + left.durationInFrames !== right.from) {
        continue;
      }
      const frames = transitionFrames(left, right);
      if (frames > 0) {
        transitions.push({
          id: nextId(),
          leftClipId: left.id,
          rightClipId: right.id,
          trackId: shotTrack,
          type: 'crossfade',
          durationInFrames: frames,
          presentation: TRANSITION_PRESENTATION[options.transition],
          timing: 'linear',
          alignment: 0.5,
        });
      }
    }
  }

  const markers = options.bars
    .slice(1, MAX_MARKERS + 1)
    .map((time) => toFrames(time))
    .filter((frame) => frame > 0 && frame < lengthFrames)
    .map((frame) => ({ id: nextId(), frame, color: '#3B82F6' }));

  return {
    id: nextId(),
    name: options.name,
    description: '',
    createdAt: options.now,
    updatedAt: options.now,
    duration: round3(lengthFrames / FPS),
    schemaVersion: 15,
    metadata: {
      width: STUDIO_MOVIE_CANVAS.width,
      height: STUDIO_MOVIE_CANVAS.height,
      fps: FPS,
      frameRate: { num: FPS, den: 1 },
    },
    timeline: {
      tracks: [
        track(titleTrack, 'V1', 'video', 0),
        track(shotTrack, 'V2', 'video', 1),
        track(cameraTrack, 'A1', 'audio', 2),
        track(musicTrack, 'A2', 'audio', 3),
      ],
      items,
      masterBusDb: 0,
      masterBusMuted: false,
      currentFrame: 0,
      zoomLevel: 1,
      scrollPosition: 0,
      ...(markers.length > 0 && { markers }),
      ...(transitions.length > 0 && { transitions }),
      ...(keyframes.length > 0 && { keyframes }),
    },
  };
};

/* ------------------------------------------------------------------ */
/* Length and music                                                    */
/* ------------------------------------------------------------------ */

/**
 * How long the movie runs and how the music ends (owner decision 2026-10-26): a song shorter than the
 * chosen length sets the movie's length, so the movie ends with the song; a longer one fades out over
 * the last two seconds. Music made for the movie is written to the chosen length and fades the same way.
 */
export const studioMovieLength = (chosenSeconds: number, musicSeconds: number) => {
  if (musicSeconds <= chosenSeconds + 0.05) {
    return { length: round3(Math.max(1, musicSeconds)), fadeOutSeconds: 0 };
  }
  return { length: chosenSeconds, fadeOutSeconds: Math.min(STUDIO_MOVIE_FADE_SECONDS, chosenSeconds / 4) };
};
