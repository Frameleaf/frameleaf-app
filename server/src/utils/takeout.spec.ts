import { MediaOperationStatus } from 'src/enum.js';
import {
  TAKEOUT_DEFAULT_OPTIONS,
  TakeoutEntryRejected,
  createTakeoutSidecarIndex,
  isTakeoutAlbumSelected,
  isTakeoutLockedFolder,
  isTakeoutYearFolder,
  parseTakeoutOptions,
  parseTakeoutSidecar,
  takeoutCreatedPatch,
  takeoutEntryPath,
  takeoutLivePhotoKey,
  takeoutMatchedPatch,
  takeoutScannedItem,
  takeoutStableId,
  takeoutState,
} from 'src/utils/takeout.js';

const metadata = { title: 'photo.jpg', photoTakenTime: { timestamp: '1234567890' } };

describe('takeoutEntryPath', () => {
  it.each(['Google Photos', 'Google Fotos', 'Google フォト', 'Google 相册'])(
    'recognizes the localized photo folder %s',
    (root) => {
      expect(takeoutEntryPath(`Takeout/${root}/Wedding/photo.jpg`)).toEqual({
        relativePath: 'Wedding/photo.jpg',
        folder: 'Wedding',
        name: 'photo.jpg',
      });
    },
  );

  it('reads an extracted export that starts at the photo folder', () => {
    expect(takeoutEntryPath('Google Photos/photo.jpg')).toEqual({
      relativePath: 'photo.jpg',
      folder: '',
      name: 'photo.jpg',
    });
  });

  it('ignores other Google products and folders', () => {
    expect(takeoutEntryPath('Takeout/Mail/photo.jpg')).toBeUndefined();
    expect(takeoutEntryPath('Takeout/Google Photos/Trip/')).toBeUndefined();
  });

  it.each(['../../a.jpg', '/a.jpg', 'C:/a.jpg', 'Photos/../a.jpg', String.raw`Photos\a.jpg`, 'bad\0.jpg', ''])(
    'refuses the unsafe archive path %s',
    (entry) => {
      expect(() => takeoutEntryPath(entry)).toThrow(TakeoutEntryRejected);
    },
  );
});

describe('folders', () => {
  it.each(['Photos from 2020', 'Fotos von 2020', '2020年', 'Trip/Photos from 1999'])(
    'treats %s as a year folder',
    (folder) => {
      expect(isTakeoutYearFolder(folder)).toBe(true);
    },
  );

  it('does not treat an album named with a year as a year folder', () => {
    expect(isTakeoutYearFolder('Paris 2020')).toBe(false);
  });

  it.each(['Locked Folder', 'Gesperrter Ordner'])('recognizes the Locked Folder %s', (folder) => {
    expect(isTakeoutLockedFolder(folder)).toBe(true);
  });

  it('recreates albums but never year folders or the Locked Folder by default', () => {
    const options = parseTakeoutOptions({});
    expect(isTakeoutAlbumSelected('Wedding', options)).toBe(true);
    expect(isTakeoutAlbumSelected('Photos from 2020', options)).toBe(false);
    expect(isTakeoutAlbumSelected('Locked Folder', options)).toBe(false);
    expect(isTakeoutAlbumSelected('', options)).toBe(false);
  });

  it('follows the owner’s album selection and the album switch', () => {
    expect(isTakeoutAlbumSelected('Photos from 2020', { albums: true, selectedAlbums: ['Photos from 2020'] })).toBe(
      true,
    );
    expect(isTakeoutAlbumSelected('Wedding', { albums: true, selectedAlbums: [] })).toBe(false);
    expect(isTakeoutAlbumSelected('Wedding', { albums: false })).toBe(false);
  });
});

describe('parseTakeoutSidecar', () => {
  it('keeps dates, flags, descriptions and the EXIF location', () => {
    expect(
      parseTakeoutSidecar({
        ...metadata,
        description: 'A wedding',
        favorited: true,
        archived: false,
        geoData: { latitude: 0, longitude: 0 },
        geoDataExif: { latitude: 51.2, longitude: -114.2 },
      }),
    ).toEqual({
      title: 'photo.jpg',
      takenAt: '2009-02-13T23:31:30.000Z',
      description: 'A wedding',
      favorite: true,
      archived: false,
      latitude: 51.2,
      longitude: -114.2,
    });
  });

  it('reads the Locked Folder and trash flags only when they are true', () => {
    expect(parseTakeoutSidecar({ ...metadata, inLockedFolder: true, trashed: true })).toMatchObject({
      locked: true,
      trashed: true,
    });
    expect(parseTakeoutSidecar({ ...metadata, inLockedFolder: 'yes', trashed: false })).not.toHaveProperty('locked');
  });

  it('drops an empty description rather than clearing one', () => {
    expect(parseTakeoutSidecar({ ...metadata, description: '' })).not.toHaveProperty('description');
  });

  it.each(['', null, undefined, 'bad', Infinity])(
    'does not turn the malformed timestamp %s into the epoch',
    (timestamp) => {
      expect(parseTakeoutSidecar({ ...metadata, photoTakenTime: { timestamp } })?.takenAt).toBeUndefined();
    },
  );

  it('ignores album and comment JSON without photo timestamps', () => {
    expect(parseTakeoutSidecar({ title: 'Album' })).toBeUndefined();
    expect(parseTakeoutSidecar([metadata])).toBeUndefined();
  });
});

