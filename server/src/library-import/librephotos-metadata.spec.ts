import { describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/librephotos/1.5.1-content.json' with { type: 'json' };
import { normalizeLibrephotosPhoto } from 'src/library-import/librephotos-metadata.js';
import { LibrephotosRow } from 'src/library-import/librephotos.js';

// The reader preserves SQLite integers as bigint; JSON fixtures retain their source numeric values.
const sourceRow = (row: object): LibrephotosRow =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : value,
    ]),
  );
const context = (name: keyof typeof content.expected.photos = 'alice') => {
  const id = content.expected.photos[name].replaceAll('-', '');
  const photo = content.rows.api_photo.find((row) => row.id === id)!;
  const tagIds = new Set(content.rows.api_tag_photos.filter((row) => row.photo_id === id).map((row) => row.tag_id));
  return {
    photo: sourceRow(photo),
    owner: sourceRow(content.rows.api_user.find((row) => row.id === photo.owner_id)!),
    metadata: sourceRow(content.rows.api_photometadata.find((row) => row.photo_id === id)!),
    caption: sourceRow(content.rows.api_photo_caption.find((row) => row.photo_id === id)!),
    tags: content.rows.api_tag.filter((row) => tagIds.has(row.id)).map((row) => sourceRow(row)),
  };
};

