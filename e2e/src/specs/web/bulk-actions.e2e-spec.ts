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

const select = async (page: Page, id: string) => {
  const tile = page.locator(`[data-asset-id="${id}"]`);
  await tile.hover();
  await tile.getByRole('checkbox').click();
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
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    partner = await utils.userSetup(admin.accessToken, {
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