describe('createTakeoutSidecarIndex', () => {
  it.each([
    'photo.jpg.json',
    'photo.jpg.supplemental-metadata.json',
    'photo.jpg.supplemental-meta.json',
    'photo.jpg.suppl.json',
    'photo.json',
  ])('matches the sidecar name %s', (name) => {
    const match = createTakeoutSidecarIndex([{ id: '1', name, metadata: { title: 'photo.jpg' } }]);
    expect(match('photo.jpg').map((item) => item.id)).toEqual(['1']);
  });

  it('matches duplicate numbering and truncated names through the embedded title', () => {
    const match = createTakeoutSidecarIndex([
      { id: 'duplicate', name: 'photo.jpg(1).json', metadata: { title: 'photo(1).jpg' } },
      { id: 'long', name: 'a-very-long.supplemental.json', metadata: { title: 'a-very-long-photo-name.jpg' } },
    ]);
    expect(match('photo(1).jpg')[0].id).toBe('duplicate');
    expect(match('a-very-long-photo-name.jpg')[0].id).toBe('long');
  });

  it('matches localized names after Unicode normalization', () => {
    const match = createTakeoutSidecarIndex([
      { id: '1', name: 'Cafe\u{301}.jpg.json', metadata: { title: 'Cafe\u{301}.jpg' } },
    ]);
    expect(match('Caf\u{E9}.jpg').map((item) => item.id)).toEqual(['1']);
  });

  it('reuses an original’s metadata for an edited copy only when the title confirms it', () => {
    const match = createTakeoutSidecarIndex([{ id: '1', name: 'wrong.json', metadata: { title: 'photo.jpg' } }]);
    expect(match('photo-bearbeitet.jpg')[0].id).toBe('1');
    expect(match('other-edited.jpg')).toEqual([]);
  });

  it('collapses identical sidecars from split archives but keeps conflicting ones for review', () => {
    const candidates = [
      { id: '1', name: 'photo.jpg.json', metadata: { title: 'photo.jpg', description: 'one' } },
      { id: '2', name: 'photo.jpg.json', metadata: { title: 'photo.jpg', description: 'one' } },
    ];
    expect(createTakeoutSidecarIndex(candidates)('photo.jpg')).toHaveLength(1);
    expect(
      createTakeoutSidecarIndex([
        ...candidates,
        { id: '3', name: 'photo.jpg.json', metadata: { title: 'photo.jpg', description: 'two' } },
      ])('photo.jpg'),
    ).toHaveLength(2);
  });
});

describe('takeoutScannedItem', () => {
  const candidate = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    path: `Trip/${id}.json`,
    metadata: { title: 'photo.jpg', ...extra },
  });

  it('uses a single sidecar as it is', () => {
    const item = takeoutScannedItem({
      name: 'photo.jpg',
      folder: 'Trip',
      candidates: [candidate('a')],
      invalidSidecar: false,
    });
    expect(item).toEqual({
      state: 'ready',
      metadata: { title: 'photo.jpg' },
      sidecarId: 'a',
      warnings: [],
      locked: false,
    });
  });

  it('holds disagreeing sidecars for review', () => {
    const item = takeoutScannedItem({
      name: 'photo.jpg',
      folder: 'Trip',
      candidates: [candidate('a', { description: 'one' }), candidate('b', { description: 'two' })],
      invalidSidecar: false,
    });
    expect(item).toMatchObject({ state: 'review', sidecarId: null, warnings: ['ambiguous_sidecar'] });
  });

  it('keeps an item locked when any candidate or the folder says Locked Folder', () => {
    expect(
      takeoutScannedItem({
        name: 'photo.jpg',
        folder: 'Trip',
        candidates: [candidate('a'), candidate('b', { locked: true })],
        invalidSidecar: false,
      }).locked,
    ).toBe(true);
    const folderItem = takeoutScannedItem({
      name: 'photo.jpg',
      folder: 'Locked Folder',
      candidates: [],
      invalidSidecar: false,
    });
    expect(folderItem).toMatchObject({ locked: true, warnings: ['no_sidecar', 'locked'] });
  });

  it('skips a photo Google had in the trash', () => {
    expect(
      takeoutScannedItem({
        name: 'photo.jpg',
        folder: '',
        candidates: [candidate('a', { trashed: true })],
        invalidSidecar: true,
      }),
    ).toMatchObject({ state: 'skipped', warnings: ['invalid_sidecar', 'trashed'] });
  });
});

