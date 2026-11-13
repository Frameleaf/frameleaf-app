import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InterchangeMapOptions, InterchangeMedia, mapInterchangeTimeline } from 'src/utils/studio-interchange/map.js';
import { Clip, RationalTime, Timeline, Track, TrackChild } from 'src/utils/studio-interchange/model.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const schema = JSON.parse(readFileSync(join(repoRoot, 'studio', 'graph-schema-v1.json'), 'utf8'));
const catalogue = JSON.parse(readFileSync(join(repoRoot, 'studio', 'graph-parameters-v1.json'), 'utf8'));
// The protocol's own checker; a variable path keeps it out of type-checking.
const protocolPath = join(repoRoot, 'studio', 'tools', 'graph-protocol.mjs');
const loadProtocol = (): Promise<{ validate: (schema: unknown, value: unknown) => string[] }> => import(protocolPath);

const fonts = new Set<string>(catalogue.fonts.families.map((family: { family: string }) => family.family));
const t = (secondsValue: number, rate = 25): RationalTime => ({ value: secondsValue * rate, rate });
const range = (start: number, duration: number, rate = 25) => ({
  startTime: t(start, rate),
  duration: t(duration, rate),
});

const library: Record<string, InterchangeMedia> = {
  '/Volumes/Jamie/Rockies/Lake morning.mov': {
    assetId: '0198a1c2-0000-7000-8000-000000000001',
    kind: 'video',
    width: 3840,
    height: 2160,
    fps: 25,
    frameCount: 25 * 60,
    durationSeconds: 60,
  },
  'C:\\Users\\jamie\\Footage\\Kayak.mp4': {
    assetId: '0198a1c2-0000-7000-8000-000000000002',
    kind: 'video',
    width: 1920,
    height: 1080,
    fps: 25,
    frameCount: 25 * 30,
    durationSeconds: 30,
  },
  '/Volumes/Jamie/Rockies/Ridge.jpg': {
    assetId: '0198a1c2-0000-7000-8000-000000000003',
    kind: 'image',
    width: 4000,
    height: 3000,
    fps: 0,
    frameCount: null,
    durationSeconds: 0,
  },
  '/Volumes/Jamie/Music/Campfire.wav': {
    assetId: '0198a1c2-0000-7000-8000-000000000004',
    kind: 'audio',
    width: 0,
    height: 0,
    fps: 25,
    frameCount: 25 * 120,
    durationSeconds: 120,
  },
};

const options: InterchangeMapOptions = {
  source: 'premiere',
  seed: 'import:test',
  now: 1_763_000_000_000,
  resolveMedia: (reference) => library[reference.key] ?? null,
  fonts,
};

