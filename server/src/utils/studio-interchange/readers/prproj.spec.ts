import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { mapInterchangeTimeline } from 'src/utils/studio-interchange/map.js';
import { Clip, Stack, Track, seconds } from 'src/utils/studio-interchange/model.js';
import { InterchangeReadError } from 'src/utils/studio-interchange/readers/common.js';
import { readInterchangeFile } from 'src/utils/studio-interchange/readers/index.js';
import { readPrproj } from 'src/utils/studio-interchange/readers/prproj.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const folder = join(repoRoot, 'server', 'test', 'fixtures', 'studio-interchange', 'premiere');
const schema = JSON.parse(readFileSync(join(repoRoot, 'studio', 'graph-schema-v1.json'), 'utf8'));
const protocolPath = join(repoRoot, 'studio', 'tools', 'graph-protocol.mjs');
const loadProtocol = (): Promise<{ validate: (schema: unknown, value: unknown) => string[] }> => import(protocolPath);

const SAMPLES = ['07_transitions', '10_audio_volume', '14_item_markers', '34_generators', '43_slip'];
const read = (name: string) => readPrproj(readFileSync(join(folder, `${name}.prproj`)));

type TruthClip = {
  name: string;
  start: { seconds: number };
  end: { seconds: number };
  inPoint: { seconds: number };
  components?: { matchName: string; params: { displayName: string; value: unknown }[] }[];
};
type TruthSequence = {
  name: string;
  videoTracks: { clips: TruthClip[] }[];
  audioTracks: { clips: TruthClip[] }[];
  markers?: { name: string; start: { seconds: number } }[];
};
const truth = (name: string): { sequences: TruthSequence[] } =>
  JSON.parse(readFileSync(join(folder, `${name}.json`), 'utf8'));

/** Every clip or nest of a track with where it starts on the timeline. */
const placed = (track: Track) => {
  const out: { name: string; start: number; duration: number; item: Clip | Stack }[] = [];
  let position = 0;
  for (const item of track.children) {
    if (item.type === 'transition') {
      continue;
    }
    const length = item.sourceRange ? seconds(item.sourceRange.duration) : 0;
    if (item.type !== 'gap') {
      out.push({ name: item.name, start: position, duration: length, item });
    }
    position += length;
  }
  return out;
};

