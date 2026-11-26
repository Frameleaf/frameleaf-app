import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InterchangeMedia, mapInterchangeTimeline } from 'src/utils/studio-interchange/map.js';
import { Clip, InterchangeProject, Stack, Track, TrackChild, seconds } from 'src/utils/studio-interchange/model.js';
import { InterchangeReadError } from 'src/utils/studio-interchange/readers/common.js';
import { readEdl, timecodeFrames } from 'src/utils/studio-interchange/readers/edl.js';
import { readFcp7Xml } from 'src/utils/studio-interchange/readers/fcp7.js';
import { fcpxmlSeconds, readFcpxml } from 'src/utils/studio-interchange/readers/fcpxml.js';
import { readInterchangeFile } from 'src/utils/studio-interchange/readers/index.js';
import { readOtio } from 'src/utils/studio-interchange/readers/otio.js';
import { applySidecars, readCdlFile, readCubeFile } from 'src/utils/studio-interchange/readers/sidecars.js';
import { parseXml } from 'src/utils/studio-interchange/xml.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const fixtures = join(repoRoot, 'server', 'test', 'fixtures', 'studio-interchange');
const fixture = (name: string) => readFileSync(join(fixtures, name));
const schema = JSON.parse(readFileSync(join(repoRoot, 'studio', 'graph-schema-v1.json'), 'utf8'));
const catalogue = JSON.parse(readFileSync(join(repoRoot, 'studio', 'graph-parameters-v1.json'), 'utf8'));
const protocolPath = join(repoRoot, 'studio', 'tools', 'graph-protocol.mjs');
const loadProtocol = (): Promise<{ validate: (schema: unknown, value: unknown) => string[] }> => import(protocolPath);
const fonts = new Set<string>(catalogue.fonts.families.map((family: { family: string }) => family.family));

const media = (assetId: string, kind: InterchangeMedia['kind'], durationSeconds: number): InterchangeMedia => ({
  assetId,
  kind,
  width: kind === 'audio' ? 0 : 1920,
  height: kind === 'audio' ? 0 : 1080,
  fps: kind === 'image' ? 0 : 25,
  frameCount: kind === 'image' ? null : durationSeconds * 25,
  durationSeconds,
});
describe('crafted Final Cut Pro XML', () => {
  const project = (resources: string) =>
    `<fcpxml version="1.11"><resources><format id="f" frameDuration="1/30s"/>${resources}</resources><library><event>` +
    `<project name="p"><sequence format="f"><spine><ref-clip ref="m0" offset="0s" duration="1s"/></spine></sequence>` +
    `</project></event></library></fcpxml>`;
  const compound = (id: number, refs: number) =>
    `<media id="m${id}"><sequence format="f"><spine>` +
    `<ref-clip ref="m${id + 1}" offset="0s" duration="1s"/>`.repeat(refs) +
    `</spine></sequence></media>`;

  it('refuses a compound clip that contains itself', () => {
    const cycle = `<media id="m0"><sequence format="f"><spine><ref-clip ref="m0" offset="0s" duration="1s"/></spine></sequence></media>`;
    expect(() => readFcpxml(project(cycle))).toThrow(/too deeply/);
  });

  it('refuses compound clips that multiply when expanded', () => {
    const levels = Array.from({ length: 20 }, (_, id) => compound(id, 10)).join('');
    expect(() => readFcpxml(project(levels))).toThrow(/too many clips/);
  });
});

/** The library answers by file name, the way the matcher (FL-1543) answers by name among other things. */
const library: Record<string, InterchangeMedia> = {
  'Lake morning.mov': media('0198a1c2-0000-7000-8000-000000000001', 'video', 60),
  'Kayak.mp4': media('0198a1c2-0000-7000-8000-000000000002', 'video', 30),
  'Ridge.jpg': media('0198a1c2-0000-7000-8000-000000000003', 'image', 0),
  'Campfire.wav': media('0198a1c2-0000-7000-8000-000000000004', 'audio', 120),
};

const clips = (tracks: readonly Track[]): Clip[] =>
  tracks.flatMap((track) =>
    track.children.flatMap((item: TrackChild) =>
      item.type === 'clip' ? [item] : item.type === 'stack' ? clips((item as Stack).tracks) : [],
    ),
  );
const named = (project: InterchangeProject, name: string) =>
  clips(project.timelines[0].tracks).find((clip) => clip.name === name)!;
