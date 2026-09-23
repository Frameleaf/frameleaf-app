import { AlbumKind, AlbumUserRole, type SharedSpaceMemberResponseDto } from '@immich/sdk';
import { albumFactory } from '@test-data/factories/album-factory';
import { personFactory } from '@test-data/factories/person-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import { describe, expect, it } from 'vitest';
import {
  addSourceOptions,
  alreadyInvolvedIds,
  canContribute,
  canManageMembers,
  canRemoveMember,
  defaultSpacePersonName,
  filterToNew,
  hasNewSinceVisit,
  isSpace,
  isSpaceOwner,
  isSpacePanel,
  linkableAlbums,
  linkedAlbumIsEmpty,
  newSinceFilter,
  newSinceIsPartial,
  newSinceMessageKey,
  panelFromSearch,
  pendingInvitations,
  shouldPageForNew,
  sortMembers,
  spaceAddScope,
  spaceOwner,
  spacePersonCandidates,
  spaceRole,
  SPACE_PANELS,
  SPACE_ROLE_OPTIONS,
} from '$lib/frameleaf/shared-space';

const owner = userAdminFactory.build({ id: 'owner', name: 'Ada' });
const editor = userAdminFactory.build({ id: 'editor', name: 'Bo' });
const viewer = userAdminFactory.build({ id: 'viewer', name: 'Cy' });

const space = albumFactory.build({
  id: 'space-1',
  kind: AlbumKind.Space,
  albumUsers: [
    { user: owner, role: AlbumUserRole.Owner },
    { user: editor, role: AlbumUserRole.Editor },
    { user: viewer, role: AlbumUserRole.Viewer },
  ],
});

const member = (
  user: typeof owner,
  role: AlbumUserRole,
  pending = false,
): SharedSpaceMemberResponseDto => ({ user, role, pending });

describe('shared space rules', () => {
  it('recognises a space, and not an album or a collection', () => {
    expect(isSpace(space)).toBe(true);
    expect(isSpace(albumFactory.build({ kind: AlbumKind.Album }))).toBe(false);
    expect(isSpace(albumFactory.build({ kind: AlbumKind.Collection }))).toBe(false);
  });

  it('reads the owner and each role', () => {
    expect(spaceOwner(space)?.id).toBe('owner');
    expect(spaceRole(space, 'editor')).toBe(AlbumUserRole.Editor);
    expect(spaceRole(space, 'viewer')).toBe(AlbumUserRole.Viewer);
    expect(spaceRole(space, 'stranger')).toBeNull();
    expect(spaceRole(space, undefined)).toBeNull();
  });

  it('lets the owner and an editor contribute, but not a viewer', () => {
    expect(canContribute(space, 'owner')).toBe(true);
    expect(canContribute(space, 'editor')).toBe(true);
    expect(canContribute(space, 'viewer')).toBe(false);
    expect(canContribute(space, 'stranger')).toBe(false);
  });

  it('gives membership management to the owner alone', () => {
    expect(isSpaceOwner(space, 'owner')).toBe(true);
    expect(canManageMembers(space, 'editor')).toBe(false);
    expect(canManageMembers(space, 'viewer')).toBe(false);
    expect(canManageMembers(space, undefined)).toBe(false);
  });

  it('never offers the owner role', () => {
    expect(SPACE_ROLE_OPTIONS).toEqual([AlbumUserRole.Editor, AlbumUserRole.Viewer]);
  });

  describe('canRemoveMember', () => {
    it('lets anyone leave and lets the owner remove anyone else', () => {
      expect(canRemoveMember(space, 'editor', member(editor, AlbumUserRole.Editor))).toBe(true);
      expect(canRemoveMember(space, 'owner', member(viewer, AlbumUserRole.Viewer))).toBe(true);
    });

    it('refuses an editor removing somebody else, and refuses removing the owner', () => {
      expect(canRemoveMember(space, 'editor', member(viewer, AlbumUserRole.Viewer))).toBe(false);
      expect(canRemoveMember(space, 'owner', member(owner, AlbumUserRole.Owner))).toBe(false);
    });
  });

  it('orders the roster owner, members, then unanswered invitations', () => {
    const sorted = sortMembers([
      member(viewer, AlbumUserRole.Viewer, true),
      member(editor, AlbumUserRole.Editor),
      member(owner, AlbumUserRole.Owner),
    ]);

    expect(sorted.map(({ user }) => user.id)).toEqual(['owner', 'editor', 'viewer']);
  });

  it('counts everyone already involved so nobody is invited twice', () => {
    const ids = alreadyInvolvedIds([member(owner, AlbumUserRole.Owner), member(viewer, AlbumUserRole.Viewer, true)]);
    expect([...ids].sort()).toEqual(['owner', 'viewer']);
  });

  it('keeps only invitations that are still an offer', () => {
    const preview = (id: string, accepted: boolean) =>
      ({ id, accepted }) as unknown as Parameters<typeof pendingInvitations>[0][number];
    expect(pendingInvitations([preview('a', false), preview('b', true)]).map(({ id }) => id)).toEqual(['a']);
  });

  describe('spaceAddScope', () => {
    it('freezes a library scope, never the space itself', () => {
      const scope = spaceAddScope({ kind: 'library' });
      expect(scope.scope).toEqual({ kind: 'library' });
      expect(scope.version).toBe(1);
    });

    it('freezes the chosen album as the source', () => {
      expect(spaceAddScope({ kind: 'album', id: 'album-9' }).scope).toEqual({ kind: 'album', id: 'album-9' });
    });

    it('returns a fresh state each time, so a later edit cannot reach a running operation', () => {
      const first = spaceAddScope({ kind: 'library' });
      const second = spaceAddScope({ kind: 'library' });
      expect(first).not.toBe(second);
      expect(first.query).not.toBe(second.query);
    });
  });

  it('offers plain albums as a source, never the space or a collection', () => {
    const album = albumFactory.build({ id: 'album-1', kind: AlbumKind.Album });
    const collection = albumFactory.build({ id: 'collection-1', kind: AlbumKind.Collection });
    expect(addSourceOptions([album, collection, space], space.id).map(({ id }) => id)).toEqual(['album-1']);
  });
});