const media = (key: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip => ({
  type: 'clip',
  name: key.split(/[/\\]/).at(-1)!,
  sourceRange: range(start, duration),
  mediaReference: { kind: 'external', key, name: key },
  ...extra,
});
const gap = (duration: number): TrackChild => ({ type: 'gap', sourceRange: range(0, duration) });
const cut = (name: string, inSeconds: number, outSeconds: number): TrackChild => ({
  type: 'transition',
  name,
  inOffset: t(inSeconds),
  outOffset: t(outSeconds),
});
const timeline = (tracks: Track[], extra: Partial<Timeline> = {}): Timeline => ({
  name: 'Summer in the Rockies',
  rate: { num: 25, den: 1 },
  canvas: { width: 1920, height: 1080 },
  tracks,
  ...extra,
});

const lake = '/Volumes/Jamie/Rockies/Lake morning.mov';
const kayak = String.raw`C:\Users\jamie\Footage\Kayak.mp4`;

const full = () =>
  timeline(
    [
      {
        kind: 'video',
        name: 'Pictures',
        children: [
          media(lake, 10, 4),
          cut('Cross Dissolve', 0.5, 0.5),
          media(kayak, 5, 4),
          gap(1),
          media('/Volumes/Jamie/Rockies/Ridge.jpg', 0, 3),
          cut('Page Peel', 0.4, 0.4),
          media('/Volumes/Jamie/Rockies/B014_ridge.braw', 0, 2),
        ],
      },
      {
        kind: 'video',
        name: 'Titles',
        children: [
          {
            type: 'clip',
            name: 'Opening title',
            sourceRange: range(0, 3),
            mediaReference: { kind: 'generator', generator: 'title', name: 'Essential Graphics' },
            frameleaf: { title: { text: 'Summer in the Rockies', font: 'Proxima Nova', color: '#f8fafc' } },
          },
        ],
      },
      {
        kind: 'audio',
        name: 'Music',
        children: [
          media('/Volumes/Jamie/Music/Campfire.wav', 0, 6, { frameleaf: { volumeDb: -6 } }),
          cut('Constant Power', 1, 1),
          media('/Volumes/Jamie/Music/Campfire.wav', 30, 6),
        ],
      },
    ],
    {
      markers: [
        { name: 'Drop', markedRange: range(2, 0), color: 'GREEN' },
        { name: 'Chorus', markedRange: range(6, 4), color: 'RED' },
      ],
    },
  );

describe('mapInterchangeTimeline', () => {
  it('writes a valid graph in normal form', async () => {
    const { graph } = mapInterchangeTimeline(full(), options);
    const { validate } = await loadProtocol();
    expect(validate(schema, graph)).toEqual([]);
    expect(graph.metadata).toEqual({ width: 1920, height: 1080, fps: 25, frameRate: { num: 25, den: 1 } });
    expect(graph.timeline.tracks.map((track) => [track.name, track.kind, track.order])).toEqual([
      ['Titles', 'video', 0],
      ['Pictures', 'video', 1],
      ['Music', 'audio', 2],
    ]);
  });

  it('places clips where the other editor had them, with their source windows', () => {
    const { graph } = mapInterchangeTimeline(full(), options);
    const pictures = graph.timeline.items.filter((item) => item.trackId === graph.timeline.tracks[1].id);
    expect(pictures.map((item) => [item.label, item.type, item.from, item.durationInFrames])).toEqual([
      ['Lake morning.mov', 'video', 0, 100],
      ['Kayak.mp4', 'video', 100, 100],
      ['Ridge.jpg', 'image', 225, 75],
      ['B014_ridge.braw', 'video', 300, 50],
    ]);
    expect(pictures[0]).toMatchObject({ sourceStart: 250, sourceEnd: 350, sourceDuration: 1500, sourceFps: 25 });
    expect(pictures[1]).toMatchObject({ mediaId: library[kayak].assetId, sourceStart: 125, sourceEnd: 225 });
  });

  it('keeps a missing file as a placeholder, and no folder of the other machine reaches the graph', () => {
    const { graph, losses } = mapInterchangeTimeline(full(), options);
    const placeholder = graph.timeline.items.find((item) => item.label === 'B014_ridge.braw')!;
    expect(placeholder.mediaId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(Object.values(library).map((item) => item.assetId)).not.toContain(placeholder.mediaId);
    expect(losses.filter((loss) => loss.code === 'media-missing').map((loss) => loss.clip)).toEqual([
      'B014_ridge.braw',
    ]);
    const json = JSON.stringify(graph);
    expect(json).not.toContain('Volumes');
    expect(json).not.toContain('jamie');
  });

  it('maps known transitions, and reports the rest as cross dissolves', () => {
    const { graph, losses } = mapInterchangeTimeline(full(), options);
    expect(graph.timeline.transitions).toEqual([
      expect.objectContaining({ presentation: 'dissolve', durationInFrames: 25, alignment: 0.5 }),
    ]);
    // Page Peel has no match and the still has no frames to spare beyond the placeholder: it is a cut.
    expect(losses.map((loss) => loss.code)).toEqual(
      expect.arrayContaining(['transition-unmatched', 'audio-crossfade', 'font-missing', 'marker-range']),
    );
  });

  it('turns a sound crossfade into a fade out and a fade in', () => {
    const { graph } = mapInterchangeTimeline(full(), options);
    const music = graph.timeline.items.filter((item) => item.trackId === graph.timeline.tracks[2].id);
    expect(music.map((item) => [item.from, item.audioFadeIn, item.audioFadeOut, item.volume])).toEqual([
      [0, undefined, 2, -6],
      [150, 2, undefined, undefined],
    ]);
  });

  it('sets a title in Inter when Studio does not have its font', () => {
    const { graph, losses } = mapInterchangeTimeline(full(), options);
    expect(graph.timeline.items.find((item) => item.type === 'text')).toMatchObject({
      text: 'Summer in the Rockies',
      fontFamily: 'Inter',
      color: '#f8fafc',
    });
    expect(losses.find((loss) => loss.code === 'font-missing')).toMatchObject({ what: 'Set in Proxima Nova', at: 0 });
  });

  it('marks the ruler, and reports a range as a point at its start', () => {
    const { graph, losses } = mapInterchangeTimeline(full(), options);
    expect(graph.timeline.markers).toEqual([
      expect.objectContaining({ frame: 50, color: '#22C55E', label: 'Drop' }),
      expect.objectContaining({ frame: 150, color: '#EF4444', label: 'Chorus' }),
    ]);
    expect(losses.find((loss) => loss.code === 'marker-range')).toMatchObject({ clip: 'Chorus', at: 150 });
  });

  it('carries steady speed and reverse, and clamps a speed Studio cannot play', async () => {
    const { graph, losses } = mapInterchangeTimeline(
      timeline([
        {
          kind: 'video',
          name: 'V1',
          children: [
            media(lake, 0, 4, { frameleaf: { speed: 2 } }),
            media(lake, 20, 1, { frameleaf: { speed: -1 } }),
            media(kayak, 0, 1, { frameleaf: { speed: 20, speedRamp: true } }),
          ],
        },
      ]),
      options,
    );
    const { validate } = await loadProtocol();
    expect(validate(schema, graph)).toEqual([]);
    const [fast, back, clamped] = graph.timeline.items;
    expect(fast).toMatchObject({ speed: 2, sourceStart: 0, sourceEnd: 200, durationInFrames: 100 });
    expect(back).toMatchObject({ isReversed: true });
    expect(back.speed).toBeUndefined();
    expect(clamped).toMatchObject({ speed: 10, sourceEnd: 250 });
    expect(losses.map((loss) => loss.code)).toEqual(['speed-out-of-range', 'speed-ramp']);
  });

  it('keeps 29.97 exact and reports a rate Studio cannot read', () => {
    const drop = mapInterchangeTimeline(timeline([], { rate: { num: 30_000, den: 1001 } }), options);
    expect(drop.graph.metadata.frameRate).toEqual({ num: 30_000, den: 1001 });
    expect(drop.losses).toEqual([]);
    const odd = mapInterchangeTimeline(timeline([], { rate: { num: 25, den: 2 } }), options);
    expect(odd.graph.metadata.frameRate).toEqual({ num: 13, den: 1 });
    expect(odd.losses).toEqual([expect.objectContaining({ code: 'frame-rate', became: '13 frames a second' })]);
  });

  it('turns a nest into a composition with its sound clip, and counts its notes on the main timeline', async () => {
    const { graph, losses } = mapInterchangeTimeline(
      timeline([
        {
          kind: 'video',
          name: 'V1',
          children: [
            media(lake, 0, 2),
            {
              type: 'stack',
              name: 'Kayak sequence',
              sourceRange: range(1, 3),
              tracks: [
                { kind: 'video', name: 'V1', children: [media(kayak, 0, 2), media('/missing/Drone.mov', 0, 2)] },
                { kind: 'audio', name: 'A1', children: [media(kayak, 0, 4)] },
              ],
            },
          ],
        },
      ]),
      options,
    );
    const { validate } = await loadProtocol();
    expect(validate(schema, graph)).toEqual([]);
    const compositions = (graph.timeline as { compositions?: Array<{ id: string; durationInFrames: number }> })
      .compositions!;
    expect(compositions).toHaveLength(1);
    expect(compositions[0].durationInFrames).toBe(100);
    const shown = graph.timeline.items.filter((item) => item.compositionId === compositions[0].id);
    expect(shown.map((item) => [item.type, item.from, item.durationInFrames, item.sourceStart])).toEqual([
      ['composition', 50, 75, 25],
      ['audio', 50, 75, 25],
    ]);
    expect(shown[0].linkedGroupId).toBe(shown[1].linkedGroupId);
    // Drone starts 50 frames into the nest, which the main timeline shows from 25 frames in.
    expect(losses).toEqual([expect.objectContaining({ code: 'media-missing', clip: 'Drone.mov', at: 75 })]);
  });

  it('gives the same graph for the same file', () => {
    expect(mapInterchangeTimeline(full(), options)).toEqual(mapInterchangeTimeline(full(), options));
  });
});
