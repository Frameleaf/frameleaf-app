import type { PersonResponseDto } from 'src/dtos/person.dto.js';
import type { TagResponseDto } from 'src/dtos/tag.dto.js';
import { AssetDetails, assetDetailsXmp } from 'src/utils/asset-details-xmp.js';

type Exif = NonNullable<AssetDetails['exifInfo']>;
const exif = (values: Partial<Exif>) => values as Exif;
const tag = (value: string) => ({ value, name: value.split('/').at(-1) }) as TagResponseDto;
const person = (name: string, isHidden = false) => ({ name, isHidden }) as PersonResponseDto;

const details = (values: Partial<AssetDetails> = {}): AssetDetails => ({
  localDateTime: '2024-07-01T10:00:00.000Z',
  exifInfo: exif({
    dateTimeOriginal: '2024-07-01T16:00:00.000Z',
    timeZone: 'America/Edmonton',
    latitude: 51.1784,
    longitude: -115.5708,
    description: 'Lake Louise at dawn',
    rating: 4,
    isRejected: false,
    orientation: '6',
  }),
  tags: [tag('Travel/Canada/Banff'), tag('Family')],
  people: [person('Ana'), person('Sam')],
  ...values,
});

/** The value of one simple XMP field, or undefined when the file leaves it out. */
const field = (xmp: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xmp)?.[1];
const items = (xmp: string, name: string) =>
  (new RegExp(`<${name}>(.*?)</${name}>`).exec(xmp)?.[1] ?? '')
    .matchAll(/<rdf:li[^>]*>([^<]*)<\/rdf:li>/g)
    .map((match) => match[1])
    .toArray();

describe('assetDetailsXmp (FL-423)', () => {
  it('writes the date, place, description, rating, tags, people and orientation the response shows', () => {
    const xmp = assetDetailsXmp(details(), { orientation: true });

    // the packet header carries the byte order mark U+FEFF
    expect(xmp.startsWith(`<?xpacket begin="${String.fromCodePoint(0xfe_ff)}" id="W5M0MpCehiHzreSzNTczkc9d"?>`)).toBe(
      true,
    );
    expect(xmp.trimEnd().endsWith('<?xpacket end="w"?>')).toBe(true);
    // in the photo's own time zone (Edmonton is UTC-6 in July)
    expect(field(xmp, 'exif:DateTimeOriginal')).toBe('2024-07-01T10:00:00.000-06:00');
    expect(field(xmp, 'photoshop:DateCreated')).toBe('2024-07-01T10:00:00.000-06:00');
    expect(field(xmp, 'exif:GPSLatitude')).toBe('51,10.704000N');
    expect(field(xmp, 'exif:GPSLongitude')).toBe('115,34.248000W');
    expect(field(xmp, 'tiff:Orientation')).toBe('6');
    expect(field(xmp, 'xmp:Rating')).toBe('4');
    expect(items(xmp, 'dc:description')).toEqual(['Lake Louise at dawn']);
    expect(items(xmp, 'dc:subject')).toEqual(['Banff', 'Family']);
    expect(items(xmp, 'lr:hierarchicalSubject')).toEqual(['Travel|Canada|Banff', 'Family']);
    expect(items(xmp, 'digiKam:TagsList')).toEqual(['Travel/Canada/Banff', 'Family']);
    expect(items(xmp, 'Iptc4xmpExt:PersonInImage')).toEqual(['Ana', 'Sam']);
  });

  it('leaves out what the response does not show, and the orientation of an edit that is already upright', () => {
    const xmp = assetDetailsXmp(
      details({
        exifInfo: exif({ dateTimeOriginal: null, latitude: null, longitude: null, rating: null, description: '' }),
        tags: [],
        people: [],
      }),
      { orientation: false },
    );

    // with no capture date, the wall-clock time the timeline shows
    expect(field(xmp, 'exif:DateTimeOriginal')).toBe('2024-07-01T10:00:00.000');
    for (const name of ['exif:GPSLatitude', 'tiff:Orientation', 'xmp:Rating']) {
      expect(field(xmp, name)).toBeUndefined();
    }
    for (const name of ['dc:description', 'dc:subject', 'Iptc4xmpExt:PersonInImage']) {
      expect(xmp).not.toContain(`<${name}>`);
    }
    expect(assetDetailsXmp(details(), { orientation: false })).not.toContain('tiff:Orientation');
  });

  it('keeps hidden and unnamed people out, marks a rejected photo and escapes what people typed', () => {
    const xmp = assetDetailsXmp(
      details({
        exifInfo: exif({
          dateTimeOriginal: '2024-01-05T12:00:00.000Z',
          timeZone: null,
          rating: null,
          isRejected: true,
          description: 'Tom & "Jo" <3\u{7}',
          latitude: -33.8568,
          longitude: 151.2153,
        }),
        people: [person('Ana'), person('Hidden', true), person('  '), person('Ana')],
        tags: [tag('Food & drink')],
      }),
      { orientation: true },
    );

    expect(field(xmp, 'exif:DateTimeOriginal')).toBe('2024-01-05T12:00:00.000Z');
    expect(field(xmp, 'exif:GPSLatitude')).toBe('33,51.408000S');
    expect(field(xmp, 'exif:GPSLongitude')).toBe('151,12.918000E');
    expect(field(xmp, 'xmp:Rating')).toBe('-1');
    expect(items(xmp, 'Iptc4xmpExt:PersonInImage')).toEqual(['Ana']);
    expect(items(xmp, 'dc:description')).toEqual(['Tom &amp; &quot;Jo&quot; &lt;3']);
    expect(items(xmp, 'digiKam:TagsList')).toEqual(['Food &amp; drink']);
  });
});
