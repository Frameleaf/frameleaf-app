import { describe, expect, it } from 'vitest';
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';

const inventory = () => ({
  format: 'frameleaf-library-import',
  version: 4,
  source: {
    kind: 'ente',
    version: 'synthetic',
    identity: 'fixture-account',
    revision: 'snapshot-1',
    schemaSha256: 'a'.repeat(64),
  },
  inventory: {
    complete: true,
    ownershipComplete: true,
    privacyComplete: true,
    writersStopped: true,
    revisionBefore: 'snapshot-1',
    revisionAfter: 'snapshot-1',
  },
  users: [
    { id: 'alice', name: 'Synthetic owner' },
    { id: 'bob', name: 'Synthetic viewer' },
  ],
  files: ['one', 'two'].map((id) => ({ id, path: id + '.jpg', bytes: '12', sha256: 'b'.repeat(64), role: 'original' })),
  assets: ['one', 'two'].map((id) => ({
    id,
    ownerId: 'alice',
    fileIds: [id],
    primaryFileId: id,
    type: 'IMAGE',
    fileModifiedAt: '2020-01-02T03:04:05Z',
    originalFileNames: { [id]: id + '.jpg' },
    visibility: 'hidden',
    metadata: { takenAt: '2020-01-02T03:04:05Z', timeZone: 'UTC' },
  })),
  albums: [
    {
      id: 'private',
      ownerId: 'alice',
      name: 'Private album',
      assetIds: ['one'],
      members: [] as { userId: string; role: string }[],
    },
  ],
  stacks: [{ id: 'stack', ownerId: 'alice', primaryAssetId: 'two', assetIds: ['one', 'two'] }],
  losses: [],
});

describe('sealed import stacks', () => {
  it('retains an explicit non-first primary and same-owner membership without inferring duplicates', () => {
    const value = inventory();
    expect(parseImportManifest(value)).toEqual(value);
    expect(manifestFingerprint(parseImportManifest(value))).toBe(
      manifestFingerprint(parseImportManifest(JSON.parse(JSON.stringify(value)))),
    );
  });
  it('permits empty stack inventories but requires an explicit inventory for version 4', () => {
    expect(parseImportManifest({ ...inventory(), stacks: [] })).toMatchObject({ stacks: [] });
    const { stacks: _stacks, ...missing } = inventory();
    expect(() => parseImportManifest(missing)).toThrow();
  });
  it.each([1, 2, 3])('does not reinterpret legacy version %s as stack-bearing', (version) => {
    expect(() => parseImportManifest({ ...inventory(), version })).toThrow();
  });
  it.each(['primary', 'order'] as const)('pins stack %s in the manifest fingerprint', (kind) => {
    const value = inventory(),
      changed = inventory();
    if (kind === 'primary') changed.stacks[0].primaryAssetId = 'one';
    else changed.stacks[0].assetIds.reverse();
    expect(manifestFingerprint(parseImportManifest(value))).not.toBe(manifestFingerprint(parseImportManifest(changed)));
  });
  it('refuses unknown stack owners', () => {
    const value = inventory();
    value.stacks[0].ownerId = 'unknown';
    expect(() => parseImportManifest(value)).toThrow('STACK_OWNER_INVALID');
  });
  it('refuses a stack spanning different owners', () => {
    const value = inventory();
    value.assets[1].ownerId = 'bob';
    expect(() => parseImportManifest(value)).toThrow('STACK_OWNER_INVALID');
  });
  it.each([
    ['missing', 'two'],
    ['one', 'one'],
  ])('refuses missing or repeated source member IDs: %s,%s', (...ids) => {
    const value = inventory();
    value.stacks[0].assetIds = ids;
    expect(() => parseImportManifest(value)).toThrow('STACK_ASSETS_INVALID');
  });
  it('requires the selected primary to belong to the stack', () => {
    const value = inventory();
    value.stacks[0].primaryAssetId = 'missing';
    expect(() => parseImportManifest(value)).toThrow('STACK_PRIMARY_INVALID');
  });
  it('refuses repeated stack IDs and membership in multiple stacks', () => {
    const value = inventory();
    value.stacks.push({ ...value.stacks[0] });
    expect(() => parseImportManifest(value)).toThrow('DUPLICATE_SOURCE_ID');
    value.stacks[1].id = 'another';
    expect(() => parseImportManifest(value)).toThrow('STACK_MEMBERSHIP_CONFLICT');
  });
  it('refuses grouping different visibility states', () => {
    const value = inventory();
    value.assets[1].visibility = 'timeline';
    expect(() => parseImportManifest(value)).toThrow('STACK_VISIBILITY_MISMATCH');
  });
  it('refuses grouping a Locked item in Trash with one that is only in Trash (FL-1230)', () => {
    const value = inventory();
    for (const asset of value.assets) asset.visibility = 'trash';
    Object.assign(value.assets[1], { locked: true });
    expect(() => parseImportManifest(value)).toThrow('STACK_VISIBILITY_MISMATCH');
  });
  it('refuses grouping different effective album access', () => {
    const value = inventory();
    value.albums[0].members = [{ userId: 'bob', role: 'viewer' }];
    expect(() => parseImportManifest(value)).toThrow('STACK_ACCESS_MISMATCH');
  });
  it('unions grants across albums while preserving the strongest role for each actor', () => {
    const value = inventory();
    value.albums = [
      { ...value.albums[0], id: 'one-view', assetIds: ['one'], members: [{ userId: 'bob', role: 'viewer' }] },
      { ...value.albums[0], id: 'one-edit', assetIds: ['one'], members: [{ userId: 'bob', role: 'editor' }] },
      { ...value.albums[0], id: 'two-edit', assetIds: ['two'], members: [{ userId: 'bob', role: 'editor' }] },
    ];
    expect(parseImportManifest(value)).toEqual(value);
    value.albums[2].members[0].role = 'viewer';
    expect(() => parseImportManifest(value)).toThrow('STACK_ACCESS_MISMATCH');
  });
});
