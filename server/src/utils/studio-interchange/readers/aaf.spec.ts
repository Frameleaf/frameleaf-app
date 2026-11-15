import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mapInterchangeTimeline } from 'src/utils/studio-interchange/map.js';
import { Clip, Track, seconds } from 'src/utils/studio-interchange/model.js';
import { readAaf } from 'src/utils/studio-interchange/readers/aaf.js';
import { CompoundFile } from 'src/utils/studio-interchange/readers/cfb.js';
import { readInterchangeFile } from 'src/utils/studio-interchange/readers/index.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const folder = join(repoRoot, 'server', 'test', 'fixtures', 'studio-interchange', 'aaf');
const schema = JSON.parse(readFileSync(join(repoRoot, 'studio', 'graph-schema-v1.json'), 'utf8'));
const protocolPath = join(repoRoot, 'studio', 'tools', 'graph-protocol.mjs');
const loadProtocol = (): Promise<{ validate: (schema: unknown, value: unknown) => string[] }> => import(protocolPath);
const read = (name: string) => readAaf(readFileSync(join(folder, `${name}.aaf`)));
const clips = (track: Track) => track.children.filter((item): item is Clip => item.type === 'clip');

// Expectations below were taken from otio-aaf-adapter's own reading of each file (OpenTimelineIO 0.18).
describe('readAaf', () => {
  it('reads a clip through its master clip to the file, and the producer', () => {
    const project = read('one_clip');
    expect(project).toMatchObject({
      source: 'aaf',
      sourceVersion: expect.stringContaining('Avid Media Composer 18.9'),
    });
    const [timeline] = project.timelines;
    expect(timeline).toMatchObject({ name: 'OTIO_Test_ppjoshm1.Exported.01', rate: { num: 24, den: 1 } });
    expect(timeline.tracks.map((track) => track.kind)).toEqual(['video', 'audio']);
    const [clip] = clips(timeline.tracks[0]);
    expect(clip).toMatchObject({
      name: 'ppjoshm_1 (SIM1)',
      mediaReference: {
        kind: 'external',
        key: 'file://VSD/Tools_Media/Avid%20MediaFiles/MXF/reverb.1/ppjoshm_1.V01.D8C35C9E69C8V.mxf',
        name: 'ppjoshm_1.V01.D8C35C9E69C8V.mxf',
      },
    });
    expect(seconds(clip.sourceRange.duration) * 24).toBeCloseTo(10, 6);
    expect(timeline.markers).toHaveLength(1);
  });

  it('meets clips at each transition’s cut, an edge fade included', () => {
    const [timeline] = read('transitions').timelines;
    const video = timeline.tracks.find((track) => track.kind === 'video')!;
    const transitions = video.children
      .filter((item) => item.type === 'transition')
      .map(
        (item) => item.type === 'transition' && [item.name, seconds(item.inOffset) * 24, seconds(item.outOffset) * 24],
      );
    // The adapter's offsets in frames: FadeUp 0/12, dissolve 48/0, 12/12, dip 24/24.
    expect(transitions.slice(0, 4)).toEqual([
      ['FadeUp', 0, 12],
      ['VideoDissolve', 48, 0],
      ['VideoDissolve', 12, 12],
      ['Dip', 24, 24],
    ]);
    const hawk = clips(video).find((clip) => clip.name === 't-hawk (loop)-HD.mp4')!;
    // 123 frames into its file (the adapter's 86523 less the file's 1:00:00:00 start).
    expect(seconds(hawk.sourceRange.startTime) * 24).toBeCloseTo(123, 6);
  });

  it('reads speed from Avid’s speed map, slow and fast', () => {
    const [timeline] = read('linear_speed_effects').timelines;
    const speeds = clips(timeline.tracks[0]).map((clip) => clip.frameleaf?.speed ?? 1);
    expect(speeds).toEqual([
      1, 0.5, 0.333, 0.25, 2, 1, 0.667, 0.5, 3, 1.5, 1, 0.75, 4, 2, 1.333, 1, 5, 2.5, 1.667, 1.25,
    ]);
  });

  it('turns Avid’s stacked video layers into tracks', () => {
    const [timeline] = read('multitrack').timelines;
    expect(timeline.tracks.filter((track) => track.kind === 'video')).toHaveLength(3);
    expect(timeline.markers).toHaveLength(3);
  });

  it('reads a Premiere Pro AAF at 29.97 with its file', () => {
    const project = read('2997fps-DFTC');
    expect(project.sourceVersion).toContain('Premiere Pro');
    expect(project.timelines[0].rate).toEqual({ num: 30_000, den: 1001 });
    expect(clips(project.timelines[0].tracks[0])[0].mediaReference).toMatchObject({
      name: '58982c7f-78b3-4cf9-8432-729fc4eafd55.mov',
    });
  });

  it('reports a clip switched off in Avid', () => {
    const project = read('test_muted_clip');
    expect(project.notices).toEqual([expect.objectContaining({ code: 'clips-disabled', subject: '1' })]);
  });

  it('maps every sample to a valid Studio graph', async () => {
    const { validate } = await loadProtocol();
    for (const name of ['one_clip', 'transitions', 'linear_speed_effects', 'multitrack', '2997fps-DFTC']) {
      for (const timeline of read(name).timelines) {
        const { graph } = mapInterchangeTimeline(timeline, {
          source: 'aaf',
          seed: name,
          now: 0,
          resolveMedia: () => null,
          fonts: new Set(['Inter']),
        });
        expect(validate(schema, graph), name).toEqual([]);
        expect(JSON.stringify(graph)).not.toContain('Tools_Media');
      }
    }
  });

  it('refuses what is not an AAF file, and a damaged one', async () => {
    expect(() => readAaf(Buffer.from('not a compound file at all'.padEnd(600, '.')))).toThrow(/not an AAF file/);
    const damaged = Buffer.from(readFileSync(join(folder, 'one_clip.aaf')));
    damaged.writeUInt32LE(damaged.length, 0x30);
    expect(() => readAaf(damaged)).toThrow(/damaged/);
    expect(() => new CompoundFile(readFileSync(join(folder, 'one_clip.aaf')).subarray(0, 4096))).toThrow(/damaged/);
    await expect(readInterchangeFile('Edit.aaf', readFileSync(join(folder, 'one_clip.aaf')))).resolves.toMatchObject({
      project: { source: 'aaf' },
    });
  });
});
