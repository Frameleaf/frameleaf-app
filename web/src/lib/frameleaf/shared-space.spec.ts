import { AlbumKind, AlbumUserRole, type SharedSpaceMemberResponseDto } from '@immich/sdk';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import { describe, expect, it } from 'vitest';
import {
  addSourceOptions,
  alreadyInvolvedIds,
  canContribute,
  canManageMembers,
  canRemoveMember,
  isSpace,
  isSpaceOwner,
  pendingInvitations,
  sortMembers,
  spaceAddScope,
  spaceOwner,
  spaceRole,
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