describe('LibrePhotos authoritative photo metadata', () => {
  it('preserves actual source manual metadata, explicit owner and original relationships', () => {
    const input = context();
    const photo = normalizeLibrephotosPhoto(input);
    expect(photo.id).toBe(input.photo.id);
    expect(photo.ownerId).toBe(String(content.expected.actors.alice));
    expect(photo.mainFileId).toBe(input.photo.main_file_id);
    expect(photo.metadata).toMatchObject({
      title: content.expected.sourceApi.ownerTitle,
      description: content.expected.sourceApi.ownerCaption,
      tags: ['family', 'summer'],
      rating: 4,
      favorite: true,
      latitude: 53.5461,
      longitude: -113.4938,
    });
    expect(photo.metadata.tags).not.toContain('embedded');
    expect(photo.localDateTime).toBe('2020-06-10T12:30:00');
    expect(photo.metadata.takenAt).toBe('2020-06-10T18:30:00Z');
  });

  it('keeps source manual dates without inventing an offset or instant', () => {
    const photo = normalizeLibrephotosPhoto(context('bob'));
    expect(photo.localDateTime).toBe('2021-02-04T08:09:10');
    expect(photo.metadata.takenAt).toBeUndefined();
    expect(photo.metadata.timeZone).toBeUndefined();
    expect(photo.provenance.captureTime).toBe('manual');
    expect(photo.review).toContain('CAPTURE_OFFSET_UNKNOWN');
  });

  it.each([
    [330n, '2020-06-10T07:00:00Z'],
    [-210n, '2020-06-10T16:00:00Z'],
    [0n, '2020-06-10T12:30:00Z'],
  ])('converts minute offset %s without rounding it to hours', (offset, expected) => {
    const input = context();
    input.photo.exif_timestamp_offset = offset;
    expect(normalizeLibrephotosPhoto(input).metadata.takenAt).toBe(expected);
  });

  it('preserves submillisecond capture precision and date rollover', () => {
    const input = context();
    input.photo.exif_timestamp = '2020-01-01 00:15:00.123456';
    input.photo.exif_timestamp_offset = 60n;
    expect(normalizeLibrephotosPhoto(input).metadata.takenAt).toBe('2019-12-31T23:15:00.123456Z');
  });

  it('gives manual timestamp precedence over stale capture-rule values without assuming UTC', () => {
    const input = context();
    input.photo.timestamp = '2022-03-04 05:06:07';
    const photo = normalizeLibrephotosPhoto(input);
    expect(photo.localDateTime).toBe('2022-03-04T05:06:07');
    expect(photo.metadata.takenAt).toBeUndefined();
    expect(photo.review).toContain('MANUAL_CAPTURE_RULE_MISMATCH');
  });

  it('retains unknown dates and manually cleared captions, tags, ratings and locations', () => {
    const input = context();
    input.photo.exif_timestamp = null;
    input.photo.exif_timestamp_offset = null;
    input.photo.exif_gps_lat = null;
    input.photo.exif_gps_lon = null;
    input.photo.rating = 0n;
    input.metadata.title = '';
    input.metadata.edited_keywords = '[]';
    input.caption.captions_json = '{"user_caption":"","imported_description":"stale text"}';
    input.tags = [];
    const photo = normalizeLibrephotosPhoto(input);
    expect(photo.metadata).toMatchObject({ title: '', description: '', tags: [], rating: 0, favorite: false });
    expect(photo.metadata.latitude).toBeUndefined();
    expect(photo.metadata.longitude).toBeUndefined();
    expect(photo.localDateTime).toBeUndefined();
    expect(photo.metadata.takenAt).toBeUndefined();
    expect(photo.review).toContain('CAPTURE_TIME_UNKNOWN');
  });

  it('uses current tag relationships after individual tag removal and retains tags added by hand', () => {
    const input = context();
    input.tags = [{ id: 500n, owner_id: input.photo.owner_id, name: 'by hand' }];
    expect(normalizeLibrephotosPhoto(input).metadata.tags).toEqual(['by hand']);
  });

  it('keeps independent private states and never turns public flags into destination permission grants', () => {
    for (const [name, flag] of [
      ['hidden', 'hidden'],
      ['archived', 'archived'],
      ['trash', 'inTrash'],
    ] as const) {
      expect(normalizeLibrephotosPhoto(context(name)).state[flag]).toBe(true);
    }
    const input = context();
    input.photo.public = 1n;
    input.photo.hidden = 1n;
    input.photo.archived = 1n;
    input.photo.in_trashcan = 1n;
    expect(normalizeLibrephotosPhoto(input).state).toMatchObject({
      public: true,
      hidden: true,
      archived: true,
      inTrash: true,
      removed: false,
    });
  });

  it('honors the owner favourite threshold separately from embedded file rating', () => {
    const input = context();
    input.owner.favorite_min_rating = 5n;
    input.owner.rating_mode = 'stars';
    expect(normalizeLibrephotosPhoto(input).metadata).toMatchObject({ rating: 4, favorite: false });
    input.owner.favorite_min_rating = 4n;
    expect(normalizeLibrephotosPhoto(input).metadata.favorite).toBe(true);
    expect(normalizeLibrephotosPhoto(input).provenance.ratingMode).toBe('stars');
  });

  it.each(['owner', 'metadata', 'caption', 'tag'] as const)('refuses mismatched %s context', (kind) => {
    const input = context();
    const corrupt = {
      owner: () => {
        input.owner.id = 999n;
      },
      metadata: () => {
        input.metadata.photo_id = 'unrelated-photo';
      },
      caption: () => {
        input.caption.photo_id = 'unrelated-photo';
      },
      tag: () => {
        input.tags[0].owner_id = 999n;
      },
    };
    corrupt[kind]();
    expect(() => normalizeLibrephotosPhoto(input)).toThrow('LIBREPHOTOS_METADATA_RELATIONSHIP_INVALID');
  });

  it.each([
    ['hidden', 2n],
    ['rating', 6n],
    ['exif_gps_lat', 91],
    ['exif_gps_lon', null],
    ['exif_timestamp', '2020-02-30 12:00:00'],
    ['exif_timestamp', '2020-01-01 12:00:00+03:00'],
    ['exif_timestamp_offset', 841n],
  ])('refuses invalid %s value %s', (field, value) => {
    const input = context();
    input.photo[field] = value;
    expect(() => normalizeLibrephotosPhoto(input)).toThrow('LIBREPHOTOS_METADATA_INVALID');
  });

  it('does not replace missing optional metadata with stale embedded descriptions', () => {
    const { metadata: _metadata, caption: _caption, ...input } = context();
    const photo = normalizeLibrephotosPhoto(input);
    expect(photo.metadata.title).toBeUndefined();
    expect(photo.metadata.description).toBeUndefined();
    expect(photo.review).toContain('PHOTO_METADATA_MISSING');
  });

  it('preserves a real zero-coordinate location and exact large owner identity', () => {
    const input = context();
    input.photo.exif_gps_lat = 0;
    input.photo.exif_gps_lon = 0;
    input.photo.owner_id = 9_007_199_254_740_993n;
    input.owner.id = input.photo.owner_id;
    for (const tag of input.tags) tag.owner_id = input.photo.owner_id;
    expect(normalizeLibrephotosPhoto(input)).toMatchObject({
      ownerId: '9007199254740993',
      metadata: { latitude: 0, longitude: 0 },
    });
  });

  it('refuses duplicated tag relationships and malformed captions', () => {
    const input = context();
    input.tags.push(input.tags[0]);
    expect(() => normalizeLibrephotosPhoto(input)).toThrow('LIBREPHOTOS_METADATA_RELATIONSHIP_INVALID');
    input.tags.pop();
    input.caption.captions_json = 'private malformed text';
    expect(() => normalizeLibrephotosPhoto(input)).toThrow('LIBREPHOTOS_METADATA_INVALID');
  });

  it('refuses capture instants outside the supported ISO year range', () => {
    const input = context();
    input.photo.exif_timestamp = '9999-12-31 23:59:59';
    input.photo.exif_timestamp_offset = -60n;
    expect(() => normalizeLibrephotosPhoto(input)).toThrow('LIBREPHOTOS_METADATA_INVALID');
  });

  it('only returns normalized fields without copying credential or embedding context', () => {
    const input = context();
    input.owner.password = 'private-account-password';
    input.photo.clip_embeddings = '[123]';
    const result = normalizeLibrephotosPhoto(input);
    expect(JSON.stringify(result)).not.toContain('private-account-password');
    expect(result).not.toHaveProperty('clip_embeddings');
    expect(result).not.toHaveProperty('owner');
  });
});
