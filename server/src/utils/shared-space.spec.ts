import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AlbumKind, AlbumUserRole } from 'src/enum.js';
import {
  INVITABLE_SPACE_ROLES,
  isSharedSpace,
  isSpaceMember,
  requireInvitableRole,
  requireSharedSpace,
  requireSpaceOwner,
  spaceOwnerId,
  spaceRoleOf,
} from 'src/utils/shared-space.js';

const member = (id: string, role: AlbumUserRole) => ({ role, user: { id } });

const space = (users = [member('owner-1', AlbumUserRole.Owner)]) => ({
  kind: AlbumKind.Space,
  albumUsers: users,
});

describe('shared space rules', () => {
  describe('isSharedSpace', () => {
    it('is true only for the space kind', () => {
      expect(isSharedSpace({ kind: AlbumKind.Space })).toBe(true);
      expect(isSharedSpace({ kind: AlbumKind.Album })).toBe(false);
      expect(isSharedSpace({ kind: AlbumKind.Collection })).toBe(false);
    });

    it('treats a row written before the kind column as a plain album', () => {
      expect(isSharedSpace({ kind: '' })).toBe(false);
      expect(isSharedSpace({ kind: 'something-else' })).toBe(false);
    });
  });

  describe('requireSharedSpace', () => {
    it('refuses an album and a collection', () => {
      expect(() => requireSharedSpace({ kind: AlbumKind.Album })).toThrow(BadRequestException);
      expect(() => requireSharedSpace({ kind: AlbumKind.Collection })).toThrow(BadRequestException);
      expect(() => requireSharedSpace({ kind: AlbumKind.Space })).not.toThrow();
    });
  });

  describe('roles', () => {
    it('finds the owner and each member role', () => {
      const album = space([
        member('owner-1', AlbumUserRole.Owner),
        member('editor-1', AlbumUserRole.Editor),
        member('viewer-1', AlbumUserRole.Viewer),
      ]);

      expect(spaceOwnerId(album)).toBe('owner-1');
      expect(spaceRoleOf(album, 'editor-1')).toBe(AlbumUserRole.Editor);
      expect(spaceRoleOf(album, 'viewer-1')).toBe(AlbumUserRole.Viewer);
      expect(spaceRoleOf(album, 'stranger')).toBeNull();
      expect(isSpaceMember(album, 'viewer-1')).toBe(true);
      expect(isSpaceMember(album, 'stranger')).toBe(false);
    });
  });

  describe('requireSpaceOwner', () => {
    it('lets the owner through', () => {
      expect(() => requireSpaceOwner(space(), 'owner-1')).not.toThrow();
    });

    it('refuses an editor, a viewer and a stranger', () => {
      const album = space([
        member('owner-1', AlbumUserRole.Owner),
        member('editor-1', AlbumUserRole.Editor),
        member('viewer-1', AlbumUserRole.Viewer),
      ]);

      expect(() => requireSpaceOwner(album, 'editor-1')).toThrow(ForbiddenException);
      expect(() => requireSpaceOwner(album, 'viewer-1')).toThrow(ForbiddenException);
      expect(() => requireSpaceOwner(album, 'stranger')).toThrow(ForbiddenException);
    });
  });

  describe('requireInvitableRole', () => {
    it('offers editor and viewer only', () => {
      expect(INVITABLE_SPACE_ROLES).toEqual([AlbumUserRole.Editor, AlbumUserRole.Viewer]);
      expect(() => requireInvitableRole(AlbumUserRole.Editor)).not.toThrow();
      expect(() => requireInvitableRole(AlbumUserRole.Viewer)).not.toThrow();
      expect(() => requireInvitableRole(AlbumUserRole.Owner)).toThrow(BadRequestException);
    });
  });
});
