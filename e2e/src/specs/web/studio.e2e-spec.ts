import { AssetMediaResponseDto, LoginResponseDto } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { utils } from 'src/utils.js';

/**
 * FL-88 (STU-201): the Studio route against a real server. The vendored engine is not part of
 * this build, so the route must mount its chrome, say plainly that the editor is unavailable and
 * name the missing workers, keep the header working (rename, Library, Activity) and leave cleanly.
 * Design: design/frameleaf/template/src/Studio.jsx:2584-2647 (September 24, 2026).
 */
test.describe('Studio', () => {
  let admin: LoginResponseDto;
  let asset: AssetMediaResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    asset = await utils.createAsset(admin.accessToken);
  });

  test.beforeEach(async ({ context }) => {
    await utils.setAuthCookies(context, admin.accessToken);
  });

  test('mounts the chrome and names what the deployment is missing', async ({ page }) => {
    await page.goto(`/studio?assets=${asset.id}`);
    const studio = page.getByRole('region', { name: 'Studio' });
    await expect(studio).toBeVisible();
    await expect(studio.getByText('Editing as', { exact: false })).toBeVisible();
    await expect(page.getByTestId('studio-state')).toHaveAttribute('data-phase', 'unavailable');
    // No render worker is admitted in the e2e stack, so the state lists what is missing.
    await expect(page.getByRole('list', { name: /missing/i })).toBeVisible();
    // The editor's mode switch needs the engine, so it is not offered.
    await expect(page.getByRole('radiogroup', { name: 'Editing mode' })).toHaveCount(0);
  });

  test('renames the draft from the header and goes back to the library', async ({ page }) => {
    await page.goto('/studio');
    const name = page.getByRole('textbox', { name: 'Project name' });
    await name.fill('Lake trip');
    await name.press('Enter');
    await expect(name).toHaveValue('Lake trip');

    // The header's back button (Studio.jsx:2793-2796); the top bar's "Search your library" also
    // contains "Library", so the click is scoped to Studio and matched exactly.
    await page
      .getByRole('region', { name: 'Studio' })
      .getByRole('button', { name: 'Library', exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/\/photos/);
  });

  test('disposes on sign-out and does not come back without a session', async ({ page, context }) => {
    await page.goto('/studio');
    await expect(page.getByRole('region', { name: 'Studio' })).toBeVisible();
    await context.clearCookies();
    await page.reload();
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});
