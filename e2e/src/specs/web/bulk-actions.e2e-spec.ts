import { LoginResponseDto, createPartner, deleteAssets, setUserOnboarding } from '@frameleaf/sdk';
import { expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { asBearerAuth, utils } from 'src/utils.js';
import { test } from 'src/web-test.js';
import { playwrightDbHost } from '../../../playwright.config.js';

const isFavorite = async (accessToken: string, id: string) => {
  const asset = await utils.getAssetInfo(accessToken, id);
  return asset.isFavorite;
};
const isTrashed = async (accessToken: string, id: string) => {
  const asset = await utils.getAssetInfo(accessToken, id);
  return asset.isTrashed;
};
const visibilityOf = async (accessToken: string, id: string) => {
  const asset = await utils.getAssetInfo(accessToken, id);
  return asset.visibility;
};

const select = async (page: Page, id: string) => {
  const tile = page.locator(`[data-asset-id="${id}"]`);
  await tile.hover();
  await tile.getByRole('checkbox').click();
};

/** SelectionBar.jsx: the overflow button and its menu are both named "More actions". */
const moreAction = async (page: Page, name: string) => {
  const bar = page.getByRole('region', { name: 'Selected items' });
  await bar.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menu', { name: 'More actions' }).getByRole('menuitem', { name, exact: true }).click();
};

const setUpPartner = async () => {
  await utils.resetDatabase();
  const admin = await utils.adminSetup();
  const partner = await utils.userSetup(admin.accessToken, {
    name: 'Pat Partner',
    email: 'partner@example.com',
    password: 'password',
  });
  await setUserOnboarding({ onboardingDto: { isOnboarded: true } }, { headers: asBearerAuth(partner.accessToken) });
  await createPartner(
    { partnerCreateDto: { sharedWithId: admin.userId } },
    { headers: asBearerAuth(partner.accessToken) },
  );
  return { admin, partner };
};

/**
 * FL-36: bulk changes from the selection bar against the real server. The bar acts on the frozen,
 * authorized selection, says per item what failed or was skipped, and offers Undo for metadata and
 * for the trash instead of a confirmation.
 */
test.describe('Bulk actions', () => {
  let admin: LoginResponseDto;
  let partner: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    ({ admin, partner } = await setUpPartner());
  });

  // FL-326: a partner's item is the viewer's own copy, so the viewer's edit changes the copy, never the source
  test('favorites the copy of a partner’s item without touching the source, and undoes the favorite', async ({
    context,
    page,
  }) => {
    test.setTimeout(90_000);
    const own = await utils.createAsset(admin.accessToken);
    const theirs = await utils.createAsset(partner.accessToken);
    const copyId = await utils.waitForPartnerCopy(admin.userId, theirs.id);

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/photos');
    await select(page, own.id);
    await select(page, copyId);

    const bar = page.getByRole('region', { name: 'Selected items' });
    await bar.getByRole('button', { name: 'Favorite', exact: true }).click();

    await expect(page.getByText('Favorite: 2 items updated', { exact: true })).toBeVisible();
    await expect.poll(() => isFavorite(admin.accessToken, own.id)).toBe(true);
    await expect.poll(() => isFavorite(admin.accessToken, copyId)).toBe(true);
    await expect(isFavorite(partner.accessToken, theirs.id)).resolves.toBe(false);

    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    await expect.poll(() => isFavorite(admin.accessToken, own.id)).toBe(false);
    await expect.poll(() => isFavorite(admin.accessToken, copyId)).toBe(false);
    await expect(isFavorite(partner.accessToken, theirs.id)).resolves.toBe(false);
  });

  test('reports an item that went away after it was selected and changes the rest', async ({
    context,
    page,
    assetReady,
  }) => {
    const [kept, gone] = await Promise.all([
      utils.createAsset(admin.accessToken),
      utils.createAsset(admin.accessToken),
    ]);

    await utils.setAuthCookies(context, admin.accessToken);
    // No live events, so the stale item stays selected as it would on a slow or dropped connection.
    // The web client opens socket.io as a WebSocket only (transports: ['websocket']), which page.route never
    // sees; an unanswered routeWebSocket stub keeps the server's on_asset_delete from pruning the selection.
    await page.routeWebSocket('**/api/socket.io/**', () => {});
    await page.goto('/photos');
    await select(page, kept.id);
    await select(page, gone.id);

    await deleteAssets(
      { assetBulkDeleteDto: { ids: [gone.id], force: true } },
      { headers: asBearerAuth(admin.accessToken) },
    );

    // DELETE first marks the row; wait for physical removal without updating the browser's stale selection.
    // The asset API's missing-row access denial is 400, not a deletion-specific 404.
    const db = new Client({
      host: playwrightDbHost,
      port: 5435,
      user: 'postgres',
      password: 'postgres',
      database: 'frameleaf',
      connectionTimeoutMillis: 1000,
      statement_timeout: 1000,
      query_timeout: 1500,
      options: '-c default_transaction_read_only=on',
    });
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= db.end());
    assetReady.onCleanup(close);
    let connectionError: Error | undefined;
    db.on('error', (error) => {
      connectionError = error;
    });
    try {
      assetReady.signal.throwIfAborted();
      await db.connect();
      await expect
        .poll(async () => {
          assetReady.signal.throwIfAborted();
          if (connectionError) {
            throw connectionError;
          }
          const { rows } = await db.query<{ goneExists: boolean; keptExists: boolean }>(
            `SELECT
               EXISTS (SELECT 1 FROM asset WHERE id = $1 AND "ownerId" = $3) AS "goneExists",
               EXISTS (SELECT 1 FROM asset WHERE id = $2 AND "ownerId" = $3) AS "keptExists"`,
            [gone.id, kept.id, admin.userId],
          );
          return rows[0];
        })
        .toEqual({ goneExists: false, keptExists: true });
    } finally {
      await close();
    }

    const bar = page.getByRole('region', { name: 'Selected items' });
    await expect(bar.getByText('2 selected', { exact: true })).toBeVisible();
    await bar.getByRole('button', { name: 'Favorite', exact: true }).click();

    await expect(page.getByText('Favorite: 1 of 2 updated, 1 failed, 0 skipped')).toBeVisible();
    await expect.poll(() => isFavorite(admin.accessToken, kept.id)).toBe(true);
  });

  test('moves to the trash without asking and undoes it', async ({ context, page }) => {
    const asset = await utils.createAsset(admin.accessToken);

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/photos');
    await select(page, asset.id);

    // The trash is reversible, so it offers Undo rather than a confirmation; only a permanent delete asks.
    const bar = page.getByRole('region', { name: 'Selected items' });
    await bar.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(() => isTrashed(admin.accessToken, asset.id)).toBe(true);
    await expect(page.locator(`[data-asset-id="${asset.id}"]`)).toHaveCount(0);

    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    await expect.poll(() => isTrashed(admin.accessToken, asset.id)).toBe(false);
  });
});

