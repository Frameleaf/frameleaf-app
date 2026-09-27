import { LoginResponseDto, createPartner, deleteAssets, setUserOnboarding, updatePartner } from '@immich/sdk';
import { expect, test, type Page } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

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
  await updatePartner(
    { id: partner.userId, partnerUpdateDto: { inTimeline: true } },
    { headers: asBearerAuth(admin.accessToken) },
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

  test('skips a partner’s item instead of inferring ownership, and undoes the favorite', async ({ context, page }) => {
    const own = await utils.createAsset(admin.accessToken);
    const theirs = await utils.createAsset(partner.accessToken);

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/photos');
    await select(page, own.id);
    await select(page, theirs.id);

    const bar = page.getByRole('region', { name: 'Selected items' });
    await bar.getByRole('button', { name: 'Favorite', exact: true }).click();

    await expect(page.getByText('Favorite: 1 of 2 updated, 0 failed, 1 skipped')).toBeVisible();
    await expect.poll(() => isFavorite(admin.accessToken, own.id)).toBe(true);
    await expect(isFavorite(partner.accessToken, theirs.id)).resolves.toBe(false);

    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    await expect.poll(() => isFavorite(admin.accessToken, own.id)).toBe(false);
  });

  test('reports an item that went away after it was selected and changes the rest', async ({ context, page }) => {
    const [kept, gone] = await Promise.all([
      utils.createAsset(admin.accessToken),
      utils.createAsset(admin.accessToken),
    ]);

    await utils.setAuthCookies(context, admin.accessToken);
    // No live events, so the stale item stays selected as it would on a slow or dropped connection.
    await page.route('**/api/socket.io/**', (route) => route.abort());
    await page.goto('/photos');
    await select(page, kept.id);
    await select(page, gone.id);

    await deleteAssets(
      { assetBulkDeleteDto: { ids: [gone.id], force: true } },
      { headers: asBearerAuth(admin.accessToken) },
    );

    const bar = page.getByRole('region', { name: 'Selected items' });
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
 * FL-32: "Select all n" against the real server. The set is frozen when it is chosen, a filter that
 * was active then bounds it, and a partner's item in the Timeline is never changed by it.
 */
test.describe('Everything matching', () => {
  let admin: LoginResponseDto;
  let partner: LoginResponseDto;

  test.beforeEach(async () => {
    utils.initSdk();
    ({ admin, partner } = await setUpPartner());
  });

  test('archives the Timeline count the server took, leaves the partner’s item, and undoes it', async ({
    context,
    page,
  }) => {
    const own = await Promise.all([1, 2, 3].map(() => utils.createAsset(admin.accessToken)));
    const theirs = await utils.createAsset(partner.accessToken);

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/photos');
    await select(page, own[0].id);

    const bar = page.getByRole('region', { name: 'Selected items' });
    await bar.getByRole('button', { name: /^Select all \d+$/ }).click();
    await expect(bar.getByText('Everything matching this view')).toBeVisible();

    await moreAction(page, 'Archive');
    const confirm = page.getByRole('dialog');
    // Counted by the server for this account alone: the partner's item is not part of it.
    await expect(confirm.getByText(/Archive all 3 matching items in your Timeline\?/)).toBeVisible();
    await confirm.getByRole('button', { name: 'Archive', exact: true }).click();

    for (const asset of own) {
      await expect.poll(() => visibilityOf(admin.accessToken, asset.id)).toBe('archive');
    }
    await expect(visibilityOf(partner.accessToken, theirs.id)).resolves.toBe('timeline');

    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    for (const asset of own) {
      await expect.poll(() => visibilityOf(admin.accessToken, asset.id)).toBe('timeline');
    }
  });

  test('a filter active when everything matching was chosen bounds what it archives', async ({ context, page }) => {
    const favorites = await Promise.all([1, 2].map(() => utils.createAsset(admin.accessToken, { isFavorite: true })));
    const other = await utils.createAsset(admin.accessToken);

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/photos');
    await expect(page.locator(`[data-asset-id="${other.id}"]`)).toBeVisible();

    const toolbar = page.getByTestId('frameleaf-results-toolbar');
    await toolbar.getByRole('button', { name: 'Filter', exact: true }).click();
    const filters = page.getByRole('complementary', { name: 'Library filters' });
    await filters.getByRole('combobox', { name: 'Favorites' }).click();
    await page.getByRole('option', { name: 'Yes', exact: true }).click();
    await expect(page.locator(`[data-asset-id="${other.id}"]`)).toHaveCount(0);

    await toolbar.getByRole('button', { name: 'More library actions' }).click();
    await page
      .getByRole('dialog', { name: 'Collection actions' })
      .getByRole('button', { name: 'Select all 2 matching items' })
      .click();
    await expect(
      page.getByRole('region', { name: 'Selected items' }).getByText('Everything matching this view'),
    ).toBeVisible();

    await moreAction(page, 'Archive');
    for (const asset of favorites) {
      await expect.poll(() => visibilityOf(admin.accessToken, asset.id)).toBe('archive');
    }
    await expect(visibilityOf(admin.accessToken, other.id)).resolves.toBe('timeline');
  });
});
