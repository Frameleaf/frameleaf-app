import { describe, expect, it } from 'vitest';
import fixture from 'src/library-import/fixtures/photoprism/261029-metadata.json' with { type: 'json' };
import { normalizePhotoprismAlbum, normalizePhotoprismPhoto } from 'src/library-import/photoprism-metadata.js';

const photo = {
  id: 2n,
  photo_uid: 'photo-fixture',
  created_by: '',
  photo_title: 'Manual fixture title',
  title_src: 'manual',
  photo_caption: 'Manual fixture caption',
  caption_src: 'manual',
  taken_at: '2020-06-10 18:30:00+00:00',
  taken_at_local: '2020-06-10 12:30:00+00:00',
  taken_src: 'manual',
  time_zone: 'America/Edmonton',
  photo_lat: 53.5461,
  photo_lng: -113.4938,
  place_src: 'manual',
  photo_private: 1n,
  photo_favorite: 1n,
  photo_quality: 5n,
  photo_stack: 0n,
  deleted_at: null,
};
const details = { photo_id: 2n, keywords: 'family, summer', notes: 'Private fixture note', artist: 'Fixture Artist' };

describe('PhotoPrism source photo normalization', () => {
  it('matches database metadata to the pinned application API after supported manual edits', () => {
    const row = Object.fromEntries(
      Object.entries(fixture.photo).map(([key, value]) => [
        key,
        typeof value === 'number' && !['photo_lat', 'photo_lng'].includes(key) ? BigInt(value) : value,
      ]),
    );
    const result = normalizePhotoprismPhoto(row, { ...fixture.details, photo_id: BigInt(fixture.details.photo_id) });
    expect(result.id).toBe(fixture.expected.UID);
    expect(result.metadata.title).toBe(fixture.expected.Title);
    expect(result.metadata.description).toBe(fixture.expected.Caption);
    expect(new Date(result.metadata.takenAt!).toISOString()).toBe(new Date(fixture.expected.TakenAt).toISOString());
    expect(result.localDateTime).toBe(fixture.expected.TakenAtLocal.replace('Z', ''));
    expect(result.metadata.timeZone).toBe(fixture.expected.TimeZone);
    expect(result.metadata.latitude).toBe(fixture.expected.Lat);
    expect(result.metadata.longitude).toBe(fixture.expected.Lng);
    expect(result.state.private).toBe(fixture.expected.Private);
    expect(result.metadata.favorite).toBe(fixture.expected.Favorite);
    expect(result.metadata.tags).toEqual(fixture.expected.Details.Keywords.split(', '));
    expect(result.archive.details?.notes).toBe(fixture.expected.Details.Notes);
    expect(result.archive.details?.artist).toBe(fixture.expected.Details.Artist);
  });
  it('preserves manual database values and their provenance without inventing an owner or rating', () => {
    const result = normalizePhotoprismPhoto(photo, details);
    expect(result.id).toBe('photo-fixture');
    expect(result.createdBy).toBeUndefined();
    expect(result.metadata).toEqual({
      title: 'Manual fixture title',
      description: 'Manual fixture caption',
      takenAt: '2020-06-10T18:30:00+00:00',
      timeZone: 'America/Edmonton',
      latitude: 53.5461,
      longitude: -113.4938,
      favorite: true,
      tags: ['family', 'summer'],
    });
    expect(result.localDateTime).toBe('2020-06-10T12:30:00');
    expect(result.provenance).toEqual({
      title: 'manual',
      description: 'manual',
      takenAt: 'manual',
      location: 'manual',
      timeZone: 'America/Edmonton',
    });
    expect(result.state).toEqual({ private: true, archived: false, removed: false });
    expect(result.archive.details).toEqual(details);
    expect(result.metadata).not.toHaveProperty('rating');
  });
  it('distinguishes PhotoPrism archive from removed state while retaining private state', () => {
    const archived = normalizePhotoprismPhoto({ ...photo, deleted_at: '2026-11-01 12:00:00+00:00' }, details);
    const removed = normalizePhotoprismPhoto(
      { ...photo, deleted_at: '2026-11-01 12:00:00+00:00', photo_quality: -1n },
      details,
    );
    expect(archived.state).toEqual({ private: true, archived: true, removed: false });
    expect(removed.state).toEqual({ private: true, archived: false, removed: true });
  });
  it.each([null, '0001-01-01 00:00:00+00:00'])(
    'retains unknown capture timestamps for review rather than inventing a date case %#',
    (value) => {
      const result = normalizePhotoprismPhoto({ ...photo, taken_at: value, taken_at_local: value }, details);
      expect(result.metadata.takenAt).toBeUndefined();
      expect(result.localDateTime).toBeUndefined();
      expect(result.review).toEqual(['CAPTURE_TIME_UNKNOWN']);
    },
  );
  it.each([
    ['UTC+5', 'Etc/GMT-5', '23'],
    ['UTC-7', 'Etc/GMT+7', '11'],
  ])('preserves source fixed-offset zone %s as equivalent %s', (zone, expectedZone, expectedHour) => {
    const result = normalizePhotoprismPhoto({ ...photo, time_zone: zone }, details);
    expect(result.metadata.timeZone).toBe(expectedZone);
    expect(result.provenance.timeZone).toBe(zone);
    expect(result.archive.photo.time_zone).toBe(zone);
    expect(
      new Intl.DateTimeFormat('en-GB', { timeZone: expectedZone, hour: '2-digit', hourCycle: 'h23' }).format(
        new Date(result.metadata.takenAt!),
      ),
    ).toBe(expectedHour);
  });
  it('does not turn an unresolved source Local zone into the destination machine zone', () => {
    const result = normalizePhotoprismPhoto({ ...photo, time_zone: 'Local', photo_lat: 0, photo_lng: 0 }, details);
    expect(result.metadata.timeZone).toBeUndefined();
    expect(result.metadata.latitude).toBeUndefined();
    expect(result.metadata.longitude).toBeUndefined();
    expect(result.review).toEqual(['LOCAL_TIME_ZONE_UNRESOLVED']);
    expect(result.archive.photo.time_zone).toBe('Local');
  });
  it.each([
    { photo_private: null },
    { photo_private: 2n },
    { photo_lng: 181 },
    { taken_at: '2020-06-10 18:30:00' },
    { taken_at: '2020-02-31 18:30:00+00:00' },
    { time_zone: 'Invented/Zone' },
    { deleted_at: 'invalid' },
    { photo_uid: '' },
  ])('refuses malformed or ambiguous fields case %#', (change) => {
    expect(() => normalizePhotoprismPhoto({ ...photo, ...change }, details)).toThrow('PHOTOPRISM_METADATA_INVALID');
  });
  it('refuses mismatched details rather than transferring another photo metadata', () => {
    expect(() => normalizePhotoprismPhoto(photo, { ...details, photo_id: 3n })).toThrow('PHOTOPRISM_DETAILS_MISMATCH');
  });
  it('does not mutate source records needed by the protected archive', () => {
    normalizePhotoprismPhoto(photo, details);
    expect(photo.taken_at).toBe('2020-06-10 18:30:00+00:00');
    expect(details.keywords).toBe('family, summer');
  });
});

