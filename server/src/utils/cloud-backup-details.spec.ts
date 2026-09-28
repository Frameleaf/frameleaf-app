import type { CloudBackupAssetDetails } from 'src/utils/cloud-backup.js';
import { EMPTY_DETAILS, detailChanges } from 'src/utils/cloud-backup-details.js';

const face = {
  personId: 'person-1',
  box: [1, 2, 3, 4] as [number, number, number, number],
  imageWidth: 10,
  imageHeight: 10,
  isHidden: false,
};

const backup: CloudBackupAssetDetails = {
  isFavorite: true,
  visibility: 'archive',
  rating: 4,
  description: 'Lake morning',
  dateTimeOriginal: '2026-08-14T09:12:00.000Z',
  timeZone: 'UTC+2',
  latitude: 46.5,
  longitude: 7.9,
  tags: ['Trips', 'Trips/Lake'],
  albums: [
    { id: 'album-1', name: 'Lake house' },
    { id: 'album-2', name: 'Summer' },
  ],
  faces: [face],
  stack: { id: 'stack-1', isPrimary: true },
  edits: [{ action: 'crop', parameters: { x: 0, y: 0, width: 5, height: 5 } }],
};

describe('putting details back (FL-164)', () => {
  it('changes nothing with "Keep current details"', () => {
    expect(detailChanges(EMPTY_DETAILS, backup, 'keep')).toEqual({});
  });

  it('brings every detail to an item that has none, whichever way it is asked', () => {
    const everything = {
      isFavorite: true,
      exif: {
        description: 'Lake morning',
        rating: 4,
        dateTimeOriginal: '2026-08-14T09:12:00.000Z',
        timeZone: 'UTC+2',
        latitude: 46.5,
        longitude: 7.9,
      },
      albums: ['album-1', 'album-2'],
      faces: [face],
      stack: { id: 'stack-1', isPrimary: true },
      edits: backup.edits,
    };
    expect(detailChanges(EMPTY_DETAILS, backup, 'fill')).toEqual({
      ...everything,
      tags: { values: ['Trips', 'Trips/Lake'], exact: false },
    });
    expect(detailChanges(EMPTY_DETAILS, backup, 'replace')).toEqual({
      ...everything,
      visibility: 'archive',
      tags: { values: ['Trips', 'Trips/Lake'], exact: true },
    });
  });

  it('"Fill in missing details" keeps everything already set and only adds', () => {
    const current: CloudBackupAssetDetails = {
      ...EMPTY_DETAILS,
      isFavorite: false,
      visibility: 'timeline',
      rating: 2,
      description: 'Edited later',
      dateTimeOriginal: '2026-08-15T00:00:00.000Z',
      latitude: 1,
      longitude: 2,
      tags: ['Trips'],
      albums: [{ id: 'album-1', name: 'Lake house' }],
      faces: [{ ...face, personId: 'person-2' }],
      stack: { id: 'stack-2', isPrimary: true },
      edits: [{ action: 'rotate', parameters: { angle: 90 } }],
    };
    expect(detailChanges(current, backup, 'fill')).toEqual({
      isFavorite: true,
      tags: { values: ['Trips/Lake'], exact: false },
      albums: ['album-2'],
    });
  });

  it('"Replace current details" puts back what differs, clears a location the backup had none of, and never removes albums or faces', () => {
    const current: CloudBackupAssetDetails = {
      ...backup,
      isFavorite: false,
      visibility: 'timeline',
      rating: null,
      tags: ['Other'],
      albums: [{ id: 'album-3', name: 'Added since' }],
      faces: [{ ...face, personId: 'person-2' }],
      stack: null,
      edits: [],
    };
    expect(detailChanges(current, { ...backup, latitude: null, longitude: null }, 'replace')).toEqual({
      isFavorite: true,
      visibility: 'archive',
      exif: { rating: 4 },
      clearLocation: true,
      tags: { values: ['Trips', 'Trips/Lake'], exact: true },
      albums: ['album-1', 'album-2'],
      stack: { id: 'stack-1', isPrimary: true },
      edits: backup.edits,
    });
    expect(detailChanges(backup, backup, 'replace')).toEqual({});
  });

  it('leaves the hidden half of a Live Photo hidden', () => {
    expect(
      detailChanges({ ...backup, visibility: 'hidden' }, { ...backup, visibility: 'timeline' }, 'replace'),
    ).toEqual({});
  });
});
