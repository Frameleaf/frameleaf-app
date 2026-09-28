import { faker } from '@faker-js/faker';
import { expect, test } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import { CloudMockState, setupCloudMockApiRoutes } from 'src/ui/mock-network/cloud-network.js';

/**
 * Settings → Frameleaf Cloud → Account & link (FL-155) against a mocked server: start linking,
 * the pending code with its QR code, approval (the next status read), unlink with its confirmation,
 * and the revoked state.
 */
const accountPage = '/user-settings?area=cloud&section=cloud-account';

test.describe.configure({ mode: 'parallel' });
test.describe('Frameleaf Cloud account & link', () => {
  let mock: CloudMockState;

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    mock = { state: 'unlinked', requests: [] };
    await setupCloudMockApiRoutes(context, mock);
  });

  test('starts linking, shows the code and QR code, and picks up the approval', async ({ page }) => {
    await page.goto(accountPage);
    await expect(page.getByText('Access your library from the Frameleaf mobile apps')).toBeVisible();

    await page.getByRole('button', { name: 'Link to Frameleaf' }).click();
    await expect(page.getByText('BCDF-GHJK')).toBeVisible();
    await expect(page.getByRole('img', { name: /Link this server/ })).toBeVisible();

    mock.state = 'linked';
    await expect(page.getByText('Linked to Frameleaf')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('owner@example.test')).toBeVisible();
    expect(mock.requests.some(({ method, path }) => method === 'GET' && path === 'admin/cloud/link')).toBe(true);
  });

  test('unlinks after the confirmation', async ({ page }) => {
    mock.state = 'linked';
    await page.goto(accountPage);
    await page.getByRole('button', { name: /Unlink…/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: /Unlink server/ })).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: /Unlink server/ }).click();
    await expect(page.getByText('This server is not linked')).toBeVisible();
    expect(mock.requests).toContainEqual(expect.objectContaining({ method: 'DELETE', path: 'admin/cloud/link' }));
  });

  test('shows why the link ended', async ({ page }) => {
    mock.state = 'revoked';
    await page.goto(accountPage);
    await expect(page.getByText('Frameleaf Cloud ended this link')).toBeVisible();
    await expect(page.getByText(/no longer recognises this server/)).toBeVisible();
  });
});