/** Where a clip starts on its track, in seconds. */
const startOf = (track: Track, name: string) => {
  let position = 0;
  for (const item of track.children) {
    if (item.type === 'transition') {
      continue;
    }
    if (item.type === 'clip' && item.name === name) {
      return position;
    }
    position += item.sourceRange ? seconds(item.sourceRange.duration) : 0;
  }
  return null;
};

/** Every reader's timeline maps to a graph the protocol accepts. */
const expectValidGraph = async (project: InterchangeProject) => {
  const { validate } = await loadProtocol();
  for (const timeline of project.timelines) {
    const { graph, losses } = mapInterchangeTimeline(timeline, {
      source: project.source,
      seed: `fixture:${project.source}`,
      now: 1_763_000_000_000,
      resolveMedia: (reference) => library[reference.name] ?? null,
      fonts,
    });
    expect(validate(schema, graph)).toEqual([]);
    expect(JSON.stringify(graph)).not.toContain('/Volumes');
    expect(losses.filter((loss) => loss.code === 'media-missing')).toEqual([]);
  }
};

describe('parseXml', () => {
  it('refuses entity expansion and external entities', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><fcpxml>&lol2;</fcpxml>`;
    expect(() => parseXml(bomb)).toThrow(InterchangeReadError);
    const external = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><fcpxml>&xxe;</fcpxml>`;
    expect(() => parseXml(external)).toThrow(InterchangeReadError);
  });

  it('refuses files too deep, too large or not well formed', () => {
    expect(() => parseXml('<a>'.repeat(300) + '</a>'.repeat(300))).toThrow(/too deeply nested/);
    expect(() => parseXml('<a/>', { maxBytes: 2, maxDepth: 10, maxElements: 10 })).toThrow(/too large/);
    expect(() => parseXml('<a><b></a>')).toThrow(/not well-formed/);
  });
});

describe('readFcpxml', () => {
  const project = readFcpxml(fixture('lake-day.fcpxml'));
  const timeline = project.timelines[0];

  it('reads times as FCPXML writes them', () => {
    expect(fcpxmlSeconds('1001/30000s')).toBeCloseTo(0.0333667, 6);
    expect(fcpxmlSeconds('10s')).toBe(10);
    expect(fcpxmlSeconds('nonsense')).toBe(0);
  });

  it('flattens the primary storyline, connected title and role-named music to tracks', () => {
    expect(timeline).toMatchObject({
      name: 'Lake day',
      rate: { num: 25, den: 1 },
      canvas: { width: 1920, height: 1080 },
    });
    expect(timeline.tracks.map((track) => [track.kind, track.name])).toEqual([
      ['video', 'V1'],
      ['video', 'V2'],
      ['audio', 'Music'],
    ]);
    const [primary, titles] = timeline.tracks;
    expect(startOf(primary, 'Lake morning')).toBe(0);
    expect(startOf(primary, 'Kayak')).toBe(6);
    expect(primary.children.find((item) => item.type === 'transition')).toMatchObject({
      name: 'Cross Dissolve',
      inOffset: { value: 25 },
      outOffset: { value: 25 },
    });
    // A connected clip's offset is in its parent's media time: 3603 s in a clip that starts at 3602 s.
    expect(startOf(titles, 'Lake day')).toBe(1);
    expect(startOf(timeline.tracks[2], 'Campfire')).toBe(0);
  });

  it('keeps media starts relative to the file, speed, moves, sound and effects', () => {
    const lake = named(project, 'Lake morning');
    expect(seconds(lake.sourceRange.startTime)).toBe(2);
    expect(lake.mediaReference).toMatchObject({ kind: 'external', name: 'Lake morning.mov', facts: { width: 3840 } });
    expect(lake.frameleaf?.transform).toEqual({ x: 108, y: 54, scale: 1.2, rotation: 3 });
    expect(lake.frameleaf?.effects).toEqual([{ name: 'Gaussian Blur' }]);
    expect(lake.markers?.[0]).toMatchObject({ name: 'Heron', markedRange: { startTime: { value: 75 } } });
    const kayak = named(project, 'Kayak');
    expect(kayak.frameleaf).toMatchObject({ speed: 2, effects: [{ name: 'Film Glow', fromPlugin: true }] });
    expect(seconds(kayak.sourceRange.startTime)).toBe(4);
    expect(named(project, 'Campfire').frameleaf).toMatchObject({ volumeDb: -6, fadeInSeconds: 1, fadeOutSeconds: 2 });
    expect(named(project, 'Lake day').frameleaf?.title).toEqual({
      text: 'Lake day',
      font: 'Helvetica',
      size: 72,
      color: '#ffcc00',
      align: 'center',
    });
  });

  it('brings the picked audition over as a nest, and reports a switched-off clip', () => {
    const nest = timeline.tracks[0].children.find((item) => item.type === 'stack') as Stack;
    expect(nest.name).toBe('Ridge pan');
    expect(clips(nest.tracks).map((clip) => clip.name)).toEqual(['Ridge']);
    expect(clips(timeline.tracks).map((clip) => clip.name)).not.toContain('Kayak alt');
    expect(project.notices).toEqual([
      expect.objectContaining({ code: 'clips-disabled', subject: '1', what: 'A clip switched off in Final Cut Pro' }),
    ]);
  });

  it('reports an untested version and refuses other XML', async () => {
    const newer = readFcpxml(fixture('lake-day.fcpxml').toString().replace('version="1.10"', 'version="1.99"'));
    expect(newer.notices?.[0]).toMatchObject({ code: 'version-untested', what: 'Final Cut Pro XML version 1.99' });
    expect(() => readFcpxml('<xmeml/>')).toThrow(InterchangeReadError);
    expect(() => readFcpxml('<fcpxml version="1.10"><resources/></fcpxml>')).toThrow(/no project/);
    await expectValidGraph(project);
  });
});