describe('metadata patches', () => {
  const full = {
    title: 'photo.jpg',
    description: 'From Google',
    takenAt: '2020-01-01T00:00:00.000Z',
    latitude: 1,
    longitude: 2,
    favorite: true,
    archived: true,
  };

  it('brings everything the owner chose onto a created asset', () => {
    expect(takeoutCreatedPatch(full, TAKEOUT_DEFAULT_OPTIONS)).toEqual({
      description: 'From Google',
      dateTimeOriginal: '2020-01-01T00:00:00.000Z',
      latitude: 1,
      longitude: 2,
      isFavorite: true,
      archive: true,
    });
    const withoutDates = takeoutCreatedPatch(full, { ...TAKEOUT_DEFAULT_OPTIONS, dates: false, locations: false });
    expect(withoutDates).not.toHaveProperty('dateTimeOriginal');
  });

  it('changes nothing on a matched photo unless asked', () => {
    const existing = { description: null, latitude: null, longitude: null, isFavorite: false, archived: false };
    expect(takeoutMatchedPatch(full, existing, TAKEOUT_DEFAULT_OPTIONS)).toEqual({});
  });

  it('only fills what a matched photo is missing, and never its date', () => {
    const options = { ...TAKEOUT_DEFAULT_OPTIONS, updateMatchedMetadata: true };
    expect(
      takeoutMatchedPatch(
        full,
        { description: 'Edited by hand', latitude: 5, longitude: 6, isFavorite: true, archived: true },
        options,
      ),
    ).toEqual({});
    expect(
      takeoutMatchedPatch(
        full,
        { description: '', latitude: null, longitude: null, isFavorite: false, archived: false },
        options,
      ),
    ).toEqual({ description: 'From Google', latitude: 1, longitude: 2, isFavorite: true, archive: true });
  });
});

describe('takeoutState', () => {
  it('reports the phase when no job is working on it', () => {
    expect(takeoutState('sources')).toBe('sources');
    expect(takeoutState('review', { status: MediaOperationStatus.Completed })).toBe('review');
  });

  it.each([
    [MediaOperationStatus.Queued, 'queued'],
    [MediaOperationStatus.Preparing, 'queued'],
    [MediaOperationStatus.Rendering, 'importing'],
    [MediaOperationStatus.Paused, 'paused'],
    [MediaOperationStatus.Cancelling, 'cancelling'],
    [MediaOperationStatus.Cancelled, 'cancelled'],
    [MediaOperationStatus.Failed, 'failed'],
    [MediaOperationStatus.Completed, 'completed'],
  ])('reads an import job that is %s as %s', (status, state) => {
    expect(takeoutState('importing', { status })).toBe(state);
  });

  it('reads a completed scan as ready for review', () => {
    expect(takeoutState('scanning', { status: MediaOperationStatus.Completed })).toBe('review');
  });
});

describe('parseTakeoutOptions', () => {
  it('falls back to the defaults for anything missing or malformed', () => {
    expect(parseTakeoutOptions({ albums: 'no', dates: false, selectedAlbums: ['Trip', 3] })).toEqual({
      ...TAKEOUT_DEFAULT_OPTIONS,
      dates: false,
      selectedAlbums: ['Trip'],
    });
  });
});

describe('identities', () => {
  it('derives the same id for the same source and entry, and a different one otherwise', () => {
    expect(takeoutStableId('one:photo.jpg')).toBe(takeoutStableId('one:photo.jpg'));
    expect(takeoutStableId('one:photo.jpg')).not.toBe(takeoutStableId('two:photo.jpg'));
    expect(takeoutStableId('one:photo.jpg')).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/,
    );
  });

  it('pairs a Live Photo’s still and motion parts by name', () => {
    expect(takeoutLivePhotoKey('IMG_1.HEIC')).toBe(takeoutLivePhotoKey('IMG_1.MP4'));
    expect(takeoutLivePhotoKey('PXL_1.MP.jpg')).toBe(takeoutLivePhotoKey('PXL_1.mp4'));
  });
});