/**
 * FL-32: "Select all n" against the real server. The server counts and freezes the owner's matching
 * Timeline set, a partner's source item is never changed by it, and its Undo survives a
 * reload. A filtered search's Select all never reaches what the filter left out.
 */
test.describe('Everything matching', () => {
  let admin: LoginResponseDto;
  let partner: LoginResponseDto;

  test.beforeEach(async () => {
    utils.initSdk();
    ({ admin, partner } = await setUpPartner());
  });

  test('archives the Timeline count the server took, leaves the partner’s source, and undoes it', async ({
    context,
    page,
    assetReady,
  }) => {
    test.setTimeout(90_000);
    const own = await Promise.all([1, 2, 3].map(() => utils.createAsset(admin.accessToken)));
    const theirs = await utils.createAsset(partner.accessToken);
    // FL-326: the partner's item is in this Timeline as the viewer's own copy, so the count takes it
    own.push({ ...theirs, id: await utils.waitForPartnerCopy(admin.userId, theirs.id) });
    // Finish ingestion before the archive records updateIds; Undo must still refuse genuinely newer writes.
    await utils.waitForAssetReady(admin.accessToken, theirs.id, {
      headers: asBearerAuth(partner.accessToken),
      signal: assetReady.signal,
    });
    for (const asset of own) {
      await utils.waitForAssetReady(admin.accessToken, asset.id, { signal: assetReady.signal });
    }

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/photos');
    await select(page, own[0].id);

    const bar = page.getByRole('region', { name: 'Selected items' });
    await bar.getByRole('button', { name: /^Select all \d+$/ }).click();
    await expect(bar.getByText('Everything matching this view')).toBeVisible();

    await moreAction(page, 'Archive');
    const confirm = page.getByRole('dialog');
    // Counted by the server for this account alone: the copy is, the partner's source is not.
    await expect(confirm.getByText(/Archive all 4 matching items in your Timeline\?/)).toBeVisible();
    await confirm.getByRole('button', { name: 'Archive', exact: true }).click();

    for (const asset of own) {
      await expect.poll(() => visibilityOf(admin.accessToken, asset.id), { timeout: 20_000 }).toBe('archive');
    }
    await expect(visibilityOf(partner.accessToken, theirs.id)).resolves.toBe('timeline');

    // The toast's Undo has gone by now; a reload offers the last archive's Undo once more.
    await page.reload();
    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    for (const asset of own) {
      await expect.poll(() => visibilityOf(admin.accessToken, asset.id), { timeout: 20_000 }).toBe('timeline');
    }
    await expect(visibilityOf(partner.accessToken, theirs.id)).resolves.toBe('timeline');
  });

  test('Select all on a filtered search archives its results and nothing it filtered out', async ({
    context,
    page,
  }) => {
    const favorites = await Promise.all([1, 2].map(() => utils.createAsset(admin.accessToken, { isFavorite: true })));
    const other = await utils.createAsset(admin.accessToken);

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/photos');
    await expect(page.locator(`[data-asset-id="${other.id}"]`)).toBeVisible();

    // Filter opens the search palette's filters; its results page carries the filtered query.
    await page.getByTestId('frameleaf-results-toolbar').getByRole('button', { name: 'Filter', exact: true }).click();
    const favoritesFilter = page.getByRole('combobox', { name: 'Favorites' });
    await favoritesFilter.click();
    await page.getByRole('option', { name: 'Yes', exact: true }).click({ force: true });
    await page.getByRole('button', { name: 'Show 2 results' }).click();
    await expect(page.locator(`[data-asset-id="${favorites[0].id}"]`)).toBeVisible();
    await expect(page.locator(`[data-asset-id="${other.id}"]`)).toHaveCount(0);

    await select(page, favorites[0].id);
    const bar = page.getByRole('region', { name: 'Selected items' });
    await bar.getByRole('button', { name: 'Select all 2' }).click();
    await expect(bar.getByText('2 selected')).toBeVisible();

    await moreAction(page, 'Archive');
    for (const asset of favorites) {
      await expect.poll(() => visibilityOf(admin.accessToken, asset.id), { timeout: 20_000 }).toBe('archive');
    }
    await expect(visibilityOf(admin.accessToken, other.id)).resolves.toBe('timeline');
  });
});