describe('readFcp7Xml', () => {
  const project = readFcp7Xml(fixture('lake-day-fcp7.xml'));
  const timeline = project.timelines[0];

  it('places clips whose edges sit inside a transition', () => {
    const [pictures, titles, sound] = timeline.tracks;
    expect(timeline.tracks.map((track) => [track.kind, track.name])).toEqual([
      ['video', 'V1'],
      ['video', 'V2'],
      ['audio', 'A1'],
    ]);
    expect(startOf(pictures, 'Kayak')).toBe(6);
    expect(pictures.children.at(1)).toMatchObject({
      type: 'transition',
      inOffset: { value: 25 },
      outOffset: { value: 25 },
    });
    expect(startOf(titles, 'Lake day')).toBe(1);
    expect(startOf(sound, 'Lake morning')).toBe(0);
  });

  it('reads motion, speed, levels, titles, markers and a nested sequence', () => {
    const lake = named(project, 'Lake morning');
    expect(lake.frameleaf).toMatchObject({
      transform: { scale: 1.2, rotation: 3, x: 96, y: -27 },
      effects: [{ name: 'Gaussian Blur' }],
    });
    expect(lake.mediaReference).toMatchObject({
      key: 'file://localhost/Volumes/Jamie/Rockies/Lake%20morning.mov',
      name: 'Lake morning.mov',
    });
    expect(named(project, 'Kayak').frameleaf?.speed).toBe(2);
    const sound = clips([timeline.tracks[2]])[0];
    expect(sound.mediaReference).toMatchObject({ name: 'Lake morning.mov' });
    expect(sound.frameleaf?.volumeDb).toBeCloseTo(-6.02, 2);
    expect(named(project, 'Lake day')).toMatchObject({
      mediaReference: { kind: 'generator', generator: 'title' },
      frameleaf: { title: { text: 'Lake day', font: 'Helvetica', size: 81 } },
    });
    expect(timeline.markers?.[0]).toMatchObject({ name: 'Chapter one', note: 'Opening' });
    expect(timeline.tracks[0].children.at(-1)).toMatchObject({ type: 'stack', name: 'Ridge pan' });
  });

  it('maps to a valid Studio graph', async () => {
    await expectValidGraph(project);
  });
});

