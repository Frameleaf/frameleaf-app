import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STUDIO_MOVIE_BEAT_SAMPLE_RATE,
  STUDIO_MOVIE_CAMERA_DB,
  StudioMovieAsset,
  StudioMovieMoment,
  buildStudioMovieGraph,
  findStudioMovieBeats,
  planStudioMovieCuts,
  rankStudioMovieMoments,
  studioMovieBars,
  studioMovieIds,
  studioMovieLength,
  toFrames,
} from 'src/utils/studio-movie.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const schema = JSON.parse(readFileSync(join(repoRoot, 'studio', 'graph-schema-v1.json'), 'utf8'));
// The protocol's own checker (studio/tools/graph-protocol.mjs); a variable path keeps it out of type-checking.
const protocolPath = join(repoRoot, 'studio', 'tools', 'graph-protocol.mjs');
const loadProtocol = (): Promise<{ validate: (schema: unknown, value: unknown) => string[] }> => import(protocolPath);

const asset = (id: string, overrides: Partial<StudioMovieAsset> = {}): StudioMovieAsset => ({
  id,
  type: 'IMAGE',
  fileName: `${id}.jpg`,
  takenAt: `2026-07-0${(id.codePointAt(id.length - 1) ?? 0) % 9}T10:00:00.000Z`,
  isFavorite: false,
  rating: null,
  durationSeconds: null,
  bestScore: 0.5,
  bestFrameSeconds: null,
  faceCount: 0,
  embedding: null,
  ...overrides,
});

/** Clicks at `bpm`, every fourth one louder, as the server decodes music for beat finding. */
const clicks = (bpm: number, seconds: number, offset = 0) => {
  const rate = STUDIO_MOVIE_BEAT_SAMPLE_RATE;
  const samples = new Float32Array(Math.floor(seconds * rate));
  for (let index = 0; index < samples.length; index++) {
    samples[index] = Math.sin(index / 7) * 0.01;
  }
  let beat = 0;
  for (let time = offset; time < seconds; time += 60 / bpm, beat++) {
    const start = Math.floor(time * rate);
    const loud = beat % 4 === 0 ? 0.9 : 0.45;
    for (let index = 0; index < 400 && start + index < samples.length; index++) {
      samples[start + index] += loud * Math.exp(-index / 80) * Math.sin(index / 3);
    }
  }
  return samples;
};

const moment = (id: string, takenAt: string, kind: 'photo' | 'video' = 'photo', score = 50): StudioMovieMoment => ({
  asset: asset(id, {
    takenAt,
    type: kind === 'photo' ? 'IMAGE' : 'VIDEO',
    durationSeconds: kind === 'video' ? 30 : null,
  }),
  kind,
  anchorSeconds: kind === 'video' ? 10 : 0,
  score,
});