describe('readPrproj', () => {
  it.each(SAMPLES)('places every clip of %s where Premiere does', (name) => {
    const project = read(name);
    expect(project.source).toBe('premiere');
    for (const sequence of truth(name).sequences) {
      const timeline = project.timelines.find((item) => item.name === sequence.name)!;
      expect(timeline).toBeDefined();
      for (const [kind, truthTracks] of [
        ['video', sequence.videoTracks],
        ['audio', sequence.audioTracks],
      ] as const) {
        const expected = truthTracks.flatMap((track) => track.clips);
        const actual = timeline.tracks.filter((track) => track.kind === kind).flatMap((track) => placed(track));
        expect(actual.map((clip) => clip.name).toSorted()).toEqual(expected.map((clip) => clip.name).toSorted());
        for (const clip of expected) {
          const found = actual.find(
            (item) => item.name === clip.name && Math.abs(item.start - clip.start.seconds) < 1e-3,
          );
          expect(found, `${sequence.name} ${kind} ${clip.name} at ${clip.start.seconds}`).toBeDefined();
          expect(found!.duration).toBeCloseTo(clip.end.seconds - clip.start.seconds, 3);
          if (
            found!.item.type === 'clip' &&
            found!.item.mediaReference.kind === 'external' &&
            found!.item.mediaReference.facts?.kind !== 'image'
          ) {
            expect(seconds(found!.item.sourceRange.startTime)).toBeCloseTo(clip.inPoint.seconds, 3);
          }
        }
      }
    }
  });

  it('reads the canvas, the exact rate, nests and the file of each clip', () => {
    const project = read('07_transitions');
    const seqA = project.timelines.find((item) => item.name === 'Seq A')!;
    expect(seqA).toMatchObject({ rate: { num: 30_000, den: 1001 }, canvas: { width: 64, height: 36 } });
    const red = placed(seqA.tracks[0])[0].item as Clip;
    expect(red.mediaReference).toMatchObject({
      kind: 'external',
      key: String.raw`C:\Users\del-m\git\py-premiere\samples\models\assets\red_64x36.bmp`,
      name: 'red_64x36.bmp',
      facts: { kind: 'image' },
    });
    const seqB = project.timelines.find((item) => item.name === 'Seq B')!;
    expect(placed(seqB.tracks[0])[0].item).toMatchObject({ type: 'stack', name: 'Seq A' });
  });

  it('reads transitions, a fade from black at a clip edge included', () => {
    const seqA = read('07_transitions').timelines.find((item) => item.name === 'Seq A')!;
    expect(seqA.tracks[0].children.at(0)).toMatchObject({
      type: 'transition',
      name: 'Additive Dissolve (Legacy)',
      inOffset: { value: 0 },
    });
  });

  it('reads sound levels, Premiere storing 0 dB as 0.1778', () => {
    const seqA = read('10_audio_volume').timelines.find((item) => item.name === 'Seq A')!;
    const tone = seqA.tracks
      .filter((track) => track.kind === 'audio')
      .flatMap((track) => placed(track))
      .find((clip) => clip.name === 'tone_440_1s.wav')!.item as Clip;
    // 0.35 linear: 20·log10(0.35) + 15.
    expect(tone.frameleaf?.volumeDb).toBeCloseTo(5.88, 2);
  });

  it('reads sequence and clip markers', () => {
    const project = read('14_item_markers');
    const markers = project.timelines.flatMap((timeline) => [
      ...(timeline.markers ?? []),
      ...timeline.tracks.flatMap((track) =>
        placed(track).flatMap(({ item }) => (item.type === 'clip' ? (item.markers ?? []) : [])),
      ),
    ]);
    expect(markers.length).toBeGreaterThan(0);
    expect(markers.map((marker) => marker.name)).toEqual(expect.arrayContaining(['chapter', 'comment']));
    const comment = markers.find((marker) => marker.name === 'comment')!;
    expect(comment).toMatchObject({ note: 'with end' });
    expect(seconds(comment.markedRange.duration)).toBeCloseTo(1, 3);
  });

  it('turns Premiere’s generated clips into generators', () => {
    const project = read('34_generators');
    const generators = project.timelines.flatMap((timeline) =>
      timeline.tracks.flatMap((track) =>
        placed(track).flatMap(({ item }) =>
          item.type === 'clip' && item.mediaReference.kind === 'generator' ? [item.mediaReference] : [],
        ),
      ),
    );
    for (const generator of generators) {
      expect(['solid', 'other']).toContain(generator.generator);
    }
  });

  it.each(SAMPLES)('maps every sequence of %s to a valid Studio graph', async (name) => {
    const { validate } = await loadProtocol();
    for (const timeline of read(name).timelines) {
      const { graph } = mapInterchangeTimeline(timeline, {
        source: 'premiere',
        seed: name,
        now: 0,
        resolveMedia: () => null,
        fonts: new Set(['Inter']),
      });
      expect(validate(schema, graph)).toEqual([]);
      expect(JSON.stringify(graph)).not.toContain('del-m');
    }
  });

  it('refuses a gzip bomb, other XML and a file that is not gzip or XML', async () => {
    const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x20), { level: 9 });
    expect(bomb.length).toBeLessThan(10_000);
    expect(() => readPrproj(bomb, 1024 * 1024)).toThrow(/too large to read once uncompressed/);
    expect(() => readPrproj(gzipSync('<fcpxml/>'))).toThrow(InterchangeReadError);
    expect(() => readPrproj(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01]))).toThrow(/could not be uncompressed/);
    await expect(
      readInterchangeFile('Seq.prproj', readFileSync(join(folder, '07_transitions.prproj'))),
    ).resolves.toMatchObject({
      project: { source: 'premiere' },
    });
  });
});
