import {
  ICloudRecord,
  parseICloudAlbum,
  resourceFingerprint,
  resourcesForICloudAsset,
  sanitizeICloudFields,
} from 'src/utils/icloud-records.js';

// Redacted shapes from rclone v1.75.1 photos_test.go TestBuildPhotos/TestGetAlbums.
const field = (value: unknown) => ({ value });
const resource = (size: number, fileChecksum: string) =>
  field({ size, fileChecksum, downloadURL: 'https://asset.icloud-content.com/ephemeral?token=private' });
const master: ICloudRecord = {
  recordName: 'master-123',
  recordType: 'CPLMaster',
  recordChangeTag: 'master-revision-1',
  fields: {
    filenameEnc: { value: Buffer.from('IMG_0001.HEIC').toString('base64'), type: 'ENCRYPTED_BYTES' },
    itemType: field('public.heic'),
    resOriginalRes: resource(1024, 'original-sha'),
    resOriginalVidComplRes: resource(2048, 'motion-sha'),
    resOriginalAltRes: resource(4096, 'raw-sha'),
    resOriginalAltFileType: field('com.adobe.raw-image'),
  },
};
const asset: ICloudRecord = {
  recordName: 'asset-123',
  recordType: 'CPLAsset',
  recordChangeTag: 'asset-revision-1',
  fields: {
    masterRef: field({ recordName: 'master-123' }),
    assetDate: field(1_700_000_000_000),
    addedDate: field(1_700_000_001_000),
    isFavorite: field(1),
    isHidden: field(true),
    adjustmentType: field('com.apple.photo'),
    resJPEGFullRes: resource(512, 'edited-sha'),
    resJPEGFullFileType: field('public.jpeg'),
    resVidFullRes: resource(1536, 'edited-video-sha'),
    resVidFullFileType: field('public.mpeg-4'),
  },
};

