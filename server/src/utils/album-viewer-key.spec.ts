import { albumViewerKey } from 'src/utils/album-viewer-key.js';

const filter = {
  userId: 'owner',
  includeNsfw: false,
  tagIds: ['tag-1', 'tag-2'],
  personIds: ['person-1'],
  petIds: [],
  scope: 'owned' as const,
};

describe(albumViewerKey.name, () => {
  it('is the same for the same options in any key or array order', () => {
    const reordered = {
      personIds: ['person-1'],
      tagIds: ['tag-2', 'tag-1'],
      scope: 'owned' as const,
      petIds: [],
      includeNsfw: false,
      userId: 'owner',
    };
    expect(albumViewerKey({ othersRulesViewerId: 'owner', hiddenContent: filter })).toBe(
      albumViewerKey({ hiddenContent: reordered, othersRulesViewerId: 'owner' }),
    );
  });

  it('treats an option left undefined as absent', () => {
    expect(albumViewerKey({ othersRulesViewerId: 'owner', lockedOwnerId: undefined })).toBe(
      albumViewerKey({ othersRulesViewerId: 'owner' }),
    );
  });

  it('differs for a session with its PIN and one without', () => {
    expect(albumViewerKey({ othersRulesViewerId: 'owner' })).not.toBe(
      albumViewerKey({ othersRulesViewerId: 'owner', lockedOwnerId: 'owner', revealLockedOwnerId: 'owner' }),
    );
  });

  it('differs for every option that changes what is shown', () => {
    const keys = [
      {},
      { excludeNsfw: true },
      { hiddenContent: filter },
      { hiddenContent: { ...filter, tagIds: ['tag-1'] } },
      { hiddenContent: { ...filter, scope: 'visible' as const } },
      { lockedOwnerId: 'owner' },
      { revealLockedOwnerId: 'owner' },
      { othersRulesViewerId: 'owner' },
      { othersRulesViewerId: 'member' },
      { othersRulesViewerId: null },
    ].map((options) => albumViewerKey(options));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
