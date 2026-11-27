import { faker } from '@faker-js/faker';
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';

/**
 * FL-1806 (approved 2026-11-26): the rail has no Tools section; Explore shows People & pets and
 * Places & map; All shared sits under Albums; the footer reads Import, Library care, Trash,
 * Settings, Support. Settings lists preferences only, grouped You, Library, Server, and Import,
 * Library care and Trash open beside the library rail. Clients is always in the top bar.
 */

const json = (body: unknown) => (route: Route) => route.fulfill({ json: body });

const setupShellRoutes = async (context: BrowserContext) => {
  await context.route('**/api/albums/hierarchy*', json({ roots: [] }));
  await context.route('**/api/partners*', json([]));
  await context.route('**/api/media-operations*', json({ items: [], total: 0 }));
  await context.route('**/api/admin/cloud/backup', json({ activeRun: null, activeRestore: null }));
};

const rail = (page: Page) => page.getByRole('navigation', { name: 'Library navigation' });
/** The rail's own link, current or not; a page may link the same place too. */
const railLink = (page: Page, name: string) =>
  page.getByTestId('sidebar-parent').getByRole('link', { name, exact: true });

test.describe('Navigation and Settings regroup (FL-1806)', () => {
  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
    await setupShellRoutes(context);
  });

  test('the rail has no Tools section and the footer lists the places', async ({ page }) => {
    await page.goto('/user-settings?area=care');
    const nav = rail(page);

    await expect(nav.getByRole('link', { name: 'People & pets' })).toHaveAttribute('href', '/people');
    await expect(nav.getByRole('link', { name: 'Places & map' })).toHaveAttribute('href', '/places');
    await expect(nav.getByRole('link', { name: 'All shared' })).toHaveAttribute('href', '/sharing');
    await expect(nav.getByRole('button', { name: 'Tools' })).toHaveCount(0);
    for (const name of ['Pets', 'Map', 'Workflows', 'RAW support', 'Clients']) {
      await expect(nav.getByRole('link', { name, exact: true })).toHaveCount(0);
    }
    for (const name of ['Import', 'Library care', 'Trash', 'Settings']) {
      await expect(railLink(page, name)).toBeVisible();
    }
    await expect(railLink(page, 'Library care')).toHaveAttribute('aria-current', 'page');
  });

  test('Import, Library care and Trash open beside the rail, without the Settings list', async ({ page }) => {
    for (const [address, current] of [
      ['/user-settings?area=backup', 'Import'],
      ['/user-settings?area=care', 'Library care'],
      ['/user-settings?area=trash&section=contents', 'Trash'],
    ]) {
      await page.goto(address);
      await expect(rail(page)).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Settings navigation' })).toHaveCount(0);
      await expect(railLink(page, current)).toHaveAttribute('aria-current', 'page');
    }
  });

  test('Settings lists preferences only, grouped You, Library, Server', async ({ page }) => {
    await page.goto('/user-settings?area=preferences');
    const settings = page.getByRole('navigation', { name: 'Settings navigation' });

    await expect(settings).toBeVisible();
    await expect(settings.locator('.cc-nav-group > p')).toHaveText(['Settings', 'You', 'Library', 'Server']);
    for (const name of ['Import', 'Library care', 'Tools', 'Trash']) {
      await expect(settings.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    await expect(rail(page)).toHaveCount(0);
  });

  test('old addresses still land in the right place', async ({ page }) => {
    await page.goto('/trash');
    await expect(page).toHaveURL(/area=trash/);
    await expect(railLink(page, 'Trash')).toHaveAttribute('aria-current', 'page');

    await page.goto('/takeout');
    await expect(page).toHaveURL(/area=backup&section=takeout/);
    await expect(railLink(page, 'Import')).toHaveAttribute('aria-current', 'page');

    await page.goto('/workflows');
    await expect(page).toHaveURL(/area=utilities&section=workflows/);
    await expect(railLink(page, 'Library care')).toHaveAttribute('aria-current', 'page');
  });

  test('Clients is always in the top bar', async ({ page }) => {
    await page.goto('/user-settings?area=preferences');
    await expect(page.getByRole('link', { name: 'Clients', exact: true })).toHaveAttribute('href', '/photography');
  });
});
