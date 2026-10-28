import { Reflector } from '@nestjs/core';
import { BookmarkController } from 'src/controllers/bookmark.controller.js';
import { Permission } from 'src/enum.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';

it('keeps bookmark management private and requires the operation permission', () => {
  const reflector = new Reflector();
  for (const [handler, permission] of [
    [BookmarkController.prototype.createBookmark, Permission.BookmarkCreate],
    [BookmarkController.prototype.getBookmark, Permission.BookmarkRead],
    [BookmarkController.prototype.updateBookmark, Permission.BookmarkUpdate],
    [BookmarkController.prototype.trashBookmark, Permission.BookmarkDelete],
    [BookmarkController.prototype.restoreBookmark, Permission.BookmarkUpdate],
    [BookmarkController.prototype.setBookmarkTags, Permission.BookmarkUpdate],
  ] as const) {
    expect(getAuthenticatedOptions(reflector, handler)).toEqual(
      expect.objectContaining({ permission, sharedLink: false }),
    );
  }
});
