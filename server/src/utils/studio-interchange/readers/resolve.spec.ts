import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mapInterchangeTimeline } from 'src/utils/studio-interchange/map.js';
import { Clip, seconds } from 'src/utils/studio-interchange/model.js';
import { InterchangeReadError } from 'src/utils/studio-interchange/readers/common.js';
import { readInterchangeFile } from 'src/utils/studio-interchange/readers/index.js';
import { readResolve, resolveDouble, resolveFrames } from 'src/utils/studio-interchange/readers/resolve.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const folder = join(repoRoot, 'server', 'test', 'fixtures', 'studio-interchange', 'resolve');
const schema = JSON.parse(readFileSync(join(repoRoot, 'studio', 'graph-schema-v1.json'), 'utf8'));
const protocolPath = join(repoRoot, 'studio', 'tools', 'graph-protocol.mjs');
const loadProtocol = (): Promise<{ validate: (schema: unknown, value: unknown) => string[] }> => import(protocolPath);
const sourceOf = (bytes: Buffer) => ({
  size: bytes.length,
  read: (position: number, length: number) => Promise.resolve(bytes.subarray(position, position + length)),
});
const read = (name: string) => readResolve(sourceOf(readFileSync(join(folder, name))));

describe('readResolve', () => {
  it('reads Resolve’s numbers: hex doubles and frame|double', () => {
    expect(resolveDouble('0000000000003840')).toBe(24);
    expect(resolveDouble('000000000020ac40')).toBe(3600);
    expect(resolveFrames('47|0000eaffffffef3f')).toBeCloseTo(0.9999997, 6);
    expect(resolveFrames('120')).toBe(120);
    expect(resolveFrames(undefined)).toBe(0);
  });

  it('reads a Resolve project: timeline, rate, canvas, version and its sound clip', async () => {
    const project = await read('fixture_markers-01.drp');
    expect(project).toMatchObject({ source: 'resolve', sourceVersion: '17' });
    const [timeline] = project.timelines;
    expect(timeline).toMatchObject({
      name: 'Fixture',
      rate: { num: 24, den: 1 },
      canvas: { width: 1920, height: 1080 },
    });
    const sound = timeline.tracks.filter((track) => track.kind === 'audio').flatMap((track) => track.children);
    const clip = sound.find((item): item is Clip => item.type === 'clip')!;
    // Start 86400 frames is the timeline's 1:00:00:00 start: the clip opens the timeline.
    expect(clip).toMatchObject({
      name: 'sine1k.wav',
      mediaReference: { kind: 'external', key: '/tmp/drpkit-fixture/audio/sine1k.wav', facts: { kind: 'audio' } },
    });
    expect(seconds(clip.sourceRange.duration) * 24).toBeCloseTo(239, 6);
    expect(sound[0].type).toBe('clip');
    // Markers Resolve keeps as binary blobs are reported, not dropped without a word.
    expect(project.notices).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'items-unknown' })]));
  });

  it('places video clips and the cross dissolve between them at the cut', async () => {
    const [timeline] = (await read('two-clips-dissolve.drt')).timelines;
    const pictures = timeline.tracks.find((track) => track.kind === 'video')!;
    expect(pictures.name).toBe('Pictures');
    expect(pictures.children.map((item) => item.type)).toEqual(['clip', 'transition', 'clip']);
    const [lake, dissolve, kayak] = pictures.children;
    expect(lake).toMatchObject({ name: 'Lake morning.mov', mediaReference: { name: 'Lake morning.mov' } });
    expect(seconds((lake as Clip).sourceRange.startTime)).toBe(2);
    expect(dissolve).toMatchObject({
      type: 'transition',
      name: 'Cross Dissolve',
      inOffset: { value: 12 },
      outOffset: { value: 12 },
    });
    expect(kayak).toMatchObject({ name: 'Kayak.mp4' });
  });

  it('maps every fixture to a valid Studio graph', async () => {
    const { validate } = await loadProtocol();
    for (const name of [
      'fixture_default-01.drp',
      'fixture_markers-01.drp',
      'fixture_fades_48_24-01.drp',
      'two-clips-dissolve.drt',
    ]) {
      for (const timeline of (await read(name)).timelines) {
        const { graph } = mapInterchangeTimeline(timeline, {
          source: 'resolve',
          seed: name,
          now: 0,
          resolveMedia: () => null,
          fonts: new Set(['Inter']),
        });
        expect(validate(schema, graph), name).toEqual([]);
      }
    }
  });

  it('refuses a file that is not a Resolve archive', async () => {
    await expect(readResolve(sourceOf(Buffer.from('not a zip')))).rejects.toThrow(InterchangeReadError);
    await expect(
      readInterchangeFile('Fixture.drp', readFileSync(join(folder, 'fixture_default-01.drp'))),
    ).resolves.toMatchObject({ project: { source: 'resolve' } });
  });
});
