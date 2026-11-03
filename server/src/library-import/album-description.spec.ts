import { describe, expect, it } from 'vitest';
import plan from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import photoprism from 'src/library-import/fixtures/photoprism/261029-metadata.json' with { type: 'json' };
import { parseImportManifest } from 'src/library-import/manifest.js';
import { normalizePhotoprismAlbum } from 'src/library-import/photoprism-metadata.js';

const input = () => ({
  format: 'frameleaf-library-import',
  version: 1,
  source: plan.plan.source,
  inventory: {
    complete: true,
    ownershipComplete: true,
    privacyComplete: true,
    writersStopped: true,
    revisionBefore: plan.plan.source.revision,
    revisionAfter: plan.plan.source.revision,
  },
  users: [{ id: 'owner', name: 'Source owner' }],
  files: [],
  assets: [],
  albums: [{ id: 'album', ownerId: 'owner', name: 'Edited source album', assetIds: [], members: [] }],
  losses: [],
});

describe('imported album descriptions', () => {
  it.each(['Manual album description\nwith a second line', ''])(
    'retains representable source text: %j',
    (description) => {
      const source = input();
      const manifest = parseImportManifest({ ...source, albums: [{ ...source.albums[0], description }] });
      expect(manifest.albums[0].description).toBe(description);
    },
  );

  it('does not introduce new properties into older manifests', () => {
    const source = input();
    expect(parseImportManifest(source).albums[0]).toEqual(source.albums[0]);
    expect(Object.hasOwn(parseImportManifest(source).albums[0], 'description')).toBe(false);
  });

  it('uses the edited description returned by the pinned PhotoPrism application', () => {
    const row = Object.fromEntries(
      Object.entries(photoprism.album).map(([key, value]) => [key, typeof value === 'number' ? BigInt(value) : value]),
    );
    expect(normalizePhotoprismAlbum(row, []).description).toBe(photoprism.expectedAlbum.Description);
  });
});