describe('readOtio', () => {
  const project = readOtio(fixture('lake-day.otio'));
  const timeline = project.timelines[0];

  it('reads tracks, transitions, gaps, nests and markers', () => {
    expect(timeline).toMatchObject({ name: 'Lake day', rate: { num: 25, den: 1 } });
    expect(timeline.tracks.map((track) => track.name)).toEqual(['V1', 'Titles', 'Music']);
    expect(timeline.tracks[0].children.map((item) => item.type)).toEqual([
      'clip',
      'transition',
      'clip',
      'gap',
      'stack',
    ]);
    expect(timeline.markers?.[0]).toMatchObject({ name: 'Chapter one', color: 'GREEN' });
  });

  it('reads speed, CDL, generators and what Frameleaf wrote itself', () => {
    expect(named(project, 'Kayak').frameleaf?.speed).toBe(2);
    expect(named(project, 'Lake morning').frameleaf?.grade?.cdl).toEqual({
      slope: [1.1, 1, 0.9],
      offset: [0.01, 0, -0.01],
      power: [1, 1, 1],
      saturation: 0.9,
    });
    expect(named(project, 'Lake day')).toMatchObject({
      mediaReference: { kind: 'generator', generator: 'title' },
      frameleaf: { title: { text: 'Lake day', font: 'Inter' } },
    });
  });

  it('keeps the place of an item it does not know, and says so', () => {
    expect(project.notices).toEqual([expect.objectContaining({ code: 'items-unknown', subject: '1' })]);
  });

  it('refuses deep nesting, other JSON and malformed files', () => {
    expect(() =>
      readOtio(
        '{"OTIO_SCHEMA":"Timeline.1","tracks":' +
          '{"OTIO_SCHEMA":"Stack.1","children":[{"OTIO_SCHEMA":"Track.1","children":['.repeat(40) +
          ']}]}'.repeat(40) +
          '}',
      ),
    ).toThrow(/too deeply nested/);
    expect(() => readOtio('{"hello":1}')).toThrow(/not an OpenTimelineIO file/);
    expect(() => readOtio('{')).toThrow(InterchangeReadError);
  });

  it('maps to a valid Studio graph with the CDL as a grade', async () => {
    await expectValidGraph(project);
    const { graph, losses } = mapInterchangeTimeline(timeline, {
      source: 'otio',
      seed: 'otio',
      now: 0,
      resolveMedia: (reference) => library[reference.name] ?? null,
      fonts,
    });
    expect(JSON.stringify(graph)).toContain('"gpuEffectType":"gpu-color-wheels"');
    expect(losses.map((loss) => loss.code)).toContain('grade-approximated');
  });
});

describe('readEdl', () => {
  it('counts drop-frame timecode the SMPTE way', () => {
    expect(timecodeFrames('00:01:00;02', { num: 30_000, den: 1001 })).toBe(1800);
    expect(timecodeFrames('00:10:00;00', { num: 30_000, den: 1001 })).toBe(17_982);
    expect(timecodeFrames('01:00:00:00', { num: 25, den: 1 })).toBe(90_000);
  });

  const project = readEdl(fixture('lake-day.edl'), { rate: { num: 25, den: 1 } });
  const timeline = project.timelines[0];

  it('reads events, dissolves, speed, black, sound, CDL and locators', () => {
    expect(timeline.name).toBe('Lake day');
    expect(timeline.tracks.map((track) => [track.kind, track.name])).toEqual([
      ['video', 'V1'],
      ['audio', 'A1'],
      ['audio', 'A2'],
    ]);
    const pictures = timeline.tracks[0];
    expect(pictures.children.map((item) => item.type)).toEqual(['clip', 'transition', 'clip', 'clip']);
    expect(pictures.children.at(1)).toMatchObject({
      name: 'SMPTE_Dissolve',
      inOffset: { value: 0 },
      outOffset: { value: 50 },
    });
    const lake = named(project, 'Lake morning.mov');
    expect(lake.mediaReference).toMatchObject({ key: '/Volumes/Jamie/Rockies/Lake morning.mov' });
    expect(lake.frameleaf?.grade?.cdl).toMatchObject({ slope: [1.1, 1, 0.9], saturation: 0.9 });
    expect(named(project, 'Kayak.mp4').frameleaf?.speed).toBe(2);
    expect(named(project, 'BL').mediaReference).toMatchObject({ kind: 'generator', generator: 'solid' });
    expect(timeline.markers).toEqual([expect.objectContaining({ name: 'Heron', color: 'RED' })]);
    expect(project.notices?.[0]).toMatchObject({
      code: 'edl-limits',
      what: 'Colour, effects, titles and picture moves',
    });
  });

  it('guesses the rate when no one says, and says so', () => {
    const guessed = readEdl(fixture('lake-day.edl'));
    expect(guessed.timelines[0].rate).toEqual({ num: 24, den: 1 });
    expect(guessed.notices?.[1]).toMatchObject({ code: 'edl-frame-rate', subject: '24' });
    expect(
      readEdl('FCM: DROP FRAME\n001  A  V  C  00:00:00;00 00:00:01;00 00:00:00;00 00:00:01;00\n').timelines[0].rate,
    ).toEqual({
      num: 30_000,
      den: 1001,
    });
  });

  it('refuses a list with no events', () => {
    expect(() => readEdl('TITLE: nothing\n')).toThrow(/no events/);
  });

  it('maps to a valid Studio graph', async () => {
    const { validate } = await loadProtocol();
    const { graph, losses } = mapInterchangeTimeline(timeline, {
      source: 'edl',
      seed: 'edl',
      now: 0,
      resolveMedia: (reference) => library[reference.name] ?? null,
      fonts,
    });
    expect(validate(schema, graph)).toEqual([]);
    // EDL dissolves start at the cut; Studio centres them and says so.
    expect(losses.map((loss) => loss.code)).toEqual(
      expect.arrayContaining(['generator-dropped', 'transition-recentred']),
    );
  });
});

