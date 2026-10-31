import { DateTime } from 'luxon';
import type { AssetResponseDto } from 'src/dtos/asset-response.dto.js';

/**
 * FL-423 (ACCOUNT-P5): the details file a download puts beside a photo that has no XMP sidecar of its
 * own. It is built from the asset response the person downloading already sees, never from the row,
 * so it can hold no more than that response shows them: a shared link's response has no people, and a
 * link that hides metadata never reaches a download at all.
 *
 * It holds the capture date, the location's coordinates, the description, the rating, the tags, the
 * names of the people in the photo and, for an original, its orientation, in the XMP fields photo
 * apps (and Frameleaf's own metadata reader) read back.
 */
export type AssetDetails = Pick<AssetResponseDto, 'exifInfo' | 'tags' | 'people' | 'localDateTime'>;

export type AssetDetailsOptions = {
  /** The archive holds the original, whose pixels the orientation applies to; an edit is already upright. */
  orientation: boolean;
};

/** The byte order mark an XMP packet header carries. */
const BOM = String.fromCodePoint(0xfe_ff);

/** Characters XML 1.0 allows; everything else (control characters, lone surrogates) is dropped. */
const isXmlChar = (code: number) =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7_ff) ||
  (code >= 0xe0_00 && code <= 0xff_fd) ||
  (code >= 0x1_00_00 && code <= 0x10_ff_ff);

const text = (value: string) =>
  [...value]
    .filter((character) => isXmlChar(character.codePointAt(0)!))
    .join('')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** XMP's GPSCoordinate: degrees, then decimal minutes and the hemisphere ("51,10.704000N"). */
const coordinate = (value: number, positive: string, negative: string) => {
  const absolute = Math.abs(value);
  const degrees = Math.floor(absolute);
  const minutes = (absolute - degrees) * 60;
  return `${degrees},${minutes.toFixed(6)}${value < 0 ? negative : positive}`;
};

/** When it was taken, in its own time zone when known; otherwise the wall-clock time the timeline shows. */
const captureDate = (details: AssetDetails): string | null => {
  const exif = details.exifInfo;
  if (exif?.dateTimeOriginal) {
    const utc = DateTime.fromISO(exif.dateTimeOriginal, { zone: 'UTC' });
    const zoned = exif.timeZone ? utc.setZone(exif.timeZone) : utc;
    return (zoned.isValid ? zoned : utc).toISO();
  }
  const local = DateTime.fromISO(details.localDateTime, { zone: 'UTC' });
  return local.isValid ? local.toISO({ includeOffset: false }) : null;
};

const bag = (kind: 'Bag' | 'Seq', values: string[]) =>
  `<rdf:${kind}>${values.map((value) => `<rdf:li>${text(value)}</rdf:li>`).join('')}</rdf:${kind}>`;

export const assetDetailsXmp = (details: AssetDetails, options: AssetDetailsOptions): string => {
  const exif = details.exifInfo;
  const fields: string[] = [];

  const date = captureDate(details);
  if (date) {
    fields.push(
      `<exif:DateTimeOriginal>${date}</exif:DateTimeOriginal>`,
      `<photoshop:DateCreated>${date}</photoshop:DateCreated>`,
    );
  }

  const { latitude, longitude } = exif ?? {};
  if (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  ) {
    fields.push(
      '<exif:GPSVersionID>2.3.0.0</exif:GPSVersionID>',
      `<exif:GPSLatitude>${coordinate(latitude, 'N', 'S')}</exif:GPSLatitude>`,
      `<exif:GPSLongitude>${coordinate(longitude, 'E', 'W')}</exif:GPSLongitude>`,
    );
  }

  const orientation = Number(exif?.orientation);
  if (options.orientation && Number.isSafeInteger(orientation) && orientation >= 1 && orientation <= 8) {
    fields.push(`<tiff:Orientation>${orientation}</tiff:Orientation>`);
  }

  if (exif?.isRejected) {
    fields.push('<xmp:Rating>-1</xmp:Rating>');
  } else if (
    typeof exif?.rating === 'number' &&
    Number.isSafeInteger(exif.rating) &&
    exif.rating >= 0 &&
    exif.rating <= 5
  ) {
    fields.push(`<xmp:Rating>${exif.rating}</xmp:Rating>`);
  }

  const description = exif?.description?.trim();
  if (description) {
    fields.push(
      `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${text(description)}</rdf:li></rdf:Alt></dc:description>`,
    );
  }

  const tags = [...new Set((details.tags ?? []).map((tag) => tag.value).filter(Boolean))];
  if (tags.length > 0) {
    const leaves = [...new Set(tags.map((value) => value.split('/').at(-1)!).filter(Boolean))];
    fields.push(
      `<dc:subject>${bag('Bag', leaves)}</dc:subject>`,
      `<lr:hierarchicalSubject>${bag(
        'Bag',
        tags.map((value) => value.replaceAll('/', '|')),
      )}</lr:hierarchicalSubject>`,
      `<digiKam:TagsList>${bag('Seq', tags)}</digiKam:TagsList>`,
    );
  }

  // the people the viewer has named and not hidden, as the asset response names them
  const people = [
    ...new Set((details.people ?? []).filter((person) => !person.isHidden).map((person) => person.name.trim())),
  ].filter(Boolean);
  if (people.length > 0) {
    fields.push(`<Iptc4xmpExt:PersonInImage>${bag('Bag', people)}</Iptc4xmpExt:PersonInImage>`);
  }

  return [
    `<?xpacket begin="${BOM}" id="W5M0MpCehiHzreSzNTczkc9d"?>`,
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Frameleaf">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    '    xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    '    xmlns:exif="http://ns.adobe.com/exif/1.0/"',
    '    xmlns:tiff="http://ns.adobe.com/tiff/1.0/"',
    '    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"',
    '    xmlns:lr="http://ns.adobe.com/lightroom/1.0/"',
    '    xmlns:digiKam="http://www.digikam.org/ns/1.0/"',
    '    xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">',
    ...fields.map((field) => `   ${field}`),
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
    '',
  ].join('\n');
};