describe('shared space panels', () => {
  it('opens on the timeline and knows every panel it offers', () => {
    expect(SPACE_PANELS[0]).toBe('timeline');
    expect(isSpacePanel('people')).toBe(true);
    expect(isSpacePanel('settings')).toBe(false);
    expect(isSpacePanel(null)).toBe(false);
  });

  it('reads the panel from the URL and falls back to the timeline', () => {
    expect(panelFromSearch(new URLSearchParams('panel=places'))).toBe('places');
    expect(panelFromSearch(new URLSearchParams('panel=nope'))).toBe('timeline');
    expect(panelFromSearch(new URLSearchParams(''))).toBe('timeline');
  });
});

describe('linked albums', () => {
  it('offers plain albums only, never the space, a collection or one already linked', () => {
    const album = albumFactory.build({ id: 'album-1', kind: AlbumKind.Album });
    const linked = albumFactory.build({ id: 'album-2', kind: AlbumKind.Album });
    const collection = albumFactory.build({ id: 'collection-1', kind: AlbumKind.Collection });
    const otherSpace = albumFactory.build({ id: 'space-2', kind: AlbumKind.Space });
    expect(
      linkableAlbums([album, linked, collection, otherSpace, space], space.id, ['album-2']).map(({ id }) => id),
    ).toEqual(['album-1']);
  });

  it('calls a link with nothing in the space empty rather than broken', () => {
    expect(linkedAlbumIsEmpty({ assetCount: 0 })).toBe(true);
    expect(linkedAlbumIsEmpty({ assetCount: 3 })).toBe(false);
  });
});

describe('new since your last visit', () => {
  const info = (assetIds: string[], assetCount = assetIds.length, lastVisitedAt: string | null = null) => ({
    assetIds,
    assetCount,
    lastVisitedAt,
  });

  it('has something to say only when there is something new', () => {
    expect(hasNewSinceVisit(undefined)).toBe(false);
    expect(hasNewSinceVisit(info([]))).toBe(false);
    expect(hasNewSinceVisit(info(['a']))).toBe(true);
  });

  it('narrows the timeline only while asked to, and never to nothing', () => {
    expect(newSinceFilter(info(['a', 'b']), false)).toBeUndefined();
    expect(newSinceFilter(info([], 4), true)).toBeUndefined();
    expect(newSinceFilter(info(['a', 'b']), true)).toEqual(new Set(['a', 'b']));
  });

  it('says when the server named fewer items than it counted', () => {
    expect(newSinceIsPartial(info(['a'], 700))).toBe(true);
    expect(newSinceIsPartial(info(['a'], 1))).toBe(false);
  });

  it('speaks of a last visit only when there was one', () => {
    expect(newSinceMessageKey(info(['a']))).toBe('frameleaf_spaces_new_first');
    expect(newSinceMessageKey(info(['a'], 1, '2026-09-20T00:00:00.000Z'))).toBe('frameleaf_spaces_new_since');
  });

  it('keeps only the new items when a filter is on', () => {
    const assets = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(filterToNew(assets, undefined)).toBe(assets);
    expect(filterToNew(assets, new Set(['c', 'a'])).map(({ id }) => id)).toEqual(['a', 'c']);
  });

  it('keeps paging until every new item is found or the space runs out', () => {
    const filter = new Set(['a', 'b']);
    expect(shouldPageForNew({ filter, found: 1, exhausted: false, loading: false })).toBe(true);
    expect(shouldPageForNew({ filter, found: 2, exhausted: false, loading: false })).toBe(false);
    expect(shouldPageForNew({ filter, found: 1, exhausted: true, loading: false })).toBe(false);
    expect(shouldPageForNew({ filter, found: 1, exhausted: false, loading: true })).toBe(false);
    expect(shouldPageForNew({ filter: undefined, found: 0, exhausted: false, loading: false })).toBe(false);
  });
});

describe('people in a shared space', () => {
  it('offers the member their own name for someone, which the space then keeps its own copy of', () => {
    expect(defaultSpacePersonName(personFactory.build({ name: 'Grandma' }))).toBe('Grandma');
    expect(defaultSpacePersonName({ name: '' })).toBe('');
  });

  it('never offers a person the member has hidden', () => {
    const shown = personFactory.build({ id: 'shown', isHidden: false });
    const hidden = personFactory.build({ id: 'hidden', isHidden: true });
    expect(spacePersonCandidates([shown, hidden]).map(({ id }) => id)).toEqual(['shown']);
  });
});