describe('sidecars', () => {
  it('reads CDL, CC and CCC files', () => {
    expect(readCdlFile(fixture('lake-day.cdl')).get('Kayak')).toEqual({
      slope: [1.2, 1.1, 1],
      offset: [0.02, 0.01, 0],
      power: [0.9, 0.9, 0.9],
      saturation: 1.1,
    });
    const cc = '<ColorCorrection id="a"><SOPNode><Slope>2 2 2</Slope></SOPNode></ColorCorrection>';
    expect(readCdlFile(cc).get('a')?.slope).toEqual([2, 2, 2]);
    const ccc = `<ColorCorrectionCollection>${cc.replace('"a"', '"b"')}${cc}</ColorCorrectionCollection>`;
    expect(readCdlFile(ccc).keys().toArray()).toEqual(['b', 'a']);
  });

  it('stores a 3D LUT as Studio reads it and turns a 1D LUT into the same 3D table', () => {
    const swap = readCubeFile(fixture('Kayak.cube'), 'Kayak');
    expect(swap.lut).toMatchObject({ name: 'Swap', size: 2 });
    const bytes = Buffer.from(swap.lut.data, 'base64');
    expect(bytes).toHaveLength(2 ** 3 * 4);
    expect([...bytes.subarray(4, 8)]).toEqual([0, 0, 255, 255]);
    const lift = readCubeFile(fixture('Lake morning.cube'), 'Lake morning');
    expect(lift.lut.size).toBe(33);
    expect([...Buffer.from(lift.lut.data, 'base64').subarray(0, 4)]).toEqual([26, 26, 26, 255]);
    expect(() => readCubeFile('LUT_3D_SIZE 2\n0 0 0\n', 'short')).toThrow(/wrong number of entries/);
    expect(() => readCubeFile('0 0 0\n', 'unsized')).toThrow(/does not say its size/);
  });

  it('applies sidecars to the clips they name and reports the rest', () => {
    const project = readOtio(fixture('lake-day.otio'));
    applySidecars(project, [
      { name: 'lake-day.cdl', bytes: fixture('lake-day.cdl') },
      { name: 'Kayak.cube', bytes: fixture('Kayak.cube') },
      { name: 'Unused.cube', bytes: fixture('Kayak.cube') },
      { name: 'notes.txt', bytes: Buffer.from('hello') },
    ]);
    const kayak = named(project, 'Kayak');
    expect(kayak.frameleaf?.grade?.cdl?.slope).toEqual([1.2, 1.1, 1]);
    expect(kayak.frameleaf?.grade?.lut?.name).toBe('Swap');
    expect(project.notices?.filter((notice) => notice.code === 'sidecar-unused').map((notice) => notice.what)).toEqual([
      'Unused.cube',
      'notes.txt',
    ]);
  });
});

describe('readInterchangeFile', () => {
  it('picks the reader by extension and by the XML root', async () => {
    expect((await readInterchangeFile('Lake day.fcpxml', fixture('lake-day.fcpxml'))).project.source).toBe('finalcut');
    expect((await readInterchangeFile('Lake day.xml', fixture('lake-day.fcpxml'))).project.source).toBe('finalcut');
    expect((await readInterchangeFile('Lake day.xml', fixture('lake-day-fcp7.xml'))).project.source).toBe('fcp7');
    expect((await readInterchangeFile('Lake day.otio', fixture('lake-day.otio'))).project.source).toBe('otio');
    const edl = await readInterchangeFile('Lake day.edl', fixture('lake-day.edl'), {
      rate: { num: 25, den: 1 },
      sidecars: [{ name: 'lake-day.cdl', bytes: fixture('lake-day.cdl') }],
    });
    expect(edl.project.timelines[0].rate).toEqual({ num: 25, den: 1 });
    await expect(readInterchangeFile('Lake day.prproj', Buffer.from('x'))).rejects.toThrow(InterchangeReadError);
    await expect(readInterchangeFile('Lake day.otioz', Buffer.from('not a zip'))).rejects.toThrow(
      /could not be opened/,
    );
  });
});