describe('iCloud raw record normalization', () => {
  it('preserves original, motion, RAW and both render identities without source URLs', () => {
    const resources = resourcesForICloudAsset(asset, master);
    expect(resources.map(({ role }) => role)).toEqual(['original', 'motion', 'raw', 'edited-image', 'edited-video']);
    expect(resources.map(({ recordId }) => recordId)).toEqual([
      'master-123',
      'master-123',
      'master-123',
      'asset-123',
      'asset-123',
    ]);
    for (const item of resources) {
      expect(item.sourceAssetId).toBe('asset-123');
      expect(item.source).toMatchObject({
        sourceAssetId: 'asset-123',
        sourceMasterId: 'master-123',
        assetRecordChangeTag: 'asset-revision-1',
        masterRecordChangeTag: 'master-revision-1',
        fileCreatedAt: '2023-11-14T22:13:20.000Z',
        isFavorite: true,
        isHidden: true,
      });
      expect(JSON.stringify(item.source)).not.toContain('https://');
      expect(JSON.stringify(item.source)).not.toContain('private');
    }
    expect(resources.map(({ source }) => source.type)).toEqual(['IMAGE', 'VIDEO', 'IMAGE', 'IMAGE', 'VIDEO']);
    expect(resources.map(({ source }) => source.originalFileName)).toEqual([
      'IMG_0001.HEIC',
      'IMG_0001.MOV',
      'IMG_0001.dng',
      'IMG_0001-edited.jpg',
      'IMG_0001-edited.mp4',
    ]);
    expect(resources[0].expectedSize).toBe(1024);
  });

  it('keeps two assets and their edits distinct even when master and bytes match', () => {
    const sibling = { ...asset, recordName: 'asset-456', recordChangeTag: 'asset-revision-2' };
    const first = resourcesForICloudAsset(asset, master);
    const second = resourcesForICloudAsset(sibling, master);
    expect(first[0].fingerprint).toBe(second[0].fingerprint);
    expect(first[0].sourceAssetId).not.toBe(second[0].sourceAssetId);
    expect(first[3].fingerprint).toBe(second[3].fingerprint);
    expect(first[3].recordId).not.toBe(second[3].recordId);
    expect(second[3].source.assetRecordChangeTag).toBe('asset-revision-2');
  });

  it('defers missing/mismatched masters to the caller database join but keeps known renders', () => {
    expect(resourcesForICloudAsset(asset).map(({ role }) => role)).toEqual(['edited-image', 'edited-video']);
    expect(resourcesForICloudAsset(asset, { ...master, recordName: 'another-master' })).toHaveLength(2);
    expect(resourcesForICloudAsset(asset, master)).toHaveLength(5);
    expect(resourcesForICloudAsset(master)).toEqual([]);
    expect(resourcesForICloudAsset({ ...asset, deleted: true }, master)).toEqual([]);
    expect(resourcesForICloudAsset({ ...asset, fields: { ...asset.fields, isDeleted: field(1) } }, master)).toEqual([]);
  });

  it('retains resource work after signed URL sanitation, rejects invalid size, and does not invent missing metadata', () => {
    const sanitizedMaster = { ...master, fields: sanitizeICloudFields(master.fields) };
    expect(resourcesForICloudAsset(asset, sanitizedMaster)[0].fingerprint).toBe(
      resourcesForICloudAsset(asset, master)[0].fingerprint,
    );
    const minimal: ICloudRecord = {
      recordName: 'asset-minimal',
      recordType: 'CPLAsset',
      fields: { adjustmentType: field('com.apple.photo'), resJPEGFullRes: resource(4, 'sha') },
    };
    const item = resourcesForICloudAsset(minimal)[0];
    expect(item.source).not.toHaveProperty('fileCreatedAt');
    expect(item.source).not.toHaveProperty('originalFileName');
    expect(item.source).not.toHaveProperty('caption');
    expect(
      resourcesForICloudAsset({ ...minimal, fields: { ...minimal.fields, resJPEGFullRes: resource(-1, 'sha') } }),
    ).toEqual([]);
    expect(
      resourcesForICloudAsset({
        ...minimal,
        fields: { ...minimal.fields, adjustmentType: field('com.apple.video.slomo') },
      }),
    ).toEqual([]);
  });

  it('strips nested credentials and URL values without losing source references or revisions', () => {
    expect(
      sanitizeICloudFields({
        recordName: 'source-id',
        recordChangeTag: 'revision-1',
        masterRef: field({ recordName: 'master-id' }),
        payload: [{ token: 'secret', fields: { Cookie: 'private', url: 'private', ordinary: 'https://private.test' } }],
        password: 'private',
      }),
    ).toEqual({
      recordName: 'source-id',
      recordChangeTag: 'revision-1',
      masterRef: field({ recordName: 'master-id' }),
      payload: [{ fields: {} }],
    });
  });

  it('matches the Go canonical fixture across JSONB key reordering, nested URL refresh and stable revision changes', () => {
    const descriptor = {
      size: 3,
      nested: { z: 2, a: '<&>\u{2028}', 2: 'two', 10: 'ten', downloadURL: 'old', accessToken: 'secret' },
      fileChecksum: 'abc',
      downloadURL: 'old',
      expiresAt: 100,
      password: 'private',
      cookies: 'private',
      arbitrary: 'https://signed-url.test/private',
    };
    const expected = '8839c995f94ca1d27ae4346d4d5ceb1b4bb2e750637b61864ebc78632f5c7b11';
    expect(resourceFingerprint(descriptor)).toBe(expected);
    expect(resourceFingerprint(sanitizeICloudFields(descriptor))).toBe(expected);
    expect(
      resourceFingerprint({
        fileChecksum: 'abc',
        nested: { 10: 'ten', 2: 'two', a: '<&>\u{2028}', z: 2, downloadURL: 'new' },
        size: 3,
      }),
    ).toBe(expected);
    expect(resourceFingerprint({ ...descriptor, fileChecksum: 'changed' })).not.toBe(expected);
    expect(resourceFingerprint({ ...descriptor, revision: '2' })).not.toBe(expected);
  });

  it('preserves albums with equal names, parent IDs, folders and deleted flags and skips smart pseudo albums', () => {
    const album: ICloudRecord = {
      recordName: 'album-1',
      recordType: 'CPLAlbum',
      recordChangeTag: 'album-revision-1',
      fields: { albumNameEnc: field(Buffer.from('Trip').toString('base64')), parentId: field('folder-1') },
    };
    expect(parseICloudAlbum(album)).toMatchObject({
      sourceId: 'album-1',
      parentSourceId: 'folder-1',
      name: 'Trip',
      deleted: false,
    });
    expect(parseICloudAlbum({ ...album, recordName: 'album-2' })).toMatchObject({ sourceId: 'album-2', name: 'Trip' });
    expect(
      parseICloudAlbum({ ...album, fields: { ...album.fields, albumType: field(3), isDeleted: field(1) } }),
    ).toMatchObject({ deleted: true, source: { isFolder: true } });
    expect(parseICloudAlbum({ ...album, fields: { isDeleted: field(true) } })).toMatchObject({
      sourceId: 'album-1',
      name: '',
      deleted: true,
    });
    expect(parseICloudAlbum({ ...album, deleted: true, fields: {} })).toMatchObject({
      sourceId: 'album-1',
      deleted: true,
    });
    expect(parseICloudAlbum({ ...album, recordType: 'SmartAlbum' })).toBeUndefined();
    expect(parseICloudAlbum({ ...album, recordName: '----Root-Folder----' })).toBeUndefined();
    expect(parseICloudAlbum({ ...album, fields: { albumNameEnc: field('not base64!') } })).toBeUndefined();
    expect(parseICloudAlbum({ ...album, fields: { albumNameEnc: { type: 'STRING', value: 'Café' } } })?.name).toBe(
      'Café',
    );
  });
});
