import { parseImportManifest } from 'src/library-import/manifest.js';
import { IDENTICAL_MERGED_LOSS, mergeIdenticalOriginals } from 'src/library-import/preparation/prepare.js';

const SAME = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const manifest = () =>
  parseImportManifest({
    format: 'frameleaf-library-import',
    version: 2,
    source: { kind: 'nextcloud', version: '1', identity: 'fixture', revision: 'r1', schemaSha256: SAME },
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: 'r1',
      revisionAfter: 'r1',
    },
    users: [
      { id: 'owner-1', name: 'One' },
      { id: 'owner-2', name: 'Two' },
    ],
    files: [
      { id: 'file-1', path: 'a/camera.jpg', bytes: '14', sha256: SAME, role: 'original' },
      { id: 'file-2', path: 'b/camera.jpg', bytes: '14', sha256: SAME, role: 'original' },
      { id: 'file-3', path: 'c/other.jpg', bytes: '9', sha256: OTHER, role: 'original' },
      { id: 'file-4', path: 'd/camera.jpg', bytes: '14', sha256: SAME, role: 'original' },
    ],
    assets: [
      {
        id: 'asset-1',
        ownerId: 'owner-1',
        primaryFileId: 'file-1',
        fileIds: ['file-1'],
        visibility: 'timeline',
        metadata: {},
      },
      {
        id: 'asset-2',
        ownerId: 'owner-1',
        primaryFileId: 'file-2',
        fileIds: ['file-2'],
        visibility: 'locked',
        metadata: {},
      },
      {
        id: 'asset-3',
        ownerId: 'owner-1',
        primaryFileId: 'file-3',
        fileIds: ['file-3'],
        visibility: 'timeline',
        metadata: {},
      },
      // the same bytes under another owner are that owner's own photo
      {
        id: 'asset-4',
        ownerId: 'owner-2',
        primaryFileId: 'file-4',
        fileIds: ['file-4'],
        visibility: 'timeline',
        metadata: {},
      },
    ],
    albums: [
      { id: 'album-1', ownerId: 'owner-1', name: 'Both', assetIds: ['asset-1', 'asset-2', 'asset-3'], members: [] },
      { id: 'album-2', ownerId: 'owner-1', name: 'First only', assetIds: ['asset-1'], members: [] },
    ],
    losses: [],
  });

describe('mergeIdenticalOriginals (FL-1505)', () => {
  it('keeps the Locked copy, moves album membership to it and reports the merged copy', () => {
    const value = manifest();
    expect(mergeIdenticalOriginals(value)).toBe(1);
    expect(value.assets.map((asset) => asset.id)).toEqual(['asset-2', 'asset-3', 'asset-4']);
    expect(value.files.map((file) => file.id)).toEqual(['file-2', 'file-3', 'file-4']);
    expect(value.albums.map((album) => album.assetIds)).toEqual([['asset-2', 'asset-3'], ['asset-2']]);
    expect(value.losses).toEqual([{ code: IDENTICAL_MERGED_LOSS, entityId: 'asset-1', acknowledged: false }]);
    // still a manifest the importer accepts
    expect(() => parseImportManifest(value)).not.toThrow();
  });

  it('changes nothing in a library without identical photos', () => {
    const value = manifest();
    value.files[1].sha256 = 'c'.repeat(64);
    const before = structuredClone(value);
    expect(mergeIdenticalOriginals(value)).toBe(0);
    expect(value).toEqual(before);
  });
});
