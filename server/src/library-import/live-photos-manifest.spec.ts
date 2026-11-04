import { describe, expect, it } from 'vitest';
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';

const inventory = () => ({
  format: 'frameleaf-library-import',
  version: 5,
  source: { kind: 'ente', version: 'synthetic', identity: 'account', revision: 'one', schemaSha256: 'a'.repeat(64) },
  inventory: {
    complete: true,
    ownershipComplete: true,
    privacyComplete: true,
    writersStopped: true,
    revisionBefore: 'one',
    revisionAfter: 'one',
  },
  users: [
    { id: 'owner', name: 'Owner' },
    { id: 'other', name: 'Other' },
  ],
  files: ['still', 'motion'].map((id) => ({ id, path: id, bytes: '3', sha256: 'b'.repeat(64), role: 'original' })),
  assets: ['still', 'motion'].map((id) => ({
    id,
    ownerId: 'owner',
    fileIds: [id],
    primaryFileId: id,
    type: id === 'still' ? 'IMAGE' : 'VIDEO',
    fileModifiedAt: '2020-01-02T03:04:05Z',
    originalFileNames: { [id]: id },
    visibility: id === 'motion' ? 'hidden' : 'timeline',
    metadata: { takenAt: '2020-01-02T03:04:05Z', timeZone: 'UTC' },
  })),
  albums: [] as {
    id: string;
    ownerId: string;
    name: string;
    assetIds: string[];
    members: { userId: string; role: string }[];
  }[],
  stacks: [] as { id: string; ownerId: string; primaryAssetId: string; assetIds: string[] }[],
  livePhotos: [{ photoAssetId: 'still', videoAssetId: 'motion' }],
  losses: [],
});

describe('sealed Live Photo import relationships', () => {
  it('retains explicit original still and motion identities without filename inference', () => {
    const value = inventory();
    expect(parseImportManifest(value)).toEqual(value);
    expect(manifestFingerprint(parseImportManifest(value))).toBe(
      manifestFingerprint(parseImportManifest(structuredClone(value))),
    );
  });
  it('requires an explicit inventory and permits an empty inventory', () => {
    const { livePhotos: _pairs, ...missing } = inventory();
    expect(() => parseImportManifest(missing)).toThrow();
    expect(parseImportManifest({ ...missing, livePhotos: [] })).toEqual({ ...missing, livePhotos: [] });
  });
  it.each([1, 2, 3, 4])('does not reinterpret legacy version %s as containing Live Photos', (version) => {
    expect(() => parseImportManifest({ ...inventory(), version })).toThrow();
  });
  it.each(['photoAssetId', 'videoAssetId'] as const)('refuses missing %s', (field) => {
    const value = inventory();
    value.livePhotos[0][field] = 'unknown';
    expect(() => parseImportManifest(value)).toThrow('LIVE_PHOTO_ASSETS_INVALID');
  });
  it('refuses repeated pairs', () => {
    const value = inventory();
    value.livePhotos.push({ ...value.livePhotos[0] });
    expect(() => parseImportManifest(value)).toThrow('LIVE_PHOTO_MEMBERSHIP_CONFLICT');
  });
  it('refuses cross-owner relationships', () => {
    const value = inventory();
    value.assets[1].ownerId = 'other';
    expect(() => parseImportManifest(value)).toThrow('LIVE_PHOTO_OWNER_INVALID');
  });
  it.each([0, 1])('refuses an incorrect media type at member %s', (index) => {
    const value = inventory();
    value.assets[index].type = index === 0 ? 'VIDEO' : 'IMAGE';
    expect(() => parseImportManifest(value)).toThrow('LIVE_PHOTO_ASSETS_INVALID');
  });
  it('refuses a motion asset that would lose its independent library visibility', () => {
    const value = inventory();
    value.assets[1].visibility = 'timeline';
    expect(() => parseImportManifest(value)).toThrow('LIVE_PHOTO_STATE_UNSUPPORTED');
  });
  it('refuses unqualified trash pair semantics', () => {
    const value = inventory();
    value.assets[0].visibility = 'trash';
    expect(() => parseImportManifest(value)).toThrow('LIVE_PHOTO_STATE_UNSUPPORTED');
  });
  it('accepts a Locked still whose motion part stays hidden', () => {
    const value = inventory();
    value.assets[0].visibility = 'locked';
    expect(parseImportManifest(value)).toEqual(value);
  });
  it('refuses independent motion album memberships instead of removing them', () => {
    const value = inventory();
    value.albums.push({ id: 'album', ownerId: 'owner', name: 'Private', assetIds: ['motion'], members: [] });
    expect(() => parseImportManifest(value)).toThrow('LIVE_PHOTO_MOTION_RELATIONSHIP_UNSUPPORTED');
  });
  it('refuses independent motion stack membership', () => {
    const value = inventory();
    value.assets[0].visibility = 'hidden';
    value.stacks.push({ id: 'stack', ownerId: 'owner', primaryAssetId: 'still', assetIds: ['still', 'motion'] });
    expect(() => parseImportManifest(value)).toThrow('LIVE_PHOTO_MOTION_RELATIONSHIP_UNSUPPORTED');
  });
  it('pins the explicit relationship without altering legacy version 4 fingerprints', () => {
    const value = inventory();
    const unpaired = { ...value, livePhotos: [] };
    expect(manifestFingerprint(parseImportManifest(value))).not.toBe(
      manifestFingerprint(parseImportManifest(unpaired)),
    );
    const { livePhotos: _pairs, ...legacy } = value;
    const parsed = parseImportManifest({ ...legacy, version: 4 });
    expect(parsed).toEqual({ ...legacy, version: 4 });
  });
});