describe('make a movie', () => {
  describe('rankStudioMovieMoments', () => {
    it('ranks favourites, ratings, Best Photos and people above the rest', () => {
      const ranked = rankStudioMovieMoments(
        [
          asset('plain', { bestScore: 0.3 }),
          asset('favourite', { bestScore: 0.3, isFavorite: true, rating: 5, faceCount: 3 }),
          asset('best', { bestScore: 1 }),
        ],
        1,
      );
      expect(
        ranked
          .map((item) => item.asset.id)
          .slice(0, 2)
          .toSorted(),
      ).toEqual(['best', 'favourite']);
      expect(ranked.at(-1)?.asset.id).toBe('plain');
    });

    it('takes at most two moments from a video, around its best frame, and skips very short videos', () => {
      const ranked = rankStudioMovieMoments(
        [
          asset('long', { type: 'VIDEO', durationSeconds: 120, bestFrameSeconds: 30 }),
          asset('short', { type: 'VIDEO', durationSeconds: 1.2 }),
          asset('clip', { type: 'VIDEO', durationSeconds: 6 }),
        ],
        1,
      );
      const long = ranked.filter((item) => item.asset.id === 'long');
      expect(long.map((item) => item.anchorSeconds)).toEqual([30, 90]);
      expect(ranked.filter((item) => item.asset.id === 'clip')).toHaveLength(1);
      expect(ranked.some((item) => item.asset.id === 'short')).toBe(false);
    });

    it('keeps near-duplicates (by smart search similarity) apart', () => {
      const scene = [1, 0, 0];
      const great = { bestScore: 0.95, isFavorite: true, rating: 5 };
      for (const seed of [1, 2, 3, 4, 5]) {
        const ranked = rankStudioMovieMoments(
          [
            asset('burst-1', { ...great, embedding: scene }),
            asset('burst-2', { ...great, embedding: [0.999, 0.01, 0] }),
            asset('other', { ...great, embedding: [0, 1, 0] }),
          ],
          seed,
        );
        // whichever burst comes first, its twin is ranked after the different scene
        expect(ranked[2].asset.id).toMatch(/^burst-/);
      }
    });

    it('is repeatable for a seed and picks differently for another', () => {
      const assets = Array.from({ length: 40 }, (_, index) => asset(`a${index}`));
      const order = (seed: number) => rankStudioMovieMoments(assets, seed).map((item) => item.asset.id);
      expect(order(7)).toEqual(order(7));
      expect(order(7)).not.toEqual(order(8));
    });
  });

  describe('findStudioMovieBeats', () => {
    it('finds the tempo, the beats and the bar of clicks', () => {
      const result = findStudioMovieBeats(clicks(120, 20, 0.3), STUDIO_MOVIE_BEAT_SAMPLE_RATE);
      expect(result.bpm).toBeGreaterThan(118);
      expect(result.bpm).toBeLessThan(122);
      const near = (time: number) => Math.min(...result.beats.map((beat) => Math.abs(beat - time)));
      for (const time of [0.3, 2.3, 10.3, 15.3]) {
        expect(near(time)).toBeLessThan(0.05);
      }
      // the loud clicks start the bars
      const firstBar = result.beats[result.downbeat];
      expect(Math.round((firstBar - 0.3) / 0.5) % 4).toBe(0);
    });

    it('finds a slow tempo too', () => {
      const result = findStudioMovieBeats(clicks(72, 30), STUDIO_MOVIE_BEAT_SAMPLE_RATE);
      expect(Math.abs(result.bpm - 72)).toBeLessThan(2);
    });

    it('gives a steady grid for music with no beat', () => {
      const silence = new Float32Array(STUDIO_MOVIE_BEAT_SAMPLE_RATE * 10);
      const result = findStudioMovieBeats(silence, STUDIO_MOVIE_BEAT_SAMPLE_RATE, 90);
      expect(result).toMatchObject({ bpm: 90, downbeat: 0 });
      expect(result.beats.slice(0, 3)).toEqual([0, 0.667, 1.333]);
    });

    it('is deterministic', () => {
      const samples = clicks(96, 12, 0.1);
      expect(findStudioMovieBeats(samples, STUDIO_MOVIE_BEAT_SAMPLE_RATE)).toEqual(
        findStudioMovieBeats(samples, STUDIO_MOVIE_BEAT_SAMPLE_RATE),
      );
    });
  });

  describe('studioMovieBars', () => {
    it('starts at 0 and carries the bars on past the music at its tempo', () => {
      const bars = studioMovieBars({ bpm: 120, beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5], downbeat: 1 }, 10);
      expect(bars).toEqual([0, 1, 3, 5, 7, 9]);
    });
  });

  describe('planStudioMovieCuts', () => {
    const bars = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28];

    it('cuts on bars, two bars a shot, in the order the moments were taken', () => {
      const moments = [
        moment('c', '2026-07-03'),
        moment('a', '2026-07-01'),
        moment('b', '2026-07-02'),
        ...Array.from({ length: 10 }, (_, index) => moment(`z${index}`, `2026-08-${10 + index}`)),
      ];
      const shots = planStudioMovieCuts({ moments, bars, length: 30, mood: 'calm', bpm: 120 });
      expect(shots.slice(0, 3).map((shot) => shot.moment.asset.id)).toEqual(['a', 'b', 'c']);
      expect(shots.map((shot) => shot.start)).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
      expect(shots.every((shot) => bars.includes(shot.start))).toBe(true);
      expect(shots.at(-1)?.end).toBe(30);
      for (let index = 1; index < shots.length; index++) {
        expect(shots[index].start).toBe(shots[index - 1].end);
      }
    });

    it('makes every third shot one bar shorter on Upbeat', () => {
      const moments = Array.from({ length: 20 }, (_, index) => moment(`m${index}`, `2026-07-${10 + index}`));
      const shots = planStudioMovieCuts({ moments, bars, length: 30, mood: 'upbeat', bpm: 120 });
      expect(shots.slice(0, 4).map((shot) => shot.end - shot.start)).toEqual([4, 4, 2, 4]);
    });

    it('holds each shot longer instead of repeating a moment when the source is short', () => {
      const moments = [moment('a', '2026-07-01'), moment('b', '2026-07-02'), moment('c', '2026-07-03')];
      const shots = planStudioMovieCuts({ moments, bars, length: 30, mood: 'warm', bpm: 120 });
      expect(shots.map((shot) => shot.moment.asset.id)).toEqual(['a', 'b', 'c']);
      expect(shots.map((shot) => shot.start)).toEqual([0, 10, 20]);
      expect(shots.at(-1)?.end).toBe(30);
    });

    it('holds three bars a shot on a slow song', () => {
      const moments = Array.from({ length: 20 }, (_, index) => moment(`m${index}`, `2026-07-${10 + index}`));
      const shots = planStudioMovieCuts({ moments, bars, length: 30, mood: null, bpm: 80 });
      expect(shots.slice(0, 2).map((shot) => shot.end - shot.start)).toEqual([6, 6]);
    });
  });

  describe('studioMovieLength', () => {
    it('ends the movie with a song shorter than the chosen length', () => {
      expect(studioMovieLength(60, 42.5)).toEqual({ length: 42.5, fadeOutSeconds: 0 });
    });

    it('fades a longer song out over the last two seconds', () => {
      expect(studioMovieLength(60, 214)).toEqual({ length: 60, fadeOutSeconds: 2 });
    });
  });

  describe('buildStudioMovieGraph', () => {
    const photo = {
      fileName: 'lake.jpg',
      width: 4000,
      height: 3000,
      fps: 0,
      durationSeconds: 0,
      frameCount: null,
      hasAudio: false,
    };
    const video = {
      fileName: 'canoe.mov',
      width: 3840,
      height: 2160,
      fps: 30,
      durationSeconds: 20,
      frameCount: 600,
      hasAudio: true,
    };
    const build = (transition: 'Cross dissolve' | 'Dip to black' | null = 'Cross dissolve') =>
      buildStudioMovieGraph({
        name: 'Lake weekend',
        title: '',
        shots: [
          { moment: moment('0198a1c2-0000-7000-8000-000000000001', '2026-07-01'), start: 0, end: 4, media: photo },
          {
            moment: { ...moment('0198a1c2-0000-7000-8000-000000000002', '2026-07-02', 'video'), anchorSeconds: 10 },
            start: 4,
            end: 8,
            media: video,
          },
          { moment: moment('0198a1c2-0000-7000-8000-000000000003', '2026-07-03'), start: 8, end: 11.5, media: photo },
        ],
        music: { importId: '0198a1c2-0000-7000-8000-0000000000aa', fileName: 'Music.m4a', durationSeconds: 60 },
        length: 11.5,
        fadeOutSeconds: 2,
        transition,
        bars: [0, 2, 4, 6, 8, 10],
        seed: 'movie:1',
        now: 1_761_480_000_000,
      });

    it('is a valid graph in normal form', async () => {
      const graph = build();
      const { validate } = await loadProtocol();
      expect(validate(schema, graph)).toEqual([]);
      expect(graph.schemaVersion).toBe(15);
      expect(graph.metadata).toEqual({ width: 1920, height: 1080, fps: 30, frameRate: { num: 30, den: 1 } });
      const { tracks, items } = graph.timeline;
      expect(tracks.map((track) => [track.name, track.order, track.height])).toEqual([
        ['V1', 0, 100],
        ['V2', 1, 100],
        ['A1', 2, 100],
        ['A2', 3, 100],
      ]);
      for (const track of tracks) {
        const onTrack = items
          .filter((item) => item.trackId === track.id)
          .toSorted((a, b) => (a.from as number) - (b.from as number));
        for (const item of onTrack) {
          expect(Number.isSafeInteger(item.from) && Number.isSafeInteger(item.durationInFrames)).toBe(true);
          expect(item.durationInFrames).toBeGreaterThanOrEqual(1);
        }
        for (let index = 1; index < onTrack.length; index++) {
          const before = onTrack[index - 1];
          expect(onTrack[index].from).toBeGreaterThanOrEqual(
            (before.from as number) + (before.durationInFrames as number),
          );
        }
      }
      const ids = [
        ...items.map((item) => item.id),
        ...(graph.timeline.transitions ?? []).map((item) => (item as { id: string }).id),
      ];
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('places the shots back to back on the beat, with the camera sound linked at 25 %', () => {
      const { items } = build().timeline;
      const shots = items.filter((item) => item.trackId === 'v2');
      expect(shots.map((item) => [item.type, item.from, item.durationInFrames])).toEqual([
        ['image', 0, 120],
        ['video', 120, 120],
        ['image', 240, 105],
      ]);
      const video = shots[1];
      const sound = items.find((item) => item.trackId === 'a1')!;
      expect(sound).toMatchObject({
        type: 'audio',
        mediaId: video.mediaId,
        linkedGroupId: video.linkedGroupId,
        originId: video.originId,
        from: 120,
        durationInFrames: 120,
        sourceStart: video.sourceStart,
        sourceEnd: video.sourceEnd,
        volume: STUDIO_MOVIE_CAMERA_DB,
      });
      // the moment at 10 s is centred in its four-second window
      expect(video).toMatchObject({ sourceStart: 240, sourceEnd: 360, sourceDuration: 600, sourceFps: 30 });
      expect(video.transform).toEqual({ x: 0, y: 0, width: 1920, height: 1080, rotation: 0 });
    });

    it('moves the photos with Ken Burns keyframes the record lists', () => {
      const graph = build();
      const first = graph.timeline.items.find((item) => item.type === 'image')!;
      const record = first.frameleafKenBurns as { keyframeIds: string[] };
      const entry = (
        graph.timeline.keyframes as Array<{
          itemId: string;
          properties: Array<{ property: string; keyframes: Array<{ id: string; frame: number; value: number }> }>;
        }>
      ).find((item) => item.itemId === first.id)!;
      expect(entry.properties.map((group) => group.property)).toEqual(['x', 'y', 'width', 'height']);
      expect(entry.properties.flatMap((group) => group.keyframes.map((keyframe) => keyframe.id))).toEqual(
        record.keyframeIds,
      );
      // push in: from the whole photo to its middle 80 %
      const width = entry.properties.find((group) => group.property === 'width')!.keyframes;
      expect(width.map((keyframe) => [keyframe.frame, keyframe.value])).toEqual([
        [0, 1440],
        [119, 1800],
      ]);
    });

    it('dissolves at the cuts within the shots handles', () => {
      const transitions = build().timeline.transitions as Array<Record<string, unknown>>;
      expect(transitions).toHaveLength(2);
      expect(transitions[0]).toMatchObject({
        type: 'crossfade',
        presentation: 'dissolve',
        durationInFrames: 15,
        alignment: 0.5,
        timing: 'linear',
      });
      const dip = build('Dip to black').timeline.transitions as Array<Record<string, unknown>>;
      expect(dip[0].presentation).toBe('dipToColorDissolve');
      expect(build(null).timeline.transitions).toBeUndefined();
    });

    it('runs one music clip under the whole movie, faded out, and a title at the start', () => {
      const graph = build();
      const music = graph.timeline.items.find((item) => item.trackId === 'a2')!;
      expect(music).toMatchObject({
        type: 'audio',
        mediaId: '0198a1c2-0000-7000-8000-0000000000aa',
        from: 0,
        durationInFrames: toFrames(11.5),
        sourceStart: 0,
        sourceEnd: toFrames(11.5),
        sourceDuration: 1800,
        audioFadeOut: 2,
      });
      const title = graph.timeline.items.find((item) => item.type === 'text')!;
      expect(title).toMatchObject({ trackId: 'v1', from: 12, text: 'Lake weekend', textStylePresetId: 'quote' });
      expect(graph.timeline.markers?.map((marker) => marker.frame)).toEqual([60, 120, 180, 240, 300]);
    });

    it('gives the same graph for the same seed', () => {
      expect(build()).toEqual(build());
    });
  });

  it('mints ids in the UUID version 4 layout', () => {
    const next = studioMovieIds('seed');
    expect(next()).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(next()).not.toEqual(studioMovieIds('seed')());
  });
});
