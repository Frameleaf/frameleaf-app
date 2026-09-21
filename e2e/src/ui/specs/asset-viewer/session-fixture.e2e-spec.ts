import { expect, test } from '@playwright/test';
import { assetViewerUtils } from '../timeline/utils';
import { setupAssetViewerFixture } from './utils';

test.describe('authenticated UI fixture privacy boundary', () => {
  const fixture = setupAssetViewerFixture(529);

  test('verifies a non-elevated mock session before displaying the viewer', async ({ page, context }) => {
    const statusResponse = page.waitForResponse('**/api/auth/status');
    await page.goto(`/photos/${fixture.primaryAsset.id}`);
    const verifiedStatus = await statusResponse;
    expect(await verifiedStatus.json()).toEqual({ isElevated: false, password: true, pinCode: false });
    await assetViewerUtils.waitForViewerLoad(page, fixture.primaryAsset);

    // Browser routes do not authenticate the API. The fixture contains no real
    // session token, so an un-intercepted request must still be unauthorized.
    const backendStatus = await context.request.get('/api/auth/status');
    expect(backendStatus.status()).toBe(401);
  });

  test('keeps the viewer concealed when session verification is unauthorized', async ({ page, context }) => {
    await context.route('**/api/auth/status', (route) =>
      route.fulfill({ status: 401, json: { message: 'Unauthorized' } }),
    );
    await page.goto(`/photos/${fixture.primaryAsset.id}`);
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(assetViewerUtils.locator(page)).toHaveCount(0);
  });

  test('redirects to login when the authentication cookie is absent', async ({ page, context }) => {
    await context.clearCookies();
    await context.route('**/api/users/me', (route) =>
      route.fulfill({ status: 401, json: { message: 'Unauthorized' } }),
    );
    await page.goto(`/photos/${fixture.primaryAsset.id}`);
    await expect(page).toHaveURL(/\/auth\/login/);
    await expect(assetViewerUtils.locator(page)).toHaveCount(0);
  });
});
