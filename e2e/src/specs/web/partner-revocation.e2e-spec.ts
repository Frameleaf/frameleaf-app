import { LoginResponseDto, createPartner, removePartner, setUserOnboarding, updatePartner } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { asBearerAuth, utils } from 'src/utils.js';

/**
 * FL-54: a partner who stops sharing is gone from every open page at once — their library page,
 * the viewer on one of their photos and the main timeline — without waiting for a reload.
 */
test.describe('Partner revocation', () => {
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
  });

  test('leaves the partner page and closes the viewer when the partner stops sharing', async ({ context, page }) => {
    const asset = await utils.createAsset(partner.accessToken);
    await createPartner(
      { partnerCreateDto: { sharedWithId: admin.userId } },
      { headers: asBearerAuth(partner.accessToken) },
    );

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto(`/partners/${partner.userId}/photos/${asset.id}`);
    await expect(page.locator('#immich-asset-viewer')).toBeVisible();

    await removePartner({ id: admin.userId }, { headers: asBearerAuth(partner.accessToken) });

    await page.waitForURL(/\/sharing(?:\?|$)/);
    await expect(page.locator('#immich-asset-viewer')).toHaveCount(0);
    await expect(page.getByText('Pat Partner stopped sharing their library with you.')).toBeVisible();
  });

  test('drops the partner’s photos from an open main timeline', async ({ context, page }) => {
    const asset = await utils.createAsset(partner.accessToken);
    await createPartner(
      { partnerCreateDto: { sharedWithId: admin.userId } },
      { headers: asBearerAuth(partner.accessToken) },
    );

    // The recipient shows the partner's photos in their own timeline.
    await updatePartner(
      { id: partner.userId, partnerUpdateDto: { inTimeline: true } },
      { headers: asBearerAuth(admin.accessToken) },
    );

    await utils.setAuthCookies(context, admin.accessToken);
    await page.goto('/photos');
    await expect(page.locator(`[data-asset-id="${asset.id}"]`)).toBeVisible();

    await removePartner({ id: admin.userId }, { headers: asBearerAuth(partner.accessToken) });

    await expect(page.locator(`[data-asset-id="${asset.id}"]`)).toHaveCount(0);
  });
});
