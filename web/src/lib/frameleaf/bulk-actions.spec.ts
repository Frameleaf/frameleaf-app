import { AssetTypeEnum, AssetVisibility, type AssetResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  bulkActionById,
  bulkActions,
  livePhotoPair,
  menuBulkActions,
  primaryBulkActions,
  selectedStackIds,
  toBulkAsset,
  type BulkAsset,
} from '$lib/frameleaf/bulk-actions';

const photo = (id: string, extra: Partial<BulkAsset> = {}): BulkAsset => ({ id, isVideo: false, ...extra });
const video = (id: string, extra: Partial<BulkAsset> = {}): BulkAsset => ({ id, isVideo: true, ...extra });

const available = (context: Parameters<typeof bulkActions>[0]) =>
  bulkActions(context)
    .filter((action) => action.available)
    .map((action) => action.id);

describe('bulk action descriptors', () => {
  it('offers nothing while nothing is selected', () => {
    expect(available({})).toEqual([]);
  });

  it('carries the complete bulk set for a live selection', () => {
    const ids = available({ assets: [photo('a'), video('b')] });
    for (const id of [
      'favorite',
      'add-to-album',
      'create-shared-link',
      'download',
      'delete',
      'stack',
      'tag',
      'change-date',
      'change-description',
      'change-location',
      'archive',
      'mark-sensitive',
      'refresh-thumbnails',
      'refresh-metadata',
      'refresh-faces',
      'refresh-encoded',
    ]) {
      expect(ids).toContain(id);
    }
    // Nothing in this selection is marked, so there is nothing to unmark (FL-34).
    expect(ids).not.toContain('unmark-sensitive');
    // Trash-only actions stay out of a live selection.
    expect(ids).not.toContain('restore');
    expect(ids).not.toContain('delete-permanently');
  });

  it('replaces the live actions with restore and permanent delete in the trash', () => {
    const ids = available({ assets: [photo('a')], trash: true });
    expect(ids).toEqual(expect.arrayContaining(['restore', 'delete-permanently', 'download']));
    expect(ids).not.toContain('delete');
    expect(ids).not.toContain('favorite');
    expect(ids).not.toContain('archive');
  });

  it('narrows the Locked folder to its own actions', () => {
    // FL-33: the Locked destination replaces the legacy select bar, which offered moving items
    // back out, the download, date and location, and the permanent delete — nothing else.
    const ids = available({ assets: [photo('a')], locked: true });
    expect(ids).toEqual(
      expect.arrayContaining(['unmark-sensitive', 'download', 'change-date', 'change-location', 'delete-permanently']),
    );
    for (const id of ['favorite', 'create-shared-link', 'delete', 'archive', 'mark-sensitive', 'tag']) {
      expect(ids).not.toContain(id);
    }
  });

  it('lets the unlocked Locked folder add its items to an album (owner decision, September 22, 2026)', () => {
    expect(available({ assets: [photo('a')], locked: true })).toContain('add-to-album');
    expect(available({ assets: [photo('a')], locked: true, readOnly: true })).not.toContain('add-to-album');
    // Drawn as a button there, since the Locked bar has no album group in its menu.
    const actions = bulkActions({ assets: [photo('a')], locked: true });
    expect(primaryBulkActions(actions, false, true).map((action) => action.id)).toContain('add-to-album');
  });

  it('offers Mark Sensitive from the ordinary destinations only (FL-34)', () => {
    expect(available({ assets: [photo('a')] })).toContain('mark-sensitive');
    expect(available({ assets: [photo('a')], trash: true })).not.toContain('mark-sensitive');
    expect(available({ assets: [photo('a')], locked: true })).not.toContain('mark-sensitive');
    // an unlocked session shows a marked item in the library, where it can be unmarked but not
    // archived, which would store another visibility and unlock it
    const revealed = available({ assets: [photo('a', { isLocked: true })] });
    expect(revealed).toContain('unmark-sensitive');
    expect(revealed).not.toContain('archive');
  });

  it('leaves a read-only shared link with the download alone', () => {
    const ids = available({ assets: [photo('a')], readOnly: true });
    expect(ids).toEqual(['download']);
  });

  it("lets a shared link's owner prune it even though the link is read-only", () => {
    const ids = available({ assets: [photo('a')], readOnly: true, sharedLinkId: 'link-1' });
    expect(ids).toEqual(expect.arrayContaining(['download', 'remove-from-shared-link']));
    expect(ids).not.toContain('delete');
    expect(ids).not.toContain('favorite');
  });

  it('offers only the direction that applies for favorite and archive', () => {
    const favorited = bulkActionById(bulkActions({ assets: [photo('a', { isFavorite: true })] }));
    expect(favorited.favorite?.available).toBe(false);
    expect(favorited.unfavorite?.available).toBe(true);

    const archived = bulkActionById(bulkActions({ assets: [photo('a', { isArchived: true })] }));
    expect(archived.archive?.available).toBe(false);
    expect(archived.unarchive?.available).toBe(true);
  });

  it('offers Export for preservation on a resolved selection holding any item of the viewer’s own (FL-74)', () => {
    const mine = photo('a', { ownerId: 'me' });
    const theirs = photo('b', { ownerId: 'partner' });
    expect(available({ assets: [mine, theirs], currentUserId: 'me' })).toContain('export-preservation');
    expect(available({ assets: [theirs], currentUserId: 'me' })).not.toContain('export-preservation');
    // Unlocked Locked view: exported as Locked items, from the session that can see them.
    expect(available({ assets: [mine], currentUserId: 'me', locked: true })).toContain('export-preservation');
    for (const context of [
      { assets: [mine], currentUserId: 'me', trash: true },
      { assets: [mine], currentUserId: 'me', readOnly: true },
      // A matching set is preserved as a Search scope, not as a list of ids the page never loaded.
      { count: 4000, snapshot: true, currentUserId: 'me' },
    ]) {
      expect(available(context)).not.toContain('export-preservation');
    }
    const action = bulkActionById(bulkActions({ assets: [mine], currentUserId: 'me' }))['export-preservation'];
    expect(action).toMatchObject({ group: 'jobs', dialog: true, labelKey: 'frameleaf_bulk_export_preservation' });
  });

  it('withholds the actions that need the individual items from a snapshot selection', () => {
    const ids = available({ count: 4000, snapshot: true });
    expect(ids).toEqual(expect.arrayContaining(['favorite', 'archive', 'tag', 'delete', 'mark-sensitive']));
    for (const id of ['stack', 'unstack', 'link-live-photo', 'unlink-live-photo', 'set-album-cover']) {
      expect(ids).not.toContain(id);
    }
  });

  /**
   * FL-48 map/space follow-ups: "select all matching" no longer refuses a shared space
   * (`bulk-operations.spec.ts`'s `applies a shared-space scope as the album condition it is`), but a
   * viewer's role there permits only download and adding to an album of their own -- never the
   * album-level actions an editor or owner has, which the server would refuse per item anyway.
   */
  it("limits a shared space's matching set to what a viewer's role permits", () => {
    const ids = available({ count: 4000, snapshot: true, albumId: 'space-1', spaceViewerMatching: true });
    expect(ids).toEqual(['add-to-album', 'download']);
  });

  it('does not restrict a manually built selection in a shared space, only the matching one', () => {
    // spaceViewerMatching is paired with `snapshot`; a resolved, manually chosen selection still
    // offers the full album menu, and the server's per-item check still decides.
    const ids = available({ assets: [photo('a')], albumId: 'space-1', spaceViewerMatching: true });
    expect(ids).toContain('remove-from-album');
    expect(ids).toContain('tag');
  });

  it("lets an editor or owner's matching set keep the full album-level menu", () => {
    const ids = available({ count: 4000, snapshot: true, albumId: 'space-1' });
    expect(ids).toEqual(expect.arrayContaining(['favorite', 'tag', 'delete', 'mark-sensitive']));
  });

  it('enables the album actions only inside an album, and the cover only for one item', () => {
    expect(available({ assets: [photo('a')] })).not.toContain('remove-from-album');
    const inAlbum = bulkActions({ assets: [photo('a')], albumId: 'album-1' });
    expect(bulkActionById(inAlbum)['remove-from-album']?.albumId).toBe('album-1');
    expect(bulkActionById(inAlbum)['set-album-cover']?.available).toBe(true);
    expect(
      bulkActionById(bulkActions({ assets: [photo('a'), photo('b')], albumId: 'album-1' }))['set-album-cover']
        ?.available,
    ).toBe(false);
  });

  it('never offers a Locked item as the album cover (FL-53)', () => {
    const lockedInAlbum = bulkActions({ assets: [photo('a', { isLocked: true })], albumId: 'album-1' });
    expect(bulkActionById(lockedInAlbum)['set-album-cover']?.available).toBe(false);
    // it may still be removed from the album
    expect(bulkActionById(lockedInAlbum)['remove-from-album']?.available).toBe(true);
  });

  it('links a Live Photo only for exactly one still and one video', () => {
    expect(livePhotoPair([photo('a'), video('b')])).toEqual({ photoId: 'a', videoId: 'b' });
    expect(livePhotoPair([photo('a'), video('b'), video('c')])).toBeNull();
    expect(livePhotoPair([photo('a', { isLivePhoto: true }), video('b')])).toBeNull();
  });

  it('collects the distinct stacks a selection spans', () => {
    const assets = [photo('a', { stackId: 's1' }), photo('b', { stackId: 's1' }), photo('c')];
    expect(selectedStackIds(assets)).toEqual(['s1']);
  });

  it('stacks only two or more items', () => {
    expect(available({ assets: [photo('a')] })).not.toContain('stack');
    expect(available({ assets: [photo('a'), photo('b')] })).toContain('stack');
  });

  it('offers re-encoding only when the selection holds a video', () => {
    expect(available({ assets: [photo('a')] })).not.toContain('refresh-encoded');
    expect(available({ assets: [photo('a'), video('b')] })).toContain('refresh-encoded');
    // A snapshot cannot inspect the items, so the job is offered and the server decides.
    expect(available({ count: 10, snapshot: true })).toContain('refresh-encoded');
  });

  // FL-35 / FL-54: "Send a copy…" through the native share sheet, separate from the shared link.
  it('offers Send a copy where the browser can share files, for explicit items outside trash and Locked', () => {
    const assets = [photo('a'), photo('b')];
    expect(available({ assets })).not.toContain('send-copy');
    expect(available({ assets, canSendCopy: true })).toContain('send-copy');
    expect(available({ assets, canSendCopy: true, trash: true })).not.toContain('send-copy');
    expect(available({ assets, canSendCopy: true, locked: true })).not.toContain('send-copy');
    expect(available({ count: 3, snapshot: true, canSendCopy: true })).not.toContain('send-copy');
    // A shared link that allows downloads may send copies too.
    expect(available({ assets, canSendCopy: true, readOnly: true })).toContain('send-copy');
    const primary = primaryBulkActions(bulkActions({ assets, canSendCopy: true }), false).map((action) => action.id);
    expect(primary).toEqual(['favorite', 'add-to-album', 'create-shared-link', 'send-copy', 'download', 'delete']);
  });

  it('draws the primary buttons and never repeats them in the menu', () => {
    const actions = bulkActions({ assets: [photo('a', { isFavorite: true }), photo('b')], albumId: 'album-1' });
    const primary = primaryBulkActions(actions, false).map((action) => action.id);
    expect(primary).toEqual(['favorite', 'add-to-album', 'create-shared-link', 'download', 'delete']);

    const menu = menuBulkActions(actions, false);
    const menuIds = menu.flatMap((group) => group.items.map((item) => item.id));
    expect(menu.map((group) => group.id)).toEqual(['organize', 'visibility', 'album', 'jobs']);
    // The menu holds only the non-primary groups, exactly as the prototype's More menu does.
    expect(menuIds).not.toContain('unfavorite');
    for (const id of primary) {
      expect(menuIds).not.toContain(id);
    }
  });

  it('collapses favorite to its removal when nothing can be favorited', () => {
    const actions = bulkActions({ assets: [photo('a', { isFavorite: true })] });
    expect(primaryBulkActions(actions, false)[0].id).toBe('unfavorite');
  });

  it('narrows the production asset DTO to what a descriptor reads', () => {
    const asset = {
      id: 'a',
      ownerId: 'user-1',
      type: AssetTypeEnum.Video,
      isFavorite: true,
      isArchived: false,
      isTrashed: false,
      visibility: AssetVisibility.Archive,
      livePhotoVideoId: null,
      stack: { id: 'stack-1', assetCount: 2, primaryAssetId: 'a' },
    } as unknown as AssetResponseDto;
    expect(toBulkAsset(asset)).toEqual({
      id: 'a',
      ownerId: 'user-1',
      isVideo: true,
      isFavorite: true,
      // Archived visibility counts even when the deprecated flag disagrees.
      isArchived: true,
      isTrashed: false,
      isLivePhoto: false,
      isLocked: false,
      stackId: 'stack-1',
    });
    expect(toBulkAsset({ ...asset, visibility: AssetVisibility.Locked })).toMatchObject({ isLocked: true });
  });
});
