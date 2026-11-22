import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  HistoryFormatError,
  type HistoryPoint,
  type HistoryReport,
  jsonEntries,
  parseHistoryFile,
  parseHistoryStream,
} from 'src/location-history/parse.js';

const fixtures = path.resolve(import.meta.dirname, '../../test/fixtures/location-history');

const read = async (points: AsyncIterable<HistoryPoint>) => {
  const all: HistoryPoint[] = [];
  for await (const point of points) {
    all.push(point);
  }
  const times = all.map((point) => point.recordedAt.getTime());
  return {
    all,
    count: all.length,
    first: all.length > 0 ? new Date(Math.min(...times)).toISOString() : null,
    last: all.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
  };
};

const readFixture = async (name: string) => {
  const report: HistoryReport = { kind: null, skipped: 0 };
  const result = await read(parseHistoryFile(path.join(fixtures, name), report));
  return { ...result, ...report };
};

/** The bytes a few at a time, so every entry and every multi-byte character is split across chunks. */
// eslint-disable-next-line @typescript-eslint/require-await
async function* drip(bytes: Buffer, size: number) {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

describe('location history files', () => {
  it.each([
    // file, kind, places, left out, first, last
    ['Timeline.android.json', 'google-timeline', 8, 1, '2024-07-01T15:00:00.000Z', '2024-07-01T16:30:00.000Z'],
    ['Timeline.iphone.json', 'google-timeline', 7, 0, '2024-08-10T06:00:00.000Z', '2024-08-10T08:00:00.000Z'],
    ['Records.json', 'google-records', 4, 1, '2019-04-03T01:00:00.000Z', '2019-04-03T18:00:00.000Z'],
    ['2019_JULY.json', 'google-timeline', 6, 0, '2019-07-05T15:00:00.000Z', '2019-07-05T16:30:00.000Z'],
    ['track.gpx', 'gpx', 6, 2, '2023-09-16T08:00:00.000Z', '2023-09-16T09:40:00.000Z'],
    ['owntracks.rec', 'owntracks', 3, 2, '2022-05-20T14:00:00.000Z', '2022-05-20T14:15:00.000Z'],
    ['owntracks-api.json', 'owntracks', 2, 1, '2022-05-21T14:00:00.000Z', '2022-05-21T14:05:00.000Z'],
    ['dawarich.geojson', 'geojson', 4, 1, '2023-11-14T22:13:20.000Z', '2023-11-14T22:33:20.000Z'],
  ])('reads %s', async (name, kind, count, skipped, first, last) => {
    const result = await readFixture(name);
    expect({ ...result, all: undefined }).toEqual({ all: undefined, kind, count, skipped, first, last });
    for (const point of result.all) {
      expect(Math.abs(point.latitude)).toBeLessThanOrEqual(90);
      expect(Math.abs(point.longitude)).toBeLessThanOrEqual(180);
      expect(point.accuracyM === null || point.accuracyM <= 500).toBe(true);
    }
  });

  it('reads the same places however the file is cut into chunks', async () => {
    for (const name of ['Timeline.android.json', 'Records.json', 'track.gpx', 'owntracks.rec', 'dawarich.geojson']) {
      const bytes = await readFile(path.join(fixtures, name));
      const whole = await readFixture(name);
      for (const size of [1, 7, 64]) {
        const report: HistoryReport = { kind: null, skipped: 0 };
        const dripped = await read(parseHistoryStream(drip(bytes, size), report));
        expect(dripped.all).toEqual(whole.all);
        expect(report).toEqual({ kind: whole.kind, skipped: whole.skipped });
      }
    }
  });

  it('keeps accuracy, and wraps the unsigned longitudes old Takeout files wrote', async () => {
    const { all } = await readFixture('Records.json');
    expect(all[0]).toEqual({
      recordedAt: new Date('2019-04-03T01:00:00.000Z'),
      latitude: 35.6585,
      longitude: 139.7454,
      accuracyM: 14,
    });
    expect(all[3].longitude).toBeCloseTo(-115.5708, 3);
  });

  it('takes an iPhone path point’s time from its segment’s start', async () => {
    const { all } = await readFixture('Timeline.iphone.json');
    expect(all.find((point) => point.latitude === 48.146)?.recordedAt.toISOString()).toBe('2024-08-10T07:47:00.000Z');
  });

  it('reads every history file inside a ZIP and passes over the rest', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'location-history-'));
    try {
      const zipPath = path.join(directory, 'takeout.zip');
      const archive = new ZipArchive();
      archive.file(path.join(fixtures, 'Records.json'), { name: 'Takeout/Location History (Timeline)/Records.json' });
      archive.file(path.join(fixtures, '2019_JULY.json'), {
        name: 'Takeout/Location History (Timeline)/Semantic Location History/2019/2019_JULY.json',
      });
      archive.append('{"cell": false}', { name: 'Takeout/Location History (Timeline)/Settings.json' });
      archive.append('not a history', { name: 'Takeout/archive_browser.html' });
      archive.append('not a history either', { name: 'Takeout/notes.json', store: true });
      void archive.finalize();
      await pipeline(archive, createWriteStream(zipPath));

      const report: HistoryReport = { kind: null, skipped: 0 };
      const result = await read(parseHistoryFile(zipPath, report));
      expect(result.count).toBe(10);
      expect(report).toEqual({ kind: 'google-records', skipped: 1 });
      expect(result.first).toBe('2019-04-03T01:00:00.000Z');
      expect(result.last).toBe('2019-07-05T16:30:00.000Z');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a file that is not a history', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'location-history-'));
    try {
      for (const [name, content] of [
        ['photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])],
        ['empty.json', Buffer.from('  \n')],
        ['cut.json', Buffer.from('{"locations":[{"latitudeE7": 1, "longitudeE7": }]}')],
        ['cut.gpx', Buffer.from('<gpx><trk><trkseg><trkpt lat="1" lon="2"></trk></gpx>')],
      ] as const) {
        const filePath = path.join(directory, name);
        await writeFile(filePath, content);
        await expect(read(parseHistoryFile(filePath, { kind: null, skipped: 0 }))).rejects.toBeInstanceOf(
          HistoryFormatError,
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('finds nothing, and names no format, in JSON that is something else', async () => {
    const report: HistoryReport = { kind: null, skipped: 0 };
    const bytes = Buffer.from('{"albums":[{"title":"Summer","photos":[{"lat":1}]}],"count":1}');
    expect((await read(parseHistoryStream(drip(bytes, 5), report))).count).toBe(0);
    expect(report.kind).toBeNull();
  });

  it('gives each list entry with its key, whatever sits in strings', async () => {
    const text = String.raw`{"a":"x[{","b":[{"n":1,"s":"}]\"{"},{"n":[{"deep":2}]}],"c":{"d":[{"n":3}]},"e":[1,[{"n":4}],{"n":5}]}`;
    const seen = [];
    // eslint-disable-next-line @typescript-eslint/require-await
    const strings = (async function* () {
      for (let index = 0; index < text.length; index += 3) {
        yield text.slice(index, index + 3);
      }
    })();
    for await (const entry of jsonEntries(strings)) {
      seen.push(entry);
    }
    expect(seen).toEqual([
      { key: 'b', entry: { n: 1, s: '}]"{' } },
      { key: 'b', entry: { n: [{ deep: 2 }] } },
      { key: 'e', entry: { n: 5 } },
    ]);
  });
});