const album = {
  album_uid: 'album-fixture',
  created_by: 'source-owner',
  album_title: 'Restricted album',
  album_type: 'album',
  album_filter: '',
  album_private: 1n,
  album_favorite: 1n,
  deleted_at: null,
};
const membership = { album_uid: 'album-fixture', photo_uid: 'photo-fixture', order: 0n, hidden: 0n, missing: 0n };
describe('PhotoPrism album normalization', () => {
  it('matches the restricted album and membership generated by the pinned source application', () => {
    const row = Object.fromEntries(
      Object.entries(fixture.album).map(([key, value]) => [key, typeof value === 'number' ? BigInt(value) : value]),
    );
    const relationships = fixture.memberships.map((membership) =>
      Object.fromEntries(
        Object.entries(membership).map(([key, value]) => [key, typeof value === 'number' ? BigInt(value) : value]),
      ),
    );
    const result = normalizePhotoprismAlbum(row, relationships);
    expect(result.id).toBe(fixture.expectedAlbum.UID);
    expect(result.name).toBe(fixture.expectedAlbum.Title);
    expect(result.private).toBe(fixture.expectedAlbum.Private);
    expect(result.favorite).toBe(fixture.expectedAlbum.Favorite);
    expect(result.createdBy).toBe(fixture.expectedAlbum.CreatedBy);
    expect(result.archive.album.album_description).toBe(fixture.expectedAlbum.Description);
    expect(result.assetIds).toEqual([fixture.expected.UID]);
  });
  it('retains membership order and restrictions without reviving hidden or missing memberships', () => {
    const result = normalizePhotoprismAlbum(album, [
      { ...membership, photo_uid: 'last', order: 9_007_199_254_740_993n },
      { ...membership, photo_uid: 'hidden', hidden: 1n },
      { ...membership, photo_uid: 'missing', missing: 1n },
      membership,
    ]);
    expect(result.assetIds).toEqual(['photo-fixture', 'last']);
    expect(result.memberships).toHaveLength(4);
    expect(result.memberships[0].order).toBe('9007199254740993');
    expect(result.private).toBe(true);
    expect(result.createdBy).toBe('source-owner');
    expect(result.review).toEqual([]);
  });
  it.each([{ album_type: 'folder' }, { album_type: 'month' }, { album_filter: 'label:family' }])(
    'requires explicit materialization for dynamic source albums case %#',
    (change) => {
      expect(normalizePhotoprismAlbum({ ...album, ...change }, []).review).toEqual(['ALBUM_REQUIRES_MATERIALIZATION']);
    },
  );
  it('refuses relationships to a different album and duplicate relationships', () => {
    expect(() => normalizePhotoprismAlbum(album, [{ ...membership, album_uid: 'other' }])).toThrow(
      'PHOTOPRISM_ALBUM_MEMBERSHIP_INVALID',
    );
    expect(() => normalizePhotoprismAlbum(album, [membership, membership])).toThrow(
      'PHOTOPRISM_ALBUM_MEMBERSHIP_INVALID',
    );
  });
  it('does not infer an owner for global folder albums', () => {
    expect(normalizePhotoprismAlbum({ ...album, created_by: '' }, []).createdBy).toBeUndefined();
  });
});
