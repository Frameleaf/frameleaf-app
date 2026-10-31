import { BrowserContext } from '@playwright/test';
import { TimelineAssetConfig } from 'src/ui/generators/timeline';

/** The file name the mocked trash lists an asset under. */
export const trashFileName = (asset: TimelineAssetConfig) => `${asset.id}.${asset.isVideo ? 'mp4' : 'jpg'}`;

/**
 * The trash API as the Command Center's Trash section (FL-47, FL-71) reads it: the items and summary
 * list the assets each test moved to the trash, in timeline order, and a restore goes through the
 * review/apply pair the section uses. `onRestore` removes the restored ids from the test's changes.
 */
export const setupTrashMockApiRoutes = async (
  context: BrowserContext,
  trashed: () => TimelineAssetConfig[],
  onRestore: (ids: string[]) => void,
) => {
  await context.route('**/api/trash/items*', async (route) => {
    const items = trashed().map((asset) => ({
      id: asset.id,
      originalFileName: trashFileName(asset),
      type: asset.isVideo ? 'VIDEO' : 'IMAGE',
      fileSizeInByte: null,
      isLocked: false,
      isOffline: false,
      trashedAt: new Date().toISOString(),
    }));
    await route.fulfill({ json: { items, nextPage: null, total: items.length } });
  });
  await context.route('**/api/trash/summary', async (route) => {
    await route.fulfill({ json: { bytes: 0, count: trashed().length, offline: 0, pendingDeletion: 0 } });
  });
  // FL-47: the Large files activity history; these specs start with none.
  await context.route('**/api/trash/activity*', async (route) => {
    await route.fulfill({ json: { entries: [] } });
  });
  await context.route('**/api/trash/review', async (route, request) => {
    const { action, ids } = request.postDataJSON() as { action: string; ids?: string[] };
    const chosen = ids ?? trashed().map(({ id }) => id);
    await route.fulfill({
      json: {
        action,
        bytes: 0,
        count: chosen.length,
        names: trashed()
          .filter(({ id }) => chosen.includes(id))
          .map((asset) => trashFileName(asset)),
        retainedBytes: 0,
        retainedOriginals: 0,
        token: 'e2e-review',
      },
    });
  });
  await context.route('**/api/trash/apply', async (route, request) => {
    const { action, ids } = request.postDataJSON() as { action: string; ids?: string[] };
    const chosen = ids ?? trashed().map(({ id }) => id);
    if (action === 'restore' || action === 'restore-all') {
      onRestore(chosen);
    }
    await route.fulfill({ json: { count: chosen.length } });
  });
};
