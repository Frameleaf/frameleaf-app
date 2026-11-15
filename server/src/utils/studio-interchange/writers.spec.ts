import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InterchangeMedia, mapInterchangeTimeline } from 'src/utils/studio-interchange/map.js';
import { Timeline, Track, seconds } from 'src/utils/studio-interchange/model.js';
import { readEdl } from 'src/utils/studio-interchange/readers/edl.js';
import { readFcp7Xml } from 'src/utils/studio-interchange/readers/fcp7.js';
import { readFcpxml } from 'src/utils/studio-interchange/readers/fcpxml.js';
import { readOtio } from 'src/utils/studio-interchange/readers/otio.js';
import { unmapStudioGraph } from 'src/utils/studio-interchange/unmap.js';
import { SEND_BACK_FILES, SendBackFormat, sendBackReport } from 'src/utils/studio-interchange/writers.js';

const fixtures = fileURLToPath(new URL('../../../test/fixtures/studio-interchange/', import.meta.url));
const lake = readFcpxml(readFileSync(join(fixtures, 'lake-day.fcpxml'))).timelines[0];

/** Clip name, start and length on each track, in seconds rounded to frames. */
const layout = (timeline: Timeline, kind?: Track['kind']) =>
  timeline.tracks
    .filter((track) => !kind || track.kind === kind)
    .map((track) => {
      let position = 0;
      const out: [string, number, number][] = [];
      for (const child of track.children) {
        if (child.type === 'transition') {
          continue;
        }
        const duration = child.sourceRange ? seconds(child.sourceRange.duration) : 0;
        if (child.type === 'clip' && child.mediaReference.kind === 'external') {
          out.push([child.mediaReference.name, Math.round(position * 25), Math.round(duration * 25)]);
        }
        position += duration;
      }
      return out;
    })
    .filter((track) => track.length > 0);

const readBack: Record<SendBackFormat, (text: string) => Timeline> = {
  otio: (text) => readOtio(text).timelines[0],
  fcpxml: (text) => readFcpxml(text).timelines[0],
  fcp7: (text) => readFcp7Xml(text).timelines[0],
  edl: (text) => readEdl(text, { rate: { num: 25, den: 1 } }).timelines[0],
};

describe('writers', () => {
  it.each(['otio', 'fcpxml', 'fcp7'] as const)(
    'writes %s that reads back to the same clips in the same places',
    (format) => {
      const written = SEND_BACK_FILES[format].write(lake);
      const back = readBack[format](written);
      expect(back.rate).toEqual(lake.rate);
      expect(layout(back).flat().map(String).toSorted()).toEqual(layout(lake).flat().map(String).toSorted());
      // Transitions survive.
      expect(back.tracks.some((track) => track.children.some((child) => child.type === 'transition'))).toBe(true);
    },
  );

  it('writes an EDL of the first picture track and the sound, which reads back', () => {
    const back = readBack.edl(SEND_BACK_FILES.edl.write(lake));
    expect(layout(back, 'video')[0]).toEqual(layout(lake, 'video')[0]);
    expect(layout(back, 'audio').flat()).toEqual(layout(lake, 'audio').flat());
  });

  it('keeps speed, titles and levels where the format carries them', () => {
    const otio = readOtio(SEND_BACK_FILES.otio.write(lake)).timelines[0];
    const clips = otio.tracks.flatMap((track) => track.children);
    expect(clips.find((child) => child.type === 'clip' && child.name === 'Kayak')).toMatchObject({
      frameleaf: { speed: 2 },
    });
    expect(clips.find((child) => child.type === 'clip' && child.name === 'Lake day')).toMatchObject({
      mediaReference: { generator: 'title' },
      frameleaf: { title: { text: 'Lake day' } },
    });
    const fcp7 = readFcp7Xml(SEND_BACK_FILES.fcp7.write(lake)).timelines[0];
    const campfire = fcp7.tracks
      .flatMap((track) => track.children)
      .find((child) => child.type === 'clip' && child.name === 'Campfire');
    expect(campfire).toMatchObject({ frameleaf: { volumeDb: -6 } });
  });

  it('says what each kind of file leaves behind, naming the clips', () => {
    expect(sendBackReport(lake, 'edl')).toEqual(
      expect.arrayContaining([
        { code: 'titles', clips: ['Lake day'] },
        { code: 'upper-tracks', clips: ['Lake day'] },
        { code: 'effects', clips: ['Lake morning', 'Kayak'] },
        { code: 'nests', clips: ['Ridge pan'] },
      ]),
    );
    expect(sendBackReport(lake, 'otio').map((note) => note.code)).toEqual(['effects']);
  });
});

describe('unmapStudioGraph', () => {
  it('turns a Studio project back into the timeline it came from', () => {
    const files: Record<string, InterchangeMedia> = {};
    let next = 1;
    const { graph } = mapInterchangeTimeline(lake, {
      source: 'finalcut',
      seed: 'unmap',
      now: 0,
      fonts: new Set(['Inter']),
      resolveMedia: (reference) => {
        files[reference.name] ??= {
          assetId: `0198a1c2-0000-7000-8000-${String(next++).padStart(12, '0')}`,
          kind: reference.facts?.kind ?? 'video',
          width: 1920,
          height: 1080,
          fps: 25,
          frameCount: 25 * 120,
          durationSeconds: 120,
        };
        return files[reference.name];
      },
    });
    const names = new Map(Object.entries(files).map(([name, media]) => [media.assetId, name]));
    const back = unmapStudioGraph(graph as never, (id) => (names.has(id) ? { name: names.get(id)! } : undefined));
    expect(back).toMatchObject({ name: 'Lake day', rate: { num: 25, den: 1 }, canvas: { width: 1920, height: 1080 } });
    expect(layout(back).flat().map(String).toSorted()).toEqual(layout(lake).flat().map(String).toSorted());
    expect(back.tracks.flatMap((track) => track.children).some((child) => child.type === 'transition')).toBe(true);
    expect(back.tracks.flatMap((track) => track.children).some((child) => child.type === 'stack')).toBe(true);
  });
});
